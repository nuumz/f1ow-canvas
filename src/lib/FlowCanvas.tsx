import React, {
    forwardRef,
    useEffect,
    useLayoutEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useCallback,
    useState,
} from 'react';
import { Stage, Layer, Line as KonvaLine, Group as KonvaGroup, Rect as KonvaRect, Path as KonvaPath, Image as KonvaImage } from 'react-konva';
import Konva from 'konva';

// ─── Konva global configuration ──────────────────────────────
// Disable runtime warnings — avoids console.warn + string-format overhead
// in hot paths (drawing, drag). Safe for a well-tested production app.
Konva.showWarnings = false;

import { useCanvasStore as _defaultCanvasStore } from '../store/useCanvasStore';
import { CanvasStoreProvider, useCanvasStoreInstance } from '../store/CanvasStoreContext';
import { useLinearEditStore } from '../store/useLinearEditStore';
import type {
    CanvasElement as CanvasElementType,
    Point,
    LineElement,
    ArrowElement,
    TextElement,
    RectangleElement,
    FreeDrawElement,
    ToolType,
    SnapTarget,
    Binding,
} from '../types';
import { generateId } from '../utils/id';
import { snapToGrid, getStrokeDash } from '../utils/geometry';
import { computeCurveControlPoint, CURVE_RATIO } from '../utils/curve';
import {
    recomputeBoundPoints,
    findConnectorsForElement,
    syncBoundElements,
    computeConnectorLabelPosition,
} from '../utils/connection';
import { MIN_ZOOM, MAX_ZOOM, DEFAULT_STYLE, TOOLS, GRID_SIZE } from '../constants';
import { animateViewport, zoomAtPoint } from '../utils/camera';
import { getToolHandler } from '../tools';
import type { ToolContext } from '../tools';

import CanvasElementComponent from '../components/Canvas/CanvasElement';
import SelectionTransformer from '../components/Canvas/SelectionTransformer';
import GridLayer from '../components/Canvas/GridLayer';
import SelectionBox from '../components/Canvas/SelectionBox';
import ConnectionPointsOverlay from '../components/Canvas/ConnectionPoints';
import LinearElementHandles from '../components/Canvas/LinearElementHandles';
import Toolbar from '../components/Toolbar/Toolbar';
import StylePanel from '../components/StylePanel/StylePanel';
import ContextMenu from '../components/ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import { setClipboard, getClipboard, hasClipboardContent } from '../utils/clipboard';
import { cloneAndRemapElements, gatherElementsForCopy } from '../utils/clone';
import { exportToSVG } from '../utils/export';
import { computeAlignGuides, computeMultiSelectAlignSnap } from '../utils/alignment';
import type { AlignGuide } from '../utils/alignment';
import { computeNextSelection } from '../utils/selection';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useViewportCulling } from '../hooks/useViewportCulling';
import { useSpatialIndex } from '../hooks/useSpatialIndex';
import { useEfficientZoom } from '../hooks/useEfficientZoom';
import { useProgressiveRender } from '../hooks/useProgressiveRender';
import { rafThrottle, toSet, type AABB } from '../utils/performance';
import { useWebGLHybrid } from '../webgl/useWebGLHybrid';
import type { ElementRasterFn } from '../webgl/textureAtlas';
import { useTileRenderer, diffElements } from '../rendering/useTileRenderer';
import type { TileDrawFn, TileSpatialQuery } from '../rendering/tileRenderer';
import { SpatialSoA } from '../utils/spatialSoA';
import { ElbowWorkerManager } from '../utils/elbowWorkerManager';
import { disposeExportWorkerManager } from '../utils/exportWorkerManager';
import { elementRegistry } from '../utils/elementRegistry';
import {
    fileToDataURL,
    loadImage,
    createImageElement,
    extractImageDataFromClipboard,
    resolveImageSource,
    getImageFilesFromDataTransfer,
} from '../utils/image';
import { blurTextEditingTarget, isTextEditingTarget } from '../utils/editable';
import { syncAfterDrag, computeBoundTextPosition, BOUND_TEXT_PADDING, CONTAINER_TYPES } from '../utils/dragSync';
import { orderBoundTextWithContainers } from '../utils/textBinding';

import type { FlowCanvasProps, FlowCanvasRef, ContextMenuContext } from './FlowCanvasProps';
import { DEFAULT_THEME, resolveRenderStrategy, DEFAULT_RENDERER_ELEMENT_THRESHOLD } from './FlowCanvasProps';
import { useCollaboration } from '../collaboration/useCollaboration';
import CursorOverlay from '../collaboration/CursorOverlay';
import { WorkerConfigContext, type WorkerConfigContextValue } from '../contexts/WorkerConfigContext';
import { AnnotationsOverlay } from '../components/Canvas/AnnotationsOverlay';
import { TextHtmlOverlay } from '../components/Canvas/TextHtmlOverlay';

// ─── Helpers ────────────────────────────────────────────────────

/** Shallow-compare two arrays by reference identity of each element. */
function arraysShallowEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * When this many (or more) elements are selected, multi-drag skips
 * per-frame store updates entirely.  Konva handles the visual drag
 * natively; React state syncs on dragEnd only.  This threshold
 * balances visual quality (bound connectors following during drag)
 * against performance (eliminating cascading O(n) recomputation).
 */
const MULTI_DRAG_STORE_SKIP_THRESHOLD = 10;

// Stable empty array — handed to the accelerated path on the default ('konva')
// strategy so its memos keep a constant identity and never do work.
const EMPTY_ELEMENTS: CanvasElementType[] = [];

// ─── Accelerated-renderer rasterisation (EXPERIMENTAL) ───────────
// The WebGL / tile engines turn an element into pixels. To keep fidelity high
// we REUSE Konva — build the element's Konva node and read it back via
// `node.toCanvas()` — instead of re-implementing a parallel 2D drawing path.
//
// Skipped on purpose:
//   • text  — every text element renders through the HTML overlay
//             (TextHtmlOverlay); its Konva node is intentionally transparent,
//             so text is already faithful on every path and rasterising it here
//             would only waste atlas / tile space.
//   • image — the decoded bitmap isn't available synchronously here.
// Both fall through to `null` and are simply not drawn on the accelerated layer.

/** Build a detached Konva node mirroring an element's static (clean) appearance. */
function buildRasterNode(el: CanvasElementType): Konva.Node | null {
    if (!el.isVisible) return null;
    const style = el.style;
    const dash = getStrokeDash(style.strokeStyle, style.strokeWidth);
    const base = {
        opacity: style.opacity ?? 1,
        listening: false,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: false,
    };
    switch (el.type) {
        case 'rectangle': {
            const r = el as RectangleElement;
            return new Konva.Rect({
                ...base,
                x: el.x, y: el.y, width: el.width, height: el.height, rotation: el.rotation,
                cornerRadius: r.cornerRadius,
                fill: style.fillColor, stroke: style.strokeColor, strokeWidth: style.strokeWidth, dash,
            });
        }
        case 'ellipse':
            return new Konva.Ellipse({
                ...base,
                x: el.x + el.width / 2, y: el.y + el.height / 2,
                radiusX: el.width / 2, radiusY: el.height / 2, rotation: el.rotation,
                fill: style.fillColor, stroke: style.strokeColor, strokeWidth: style.strokeWidth, dash,
            });
        case 'diamond': {
            const w = el.width, h = el.height;
            return new Konva.Line({
                ...base,
                x: el.x, y: el.y, rotation: el.rotation, closed: true,
                points: [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2],
                fill: style.fillColor, stroke: style.strokeColor, strokeWidth: style.strokeWidth,
                dash, lineJoin: 'round',
            });
        }
        case 'line': {
            const l = el as LineElement;
            // Curved connectors use a quadratic bézier — reuse the same control
            // point the live shape computes so the rasterised curve matches.
            if (l.lineType === 'curved' && l.points.length >= 4) {
                const sx = l.points[0], sy = l.points[1];
                const ex = l.points[l.points.length - 2], ey = l.points[l.points.length - 1];
                const cp = computeCurveControlPoint({ x: sx, y: sy }, { x: ex, y: ey }, l.curvature ?? CURVE_RATIO);
                return new Konva.Shape({
                    ...base,
                    x: el.x, y: el.y, rotation: el.rotation,
                    stroke: style.strokeColor, strokeWidth: style.strokeWidth, dash,
                    lineCap: 'round', lineJoin: 'round',
                    sceneFunc: (ctx: Konva.Context, shape: Konva.Shape) => {
                        ctx.beginPath();
                        ctx.moveTo(sx, sy);
                        ctx.quadraticCurveTo(cp.x, cp.y, ex, ey);
                        ctx.strokeShape(shape);
                    },
                });
            }
            // Straight & elbow connectors render their stored points directly.
            return new Konva.Line({
                ...base,
                x: el.x, y: el.y, rotation: el.rotation, points: l.points,
                stroke: style.strokeColor, strokeWidth: style.strokeWidth, dash,
                lineCap: 'round', lineJoin: 'round',
            });
        }
        case 'arrow': {
            const a = el as ArrowElement;
            return new Konva.Arrow({
                ...base,
                x: el.x, y: el.y, rotation: el.rotation, points: a.points,
                stroke: style.strokeColor, fill: style.strokeColor, strokeWidth: style.strokeWidth, dash,
                lineCap: 'round', lineJoin: 'round',
            });
        }
        case 'freedraw': {
            const f = el as FreeDrawElement;
            return new Konva.Line({
                ...base,
                x: el.x, y: el.y, rotation: el.rotation, points: f.points,
                stroke: style.strokeColor, strokeWidth: style.strokeWidth,
                lineCap: 'round', lineJoin: 'round', tension: 0.5,
            });
        }
        default:
            return null; // text → HTML overlay, image → no sync bitmap
    }
}

/**
 * Draw a detached Konva node into a 2D context by reading it back via
 * `toCanvas()`. `offsetX/Y` shift the node's world position to the context's
 * local origin: `0` for tiles (the context is already world-space) or the
 * element's own `x/y` for the atlas (each element fills its own local slot).
 * The context's current scale is read so the readback is rasterised at the
 * right pixel density (crisp, not resampled).
 */
function drawRasterNode(
    ctx: OffscreenCanvasRenderingContext2D,
    node: Konva.Node,
    offsetX: number,
    offsetY: number,
): void {
    const rect = node.getClientRect({ skipShadow: true });
    if (rect.width <= 0 || rect.height <= 0) return;
    const m = ctx.getTransform();
    const pixelRatio = Math.max(Math.abs(m.a), Math.abs(m.d)) || 1;
    const canvas = node.toCanvas({
        x: rect.x, y: rect.y, width: rect.width, height: rect.height, pixelRatio,
    });
    ctx.drawImage(canvas, rect.x - offsetX, rect.y - offsetY, rect.width, rect.height);
}

/** WebGL atlas rasteriser — one element per slot, drawn at the slot's origin. */
const konvaElementRasterFn: ElementRasterFn = (ctx, el) => {
    const node = buildRasterNode(el);
    if (node) drawRasterNode(ctx, node, el.x, el.y);
};

/** Tile rasteriser — many elements drawn into a world-space tile context. */
const konvaTileDrawFn: TileDrawFn = (ctx, elements) => {
    for (const el of elements) {
        const node = buildRasterNode(el);
        if (node) drawRasterNode(ctx, node, 0, 0);
    }
};

// ─── Memoized Static Layer ───────────────────────────────────
// Following Konva's recommended pattern for 20K nodes:
// wrap <Layer> + children in a React.memo'd component so the entire
// subtree is skipped when props haven't meaningfully changed.  This
// turns the per-frame cost from O(n) prop-checks to O(1) memo-check
// when unrelated state changes occur (context menu, selection box,
// alignment guides, etc.).

interface StaticLayerProps {
    elements: CanvasElementType[];
    listening: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<CanvasElementType>) => void;
    onDragMove: (id: string, updates: Partial<CanvasElementType>) => void;
    onDoubleClick: (id: string) => void;
    autoEditTextId: string | null;
    onTextEditStart: (id: string) => void;
    onTextEditEnd: (id: string, isEmpty: boolean) => void;
    allElements: CanvasElementType[];
    gridSnap: number | undefined;
    onDragSnap: ((id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null) | undefined;
    viewportScale: number;
    /** Callback when a KonvaGroup drag ends — receives groupId and delta */
    onGroupDragEnd?: (groupId: string, dx: number, dy: number) => void;
}

const StaticElementsLayer: React.FC<StaticLayerProps> = ({
    elements, listening, onSelect, onChange, onDragMove, onDoubleClick,
    autoEditTextId, onTextEditStart, onTextEditEnd, allElements,
    gridSnap, onDragSnap, viewportScale, onGroupDragEnd,
}) => {
    const layerRef = useRef<Konva.Layer>(null);

    // ─── Layer bitmap caching ─────────────────────────────
    // After react-konva finishes drawing children, cache the entire
    // static layer as a single bitmap.  Subsequent layer.draw() calls
    // become a single drawImage() — reducing draw cost from O(N) to O(1).
    // Cache is invalidated (cleared + recreated) whenever elements,
    // viewportScale or autoEditTextId change.
    //
    // CRITICAL: useLayoutEffect instead of useEffect.
    // useEffect runs AFTER the browser paints → the stale bitmap from
    // the previous element set is visible for 1 frame → flicker.
    // useLayoutEffect runs synchronously before paint, so clearCache()
    // takes effect immediately and the browser never shows the stale bitmap.
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;

        // Clear stale bitmap immediately (synchronous, before paint).
        // Without this, the previous cached bitmap would show elements
        // that no longer belong to this layer (e.g. an element that just
        // moved to the interactive layer on select/deselect).
        layer.clearCache();

        if (elements.length === 0) return;

        // Re-cache on next frame for performance.
        const dpr = window.devicePixelRatio || 1;
        const cachePixelRatio = dpr * Math.max(1, viewportScale);

        const rafId = requestAnimationFrame(() => {
            if (!layerRef.current) return;

            const rect = layer.getClientRect({ skipTransform: true });
            const MAX_CACHE_DIM = 8192;
            const bitmapW = rect.width  * cachePixelRatio;
            const bitmapH = rect.height * cachePixelRatio;

            if (bitmapW > MAX_CACHE_DIM || bitmapH > MAX_CACHE_DIM || rect.width <= 0 || rect.height <= 0) {
                layer.clearCache();
                layer.batchDraw();
                return;
            }

            layer.cache({ pixelRatio: cachePixelRatio });
            layer.batchDraw();
        });

        return () => {
            cancelAnimationFrame(rafId);
        };
    }, [elements, viewportScale, autoEditTextId]);

    // ─── Group partition ──────────────────────────────────
    // Partition static elements into ungrouped (rendered directly)
    // and grouped (wrapped in <KonvaGroup draggable> for unified drag).
    const { ungrouped, groups } = useMemo(() => {
        const ung: CanvasElementType[] = [];
        const grps = new Map<string, CanvasElementType[]>();
        for (const el of elements) {
            if (el.groupIds?.length) {
                const gid = el.groupIds[el.groupIds.length - 1]; // outermost group
                if (!grps.has(gid)) grps.set(gid, []);
                grps.get(gid)!.push(el);
            } else {
                ung.push(el);
            }
        }
        return { ungrouped: ung, groups: grps };
    }, [elements]);

    // Clear layer cache when a group drag starts so Konva redraws
    // children with the moving group's transform applied.
    const handleGroupDragStart = useCallback((_e: Konva.KonvaEventObject<DragEvent>) => {
        layerRef.current?.clearCache();
    }, []);

    return (
        <Layer ref={layerRef} listening={listening}>
            {/* Ungrouped elements — render directly (as before) */}
            {ungrouped.map((el) => (
                <CanvasElementComponent
                    key={el.id}
                    element={el}
                    isSelected={false}
                    onSelect={onSelect}
                    onChange={onChange}
                    onDragMove={onDragMove}
                    onDoubleClick={onDoubleClick}
                    autoEditText={autoEditTextId === el.id}
                    onTextEditStart={onTextEditStart}
                    onTextEditEnd={onTextEditEnd}
                    allElements={allElements}
                    gridSnap={gridSnap}
                    onDragSnap={onDragSnap}
                    viewportScale={viewportScale}
                />
            ))}

            {/* Grouped elements — wrapped in <KonvaGroup> for unified drag */}
            {Array.from(groups.entries()).map(([groupId, groupEls]) => {
                const anyLocked = groupEls.some(el => el.isLocked);
                return (
                    <KonvaGroup
                        key={groupId}
                        draggable={!anyLocked}
                        onDragStart={handleGroupDragStart}
                        onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => {
                            const dx = e.target.x();
                            const dy = e.target.y();
                            // Reset group position to identity (children keep absolute coords)
                            e.target.x(0);
                            e.target.y(0);
                            onGroupDragEnd?.(groupId, dx, dy);
                        }}
                    >
                        {groupEls.map((el) => (
                            <CanvasElementComponent
                                key={el.id}
                                element={el}
                                isSelected={false}
                                isGrouped={true}
                                onSelect={onSelect}
                                onChange={onChange}
                                onDragMove={onDragMove}
                                onDoubleClick={onDoubleClick}
                                autoEditText={autoEditTextId === el.id}
                                onTextEditStart={onTextEditStart}
                                onTextEditEnd={onTextEditEnd}
                                allElements={allElements}
                                gridSnap={gridSnap}
                                onDragSnap={onDragSnap}
                                viewportScale={viewportScale}
                            />
                        ))}
                    </KonvaGroup>
                );
            })}
        </Layer>
    );
};

// Custom comparator: skip allElements (handled by individual element memo)
// and callbacks (stabilised via useCallback with minimal deps).
// Only re-render when the element list, listening state, or rendering
// params actually change.
const MemoizedStaticLayer = React.memo(StaticElementsLayer, (prev, next) => {
    if (prev.elements !== next.elements) return false;
    if (prev.listening !== next.listening) return false;
    if (prev.autoEditTextId !== next.autoEditTextId) return false;
    if (prev.gridSnap !== next.gridSnap) return false;
    if (prev.viewportScale !== next.viewportScale) return false;
    return true;
});

// ─── Lock Badge Indicator ──────────────────────────────────────
const LockBadge: React.FC<{ element: CanvasElementType; scale: number }> = ({ element, scale }) => {
    const badgeSize = 20 / scale; // keep constant size on screen
    const iconScale = badgeSize / 24; // SVG viewBox is 24x24
    return (
        <KonvaGroup
            x={element.x - badgeSize / 2}
            y={element.y - badgeSize / 2}
            listening={false}
        >
            <KonvaRect
                width={badgeSize}
                height={badgeSize}
                fill="#ff9500"
                cornerRadius={badgeSize / 4}
                opacity={0.9}
            />
            <KonvaPath
                x={badgeSize * 0.12}
                y={badgeSize * 0.08}
                data="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"
                fill="white"
                scaleX={iconScale * 0.78}
                scaleY={iconScale * 0.78}
                listening={false}
            />
        </KonvaGroup>
    );
};

// ─── Main FlowCanvas Component ───────────────────────────────
const FlowCanvas = forwardRef<FlowCanvasRef, FlowCanvasProps>((props, ref) => {
    const {
        initialElements,
        elements: controlledElements,
        onChange,
        onSelectionChange,
        onElementCreate,
        onElementDelete,
        onElementDoubleClick,
        width = '100%',
        height = '100%',
        tools,
        defaultStyle,
        showToolbar = true,
        toolbarPosition = 'bottom',
        defaultTool,
        showStylePanel: showStylePanelProp = true,
        showStatusBar = true,
        showGrid: showGridProp = false,
        enableShortcuts = true,
        theme: themeProp,
        readOnly = false,
        className,
        contextMenuItems: contextMenuItemsProp,
        renderContextMenu,
        renderAnnotation,
        collaboration: collaborationConfig,
        workerConfig,
        customElementTypes,
        connectionConfig,
        store: storeProp,
        renderer,
        rendererOptions,
    } = props;

    const snapThreshold = connectionConfig?.snapThreshold ?? 24;
    const hysteresisMargin = connectionConfig?.hysteresisMargin ?? 6;

    // ─── Store instance (multi-instance support) ─────────────
    // When a `store` prop is supplied via `createCanvasStore()`, this
    // FlowCanvas reads/writes through that isolated instance and provides
    // it to descendant React subscribers via context. Without the prop,
    // we fall back to the module-level singleton so existing single-
    // instance apps work unchanged.
    const useCanvasStore = storeProp ?? _defaultCanvasStore;

    // Memoize so a stable object identity is passed to memoized children
    // (a fresh spread every render would defeat their React.memo).
    const theme = useMemo(() => ({ ...DEFAULT_THEME, ...themeProp }), [themeProp]);

    // ─── Worker Configuration ─────────────────────────────────
    const workerConfigValue = useMemo(() => ({
        elbowWorkerConfig: workerConfig?.disabled
            ? { disabled: true }
            : workerConfig?.elbowWorkerUrl
                ? { url: workerConfig.elbowWorkerUrl }
                : undefined,
        exportWorkerConfig: workerConfig?.disabled
            ? { disabled: true }
            : workerConfig?.exportWorkerUrl
                ? { url: workerConfig.exportWorkerUrl }
                : undefined,
    }), [workerConfig]);

    // ─── Per-instance elbow worker manager ────────────────────
    // Each FlowCanvas owns ONE ElbowWorkerManager so connector routing only
    // considers THIS canvas's obstacles, and unmounting one canvas never tears
    // down another's worker. Constructed lazily during render (cheap — the
    // actual Worker spins up on first route); recreated only if a StrictMode
    // simulated unmount disposed it or the worker config changed. Disposed in
    // the unmount cleanup below.
    const elbowWorkerConfig = workerConfigValue.elbowWorkerConfig;
    const elbowManagerRef = useRef<ElbowWorkerManager | null>(null);
    const elbowManagerDisposedRef = useRef(false);
    const elbowConfigKeyRef = useRef<string | null>(null);
    const elbowConfigKey = JSON.stringify(elbowWorkerConfig ?? null);
    if (
        !elbowManagerRef.current ||
        elbowManagerDisposedRef.current ||
        elbowConfigKeyRef.current !== elbowConfigKey
    ) {
        elbowManagerRef.current?.dispose();
        elbowManagerRef.current = new ElbowWorkerManager(elbowWorkerConfig);
        elbowManagerDisposedRef.current = false;
        elbowConfigKeyRef.current = elbowConfigKey;
    }
    const elbowWorkerManager = elbowManagerRef.current;

    // Provider value carrying this instance's elbow manager to descendant
    // shapes' `useElbowWorker` hooks. Stable identity unless config changes.
    const workerConfigProviderValue = useMemo<WorkerConfigContextValue>(
        () => ({ ...workerConfigValue, elbowWorkerManager }),
        [workerConfigValue, elbowWorkerManager],
    );

    // ─── Store ────────────────────────────────────────────────
    const store = useCanvasStore();
    const {
        elements,
        selectedIds,
        activeTool,
        currentStyle,
        viewport,
        showGrid,
        isDrawing,
        setIsDrawing,
        setDrawStart,
        drawStart,
        addElement,
        updateElement,
        setSelectedIds,
        clearSelection,
        setActiveTool,
        commitTool,
        setViewport,
        deleteElements,
        pushHistory,
        setElements,
        setCurrentStyle,
        undo,
        redo,
        toggleGrid,
    } = store;

    // ─── Performance: O(1) selected ID lookup ─────────────────
    const selectedIdsSet = useMemo(() => toSet(selectedIds), [selectedIds]);

    // ─── Collaboration (CRDT / Yjs) ──────────────────────────
    // Pass the RESOLVED per-instance store so the op-CRDT sync + awareness
    // mirror THIS canvas, never the module-level singleton, when a `store`
    // prop is supplied. Falls back to the singleton automatically otherwise.
    const { peers, updateCursor: collabUpdateCursor } = useCollaboration(collaborationConfig ?? null, useCanvasStore);

    const stageRef = useRef<Konva.Stage>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const currentElementIdRef = useRef<string | null>(null);

    // ─── Linear Edit Store ────────────────────────────────────
    const linearEdit = useLinearEditStore();
    const isLinearEditing = linearEdit.isEditing;

    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
    const [selectionBox, setSelectionBox] = useState<{
        x: number; y: number; width: number; height: number;
    } | null>(null);

    // ─── Connection / Snap state ──────────────────────────────
    const [snapTarget, setSnapTarget] = useState<SnapTarget | null>(null);
    const startBindingRef = useRef<Binding | null>(null);

    // ─── Text editing state ───────────────────────────────────
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [autoEditTextId, setAutoEditTextId] = useState<string | null>(null);

    // ─── Active drawing tracking ──────────────────────────────
    // Tracks the element being actively drawn (freedraw, shapes, etc.).
    // Moving this element to the interactive layer during drawing means the
    // static layer stays completely unchanged → no React re-render, no bitmap
    // cache rebuild — eliminating the O(n²) lag during long strokes.
    const [drawingElementId, setDrawingElementId] = useState<string | null>(null);

    // ─── Context menu state ───────────────────────────────────
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    // ─── Alignment guides state ───────────────────────────────
    const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);

    // Modifier key tracking (Shift: constrain draw / additive select;
    // Cmd/Ctrl: additive select)
    const shiftKeyRef = useRef(false);
    const metaKeyRef = useRef(false);

    // Right-click tracking — Konva fires `click` for right-click too
    // (unlike DOM click which is left-button only). We need to suppress
    // handleElementSelect during right-click so it doesn't destroy
    // multi-selection before the context menu opens.
    const isRightClickRef = useRef(false);

    // Cross-layer double-click tracking.
    // When an unselected shape is clicked, React moves it from the Static
    // Layer to the Interactive Layer — destroying the Konva node.  The
    // second click lands on a *new* node, so Konva's built-in dblclick
    // never fires.  We track the last click (element id + timestamp)
    // manually so handleElementSelect can detect this scenario and
    // forward it to handleElementDoubleClick.
    const lastClickRef = useRef<{ id: string; time: number } | null>(null);
    const dblClickHandlerRef = useRef<((id: string) => void) | null>(null);

    // Space key tracking (hold Space + drag to pan)
    const [isSpacePanning, setIsSpacePanning] = useState(false);
    const spaceKeyRef = useRef(false);

    // Bound connectors derive their visual points from current shape
    // positions — same pattern as Konva Connected Objects example.
    // No manual recomputation loop needed during drag.
    //
    // Skip recomputation for the connector whose endpoint is being
    // actively dragged in linear-edit mode.  Otherwise recomputeBoundPoints
    // would snap the visual arrow back to the old binding position while
    // the drag handle follows the pointer — causing a visible mismatch.
    const { isDraggingPoint: isLinearDragging, elementId: linearEditId } = linearEdit;

    // ─── Resolved elements: recompute bound connector points ──
    // Performance-critical: uses LAZY allocation.  Only creates a new
    // array when a bound connector's points actually change.  When all
    // connectors are unbound or unchanged (common during shape-only
    // drag), returns the `elements` array reference directly — O(0)
    // allocation cost.  This prevents downstream cascades through
    // useSpatialIndex → partition → layer re-render.
    const prevResolvedRef = useRef<CanvasElementType[]>([]);
    const resolvedElements = useMemo(() => {
        let result: CanvasElementType[] | null = null; // lazy — only allocate when needed

        // Track connectors whose points changed → need to sync their bound text labels
        const changedConnectorIds = new Set<string>();

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.type !== 'line' && el.type !== 'arrow') {
                if (result) result[i] = el;
                continue;
            }
            const conn = el as LineElement | ArrowElement;
            if (!conn.startBinding && !conn.endBinding) {
                // Even unbound connectors need label position sync when
                // the connector is being dragged (x/y changes).
                if (conn.boundElements?.some(be => be.type === 'text')) {
                    changedConnectorIds.add(conn.id);
                    if (!result) result = elements.slice(0, i);
                }
                if (result) result[i] = el;
                continue;
            }
            // Skip: connector being point-dragged — let the drag control its position
            // But still sync bound text labels so they follow during drag.
            if (isLinearDragging && linearEditId === el.id) {
                if (conn.boundElements?.some(be => be.type === 'text')) {
                    if (!result) result = elements.slice(0, i);
                    changedConnectorIds.add(conn.id);
                }
                if (result) result[i] = el;
                continue;
            }
            const recomputed = recomputeBoundPoints(conn, elements);
            if (recomputed) {
                if (!result) {
                    // First change: lazy-copy all elements seen so far
                    result = elements.slice(0, i);
                }
                result[i] = { ...conn, ...recomputed } as CanvasElementType;
                changedConnectorIds.add(conn.id);
            } else {
                if (result) result[i] = el;
            }
        }

        // ─── Sync bound text labels for connectors whose points changed ──
        // Without this, connector labels stay at their old stored position
        // because the memo comparator skips allElements changes.
        if (changedConnectorIds.size > 0 && result) {
            // Build O(1) lookup from the patched result array
            const patchMap = new Map<string, CanvasElementType>();
            const indexMap = new Map<string, number>();
            for (let i = 0; i < result.length; i++) {
                const el = result[i];
                patchMap.set(el.id, el);
                indexMap.set(el.id, i);
            }

            for (const connId of changedConnectorIds) {
                const conn = patchMap.get(connId) as (LineElement | ArrowElement) | undefined;
                if (!conn?.boundElements) continue;
                for (const be of conn.boundElements) {
                    if (be.type !== 'text') continue;
                    const txtIdx = indexMap.get(be.id);
                    if (txtIdx === undefined) continue;
                    const txt = result[txtIdx] as TextElement;
                    const textW = Math.max(10, txt.width || 60);
                    const textH = txt.height || 30;
                    const pos = computeConnectorLabelPosition(conn, textW, textH);
                    // Only clone if position actually changed
                    if (Math.abs(txt.x - pos.x) > 0.01 || Math.abs(txt.y - pos.y) > 0.01) {
                        result[txtIdx] = { ...txt, x: pos.x, y: pos.y } as CanvasElementType;
                    }
                }
            }
        }

        const finalResult = result ?? elements;

        // Reference stabilisation: when content is identical to previous
        // render, reuse old array to prevent downstream memo invalidation.
        const prev = prevResolvedRef.current;
        if (finalResult.length === prev.length) {
            let same = true;
            for (let i = 0; i < finalResult.length; i++) {
                if (finalResult[i] !== prev[i]) { same = false; break; }
            }
            if (same) return prev;
        }
        prevResolvedRef.current = finalResult;
        return finalResult;
    }, [elements, isLinearDragging, linearEditId]);

    // ─── O(1) element lookup Map ─────────────────────────────
    // Built once per resolvedElements change.  Used in render section
    // (transformableIds filter, linear edit lookup) and event handlers
    // to avoid O(n) .find() calls.
    const resolvedElementMap = useMemo(() => {
        const map = new Map<string, CanvasElementType>();
        for (const el of resolvedElements) map.set(el.id, el);
        return map;
    }, [resolvedElements]);

    const linearEditElement = useMemo(() => {
        if (!linearEdit.elementId) return undefined;
        const el = resolvedElementMap.get(linearEdit.elementId);
        if (!el || (el.type !== 'line' && el.type !== 'arrow')) return undefined;
        return el as LineElement | ArrowElement;
    }, [linearEdit.elementId, resolvedElementMap]);

    const showCenterSnapIndicator = !(
        isLinearDragging &&
        linearEditElement?.lineType === 'elbow'
    );

    // Ref keeps the latest resolved map accessible from stable callbacks
    // (e.g. handleElementDoubleClick) without adding it to their deps.
    const resolvedMapRef = useRef(resolvedElementMap);
    resolvedMapRef.current = resolvedElementMap;

    // ─── Performance: viewport culling for large flows ────────
    // Only render elements visible in the current viewport.
    // Selected elements are always included for transformer handles.
    // Uses R-tree spatial index for O(log n) queries on large canvases
    // (>200 elements), falls back to linear scan for small ones.
    const visibleElements = useSpatialIndex(
        resolvedElements,
        viewport,
        dimensions.width,
        dimensions.height,
        selectedIds,
    );

    // ─── Render order: bound text follows its container ──────
    // Ensures shape labels share their container's z-index, so other
    // shapes stacked above the container correctly occlude the label.
    const orderedVisibleElements = useMemo(
        () => orderBoundTextWithContainers(visibleElements),
        [visibleElements],
    );

    // ─── Performance: efficient (discretized) zoom for LOD ────
    // Snaps to power-of-2 steps so LOD decisions and stroke scaling
    // don't flicker during smooth zoom gestures.
    const efficientZoom = useEfficientZoom(viewport.scale);

    // ─── Performance: multi-layer element partition ───────────
    // Split visible elements into two sets so Konva renders them on
    // separate <canvas> elements.  When the user drags a selected
    // shape, only the Interactive Layer redraws — the Static Layer
    // stays cached as a bitmap.
    //
    // Reference stabilisation: during drag of a selected (interactive)
    // element, the static partition content doesn't change — only the
    // array reference does.  By shallow-comparing element references
    // against the previous result, we preserve the old array identity.
    // This lets MemoizedStaticLayer skip re-rendering entirely (O(1)
    // instead of O(n) per drag frame).
    const prevStaticRef = useRef<CanvasElementType[]>([]);
    const prevInteractiveRef = useRef<CanvasElementType[]>([]);

    const { staticElements, interactiveElements } = useMemo(() => {
        // Expand selection: if ANY member of a group is selected, move
        // ALL members to the interactive layer.  This prevents a group
        // from being split across layers.
        // Also treat the actively-drawing element as "interactive" so it
        // renders on the interactive layer and doesn't destabilise the static
        // layer's bitmap cache during mouse move.
        let effectiveSelected = drawingElementId
            ? new Set([...selectedIdsSet, drawingElementId])
            : selectedIdsSet;
        if (effectiveSelected.size > 0) {
            const expanded = new Set(effectiveSelected);
            for (const el of visibleElements) {
                if (expanded.has(el.id) && el.groupIds?.length) {
                    const outermostGid = el.groupIds[el.groupIds.length - 1];
                    for (const other of visibleElements) {
                        if (other.groupIds?.includes(outermostGid)) {
                            expanded.add(other.id);
                        }
                    }
                }
            }

            // ── Expand bound text: keep parent + text on the same layer ──
            // When ANY element with bound text is selected (connector or shape),
            // promote its bound text labels to the interactive layer.  Without
            // this, the parent moves to interactive while its label stays on
            // static — causing visual desync during drag.
            for (const el of visibleElements) {
                if (!expanded.has(el.id)) continue;
                // Promote bound text for ALL element types (connectors AND shapes)
                if (el.boundElements) {
                    for (const be of el.boundElements) {
                        if (be.type === 'text') expanded.add(be.id);
                    }
                }
                // Reverse: bound text selected → promote its container (any type)
                if (el.type === 'text' && (el as TextElement).containerId) {
                    expanded.add((el as TextElement).containerId!);
                }
            }

            // ── Expand bound connectors: promote connectors bound to selected shapes ──
            // When a shape is selected and being dragged, any connector (arrow/line)
            // bound to it must move to the interactive layer as well. Otherwise the
            // connector stays on the bitmap-cached static layer and lags behind /
            // flickers because the static bitmap must clear-cache + re-render each frame.
            for (const el of visibleElements) {
                if (el.type !== 'line' && el.type !== 'arrow') continue;
                if (expanded.has(el.id)) continue; // already promoted
                const conn = el as LineElement | ArrowElement;
                const startBound = conn.startBinding?.elementId;
                const endBound = conn.endBinding?.elementId;
                if ((startBound && expanded.has(startBound)) || (endBound && expanded.has(endBound))) {
                    expanded.add(el.id);
                    // Also promote bound text labels on this connector
                    if (el.boundElements) {
                        for (const be of el.boundElements) {
                            if (be.type === 'text') expanded.add(be.id);
                        }
                    }
                }
            }

            if (expanded.size !== effectiveSelected.size) {
                effectiveSelected = expanded;
            }
        }

        const statics: CanvasElementType[] = [];
        const interactive: CanvasElementType[] = [];
        for (const el of orderedVisibleElements) {
            if (effectiveSelected.has(el.id)) {
                interactive.push(el);
            } else {
                statics.push(el);
            }
        }

        // Preserve reference identity when content hasn't changed
        const stableStatics = arraysShallowEqual(statics, prevStaticRef.current)
            ? prevStaticRef.current : statics;
        const stableInteractive = arraysShallowEqual(interactive, prevInteractiveRef.current)
            ? prevInteractiveRef.current : interactive;

        prevStaticRef.current = stableStatics;
        prevInteractiveRef.current = stableInteractive;

        return { staticElements: stableStatics, interactiveElements: stableInteractive };
    }, [visibleElements, orderedVisibleElements, selectedIdsSet, drawingElementId]);

    // ─── Performance: progressive rendering for static layer ──
    // When the static layer has a large number of elements, render
    // them in batches across multiple frames to keep the UI responsive.
    // Interactive elements always render immediately (full interactivity).
    const { visibleElements: progressiveStaticElements } = useProgressiveRender(
        staticElements,
        { batchSize: 500, threshold: 500, enabled: true },
    );

    // ─── Accelerated renderers (EXPERIMENTAL, opt-in via `renderer`) ──────
    // Strictly additive: when `renderer` is 'konva' (the default) every branch
    // below is inert — the hooks run disabled and the existing Konva static
    // layer renders unchanged (HARD RULE 1).
    const rendererStrategy = renderer ?? 'konva';
    const rendererElementThreshold = rendererOptions?.elementThreshold ?? DEFAULT_RENDERER_ELEMENT_THRESHOLD;

    // The static set the accelerated layer draws: every element NOT on the
    // Konva interactive / drawing layer. Selected, group-expanded, bound, and
    // in-progress elements stay on Konva (HARD RULE 2). Un-culled on purpose so
    // each engine applies its own viewport/GPU culling over the full set.
    const acceleratedStaticElements = useMemo(() => {
        if (rendererStrategy === 'konva') return EMPTY_ELEMENTS;
        const interactiveIds = new Set<string>();
        for (const el of interactiveElements) interactiveIds.add(el.id);
        if (drawingElementId) interactiveIds.add(drawingElementId);
        const out: CanvasElementType[] = [];
        for (const el of resolvedElements) {
            if (!interactiveIds.has(el.id)) out.push(el);
        }
        return out;
    }, [rendererStrategy, resolvedElements, interactiveElements, drawingElementId]);

    // ── Tile spatial-index bridge ────────────────────────────
    // The tile engine wants O(log n) per-tile lookups. useSpatialIndex's SoA is
    // private (frozen file), so we maintain an instance-local SoA over the SAME
    // static set and adapt it to the engine's TileSpatialQuery. It rebuilds
    // lazily the first time the query runs after the element set changes, so the
    // index is always current within the render that consumes it (no stale tile).
    const tileSoaRef = useRef<SpatialSoA | null>(null);
    const tileSyncedRef = useRef<CanvasElementType[] | null>(null);
    const tileElementMapRef = useRef<Map<string, CanvasElementType>>(new Map());
    const tileSpatialQuery = useMemo<TileSpatialQuery | undefined>(() => {
        if (rendererStrategy !== 'tiled') return undefined;
        const els = acceleratedStaticElements;
        return (aabb: AABB) => {
            const soa = tileSoaRef.current ?? (tileSoaRef.current = new SpatialSoA());
            if (tileSyncedRef.current !== els) {
                soa.rebuild(els);
                const map = new Map<string, CanvasElementType>();
                for (const el of els) map.set(el.id, el);
                tileElementMapRef.current = map;
                tileSyncedRef.current = els;
            }
            const ids = soa.queryRect(aabb.minX, aabb.minY, aabb.maxX, aabb.maxY);
            const map = tileElementMapRef.current;
            const result: CanvasElementType[] = [];
            for (const id of ids) {
                const el = map.get(id);
                if (el) result.push(el);
            }
            return result;
        };
    }, [rendererStrategy, acceleratedStaticElements]);

    // ── WebGL hybrid engine ──────────────────────────────────
    // Fed the FULL element set + selectedIds; the renderer filters selected
    // internally, so the threshold tracks total count and selection never
    // double-draws. `webglAvailable` is true only once a WebGL2 context inits —
    // missing WebGL2 keeps it false and the decision below falls back to Konva.
    const {
        webglCanvasRef,
        isActive: webglAvailable,
        invalidateElements: webglInvalidateElements,
    } = useWebGLHybrid(resolvedElements, selectedIdsSet, viewport, dimensions, {
        enabled: rendererStrategy === 'webgl-hybrid',
        rasterFn: konvaElementRasterFn,
        elementThreshold: rendererElementThreshold,
    });

    // ── Tile engine ──────────────────────────────────────────
    const { isActive: tileActive, tiles: renderedTiles } = useTileRenderer(
        acceleratedStaticElements,
        viewport,
        dimensions.width,
        dimensions.height,
        {
            enabled: rendererStrategy === 'tiled',
            maxCachedTiles: rendererOptions?.maxCachedTiles,
            drawFn: konvaTileDrawFn,
            elementThreshold: rendererElementThreshold,
            spatialQuery: tileSpatialQuery,
        },
    );

    // ── Strategy decision: accelerate or fall back to Konva static ──
    const renderDecision = resolveRenderStrategy({
        renderer,
        staticElementCount:
            rendererStrategy === 'tiled' ? acceleratedStaticElements.length : resolvedElements.length,
        elementThreshold: rendererElementThreshold,
        webglAvailable,
        tileActive,
    });

    // ── WebGL atlas invalidation ─────────────────────────────
    // The renderer re-rasterises on `version` bumps itself; this diff (the same
    // visual signature the tile hook uses) catches the style / text / visibility
    // edits that DON'T bump version, plus deletions. Undo / redo / import /
    // setElements turn over identities & versions, so they surface here too —
    // invalidating the precise changed∪removed set re-rasterises exactly them.
    const webglSignaturesRef = useRef<Map<string, string>>(new Map());
    useEffect(() => {
        if (rendererStrategy !== 'webgl-hybrid') return;
        const { changed, removed, next } = diffElements(webglSignaturesRef.current, resolvedElements);
        webglSignaturesRef.current = next;
        if (changed.length > 0 || removed.length > 0) {
            const ids = removed.slice();
            for (const el of changed) ids.push(el.id);
            webglInvalidateElements(ids);
        }
    }, [rendererStrategy, resolvedElements, webglInvalidateElements]);

    // ─── Keyboard Shortcuts ────────────────────────────────────
    // Always call the hook (Rules of Hooks) — pass the resolved per-instance
    // store + enabled flag so shortcuts act on THIS canvas, not the singleton.
    useKeyboardShortcuts(useCanvasStore, enableShortcuts && !readOnly, containerRef);

    // ─── Plugin registration: custom element types ────────────
    // Registered once on mount into the global singleton registry.
    // The registry persists across re-renders; registration is intentionally
    // not reversible at runtime (types cannot be unregistered).
    //
    // DEV RESTRICTION: changing the customElementTypes prop after mount has
    // no effect and emits a warning — move registration to module scope via
    // registerCustomElement() if you need it before the component mounts.
    const initialCustomTypesRef = useRef(customElementTypes);
    useEffect(() => {
        const configs = initialCustomTypesRef.current;
        if (!configs?.length) return;
        for (const cfg of configs) {
            try {
                elementRegistry.register(cfg);
            } catch {
                // Already registered (e.g. HMR re-mount) — silently ignore.
            }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Warn in dev when customElementTypes reference changes after mount.
    const isMountedRef = useRef(false);
    useEffect(() => {
        if (!isMountedRef.current) { isMountedRef.current = true; return; }
        if (import.meta.env.DEV && customElementTypes !== initialCustomTypesRef.current) {
            console.warn(
                '[f1ow] customElementTypes changed after mount — this has no effect. ' +
                'Register custom types before mounting <FlowCanvas> via registerCustomElement(), ' +
                'or keep the customElementTypes array reference stable (e.g. useMemo / module-level constant).'
            );
        }
    }, [customElementTypes]);

    // ─── Init: default style, initial elements, grid ──────────
    useEffect(() => {
        if (defaultStyle) {
            setCurrentStyle({ ...DEFAULT_STYLE, ...defaultStyle });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (initialElements && initialElements.length > 0) {
            setElements(initialElements);
            pushHistory();
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (showGridProp !== showGrid) {
            toggleGrid();
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Default tool on mount ────────────────────────────────
    useEffect(() => {
        if (defaultTool) {
            setActiveTool(defaultTool);
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Controlled Elements ──────────────────────────────────
    useEffect(() => {
        if (controlledElements) {
            setElements(controlledElements);
        }
    }, [controlledElements, setElements]);

    // ─── Notify parent on changes ─────────────────────────────
    const prevElementsRef = useRef(elements);
    useEffect(() => {
        if (onChange && elements !== prevElementsRef.current) {
            onChange(elements);
        }
        prevElementsRef.current = elements;
    }, [elements, onChange]);

    useEffect(() => {
        if (onSelectionChange) {
            onSelectionChange(selectedIds);
        }
    }, [selectedIds, onSelectionChange]);

    // ─── Auto-exit linear edit on deselection / tool change ───
    // Point-edit is entered via double-click (or immediately after creating
    // a connector in LinearTool). This effect only exits when selection/tool
    // no longer matches the editing element.
    useEffect(() => {
        const linState = useLinearEditStore.getState();
        if (!linState.isEditing) return;

        // Exit if tool is not select
        if (activeTool !== 'select') {
            linState.exitEditMode();
            return;
        }

        // Exit if the editing element is no longer the sole selection
        if (selectedIds.length !== 1 || selectedIds[0] !== linState.elementId) {
            linState.exitEditMode();
        }
    }, [selectedIds, activeTool]);

    // Modifier key listeners (Shift + Cmd/Ctrl)
    useEffect(() => {
        const onDown = (e: KeyboardEvent) => {
            if (e.key === 'Shift') shiftKeyRef.current = true;
            if (e.key === 'Meta' || e.key === 'Control') metaKeyRef.current = true;
        };
        const onUp = (e: KeyboardEvent) => {
            if (e.key === 'Shift') shiftKeyRef.current = false;
            if (e.key === 'Meta' || e.key === 'Control') metaKeyRef.current = false;
        };
        const onBlur = () => {
            shiftKeyRef.current = false;
            metaKeyRef.current = false;
        };
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    // Space key listener (hold Space to pan)
    useEffect(() => {
        const onDown = (e: KeyboardEvent) => {
            if (isTextEditingTarget(e.target)) return;
            if (e.code === 'Space' && !spaceKeyRef.current) {
                e.preventDefault();
                spaceKeyRef.current = true;
                setIsSpacePanning(true);
            }
        };
        const onUp = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                spaceKeyRef.current = false;
                setIsSpacePanning(false);
            }
        };
        // Also release on blur (tab switch, focus loss)
        const onBlur = () => {
            if (spaceKeyRef.current) {
                spaceKeyRef.current = false;
                setIsSpacePanning(false);
            }
        };
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    // ─── Image drag-and-drop handler ──────────────────────────
    useEffect(() => {
        const container = containerRef.current;
        if (!container || readOnly) return;

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer) return;

            const files = getImageFilesFromDataTransfer(e.dataTransfer);
            if (files.length === 0) return;

            // Calculate drop position in canvas coordinates
            const rect = container.getBoundingClientRect();
            const vp = useCanvasStore.getState().viewport;
            const dropX = (e.clientX - rect.left - vp.x) / vp.scale;
            const dropY = (e.clientY - rect.top - vp.y) / vp.scale;
            const curStyle = useCanvasStore.getState().currentStyle;

            for (const file of files) {
                try {
                    const dataURL = await fileToDataURL(file);
                    const img = await loadImage(dataURL);
                    const el = createImageElement(
                        dataURL,
                        img.naturalWidth,
                        img.naturalHeight,
                        dropX,
                        dropY,
                        { ...curStyle },
                    );
                    addElement(el);
                    onElementCreate?.(el);
                    setSelectedIds([el.id]);
                    pushHistory();
                } catch { /* skip unreadable images */ }
            }
            setActiveTool('select');
        };

        container.addEventListener('dragover', handleDragOver);
        container.addEventListener('drop', handleDrop);
        return () => {
            container.removeEventListener('dragover', handleDragOver);
            container.removeEventListener('drop', handleDrop);
        };
    }, [readOnly, addElement, setSelectedIds, pushHistory, setActiveTool, onElementCreate]);

    // ─── Image paste handler ──────────────────────────────────
    // Uses 'paste' event (not keydown) to access clipboardData.
    // CRITICAL: Read clipboardData synchronously before any await,
    // because browsers invalidate it after the event handler returns.
    useEffect(() => {
        if (readOnly) return;

        const handlePaste = (e: ClipboardEvent) => {
            if (isTextEditingTarget(e.target)) return;

            // Synchronously extract image data before browser invalidates clipboardData
            const imageData = extractImageDataFromClipboard(e);

            if (imageData.file || imageData.imgUrl) {
                // ── Image paste ──────────────────────────────────
                e.preventDefault();
                e.stopPropagation();

                (async () => {
                    try {
                        const imgSrc = await resolveImageSource(imageData);
                        if (!imgSrc) return;

                        const img = await loadImage(imgSrc);
                        const vp = useCanvasStore.getState().viewport;
                        const container = containerRef.current;
                        const rect = container?.getBoundingClientRect();
                        const cx = rect ? ((rect.width / 2) - vp.x) / vp.scale : 400;
                        const cy = rect ? ((rect.height / 2) - vp.y) / vp.scale : 300;
                        const curStyle = useCanvasStore.getState().currentStyle;

                        const el = createImageElement(
                            imgSrc,
                            img.naturalWidth,
                            img.naturalHeight,
                            cx,
                            cy,
                            { ...curStyle },
                        );
                        addElement(el);
                        onElementCreate?.(el);
                        setSelectedIds([el.id]);
                        pushHistory();
                        setActiveTool('select');
                    } catch { /* ignore failed image loads */ }
                })();
            } else {
                // ── Element paste (internal clipboard) ──────────
                e.preventDefault();
                e.stopPropagation();

                const clip = getClipboard();
                if (clip.length === 0) return;
                const PASTE_OFFSET = 20;
                const { clones, selectedCloneIds } = cloneAndRemapElements(clip, clip, PASTE_OFFSET);
                clones.forEach((el) => addElement(el));
                setSelectedIds(selectedCloneIds.length > 0 ? selectedCloneIds : clones.map((c) => c.id));
                pushHistory();
                setClipboard(clip.map(el => ({ ...el, x: el.x + PASTE_OFFSET, y: el.y + PASTE_OFFSET })));
            }
        };

        // Use capture phase to intercept before any other handler
        window.addEventListener('paste', handlePaste, true);
        return () => window.removeEventListener('paste', handlePaste, true);
    }, [readOnly, addElement, setSelectedIds, pushHistory, setActiveTool, onElementCreate]);

    // ─── Container sizing ─────────────────────────────────────
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width: w, height: h } = entry.contentRect;
                setDimensions({ width: Math.floor(w), height: Math.floor(h) });
            }
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    // ─── Pointer helper ───────────────────────────────────────
    const getPointerPos = useCallback((): Point | null => {
        const stage = stageRef.current;
        if (!stage) return null;
        const pointer = stage.getPointerPosition();
        if (!pointer) return null;
        return {
            x: (pointer.x - viewport.x) / viewport.scale,
            y: (pointer.y - viewport.y) / viewport.scale,
        };
    }, [viewport]);

    /** Snap a point to grid if grid is visible */
    const snapPos = useCallback(
        (pos: Point): Point => {
            if (!showGrid) return pos;
            return { x: snapToGrid(pos.x, GRID_SIZE), y: snapToGrid(pos.y, GRID_SIZE) };
        },
        [showGrid],
    );

    // ─── Tool Context ─────────────────────────────────────────
    // Shared context object passed to tool handlers.
    // Uses refs for mutable data to avoid re-creating on every render.
    const toolCtxRef = useRef<ToolContext>(null as any);
    toolCtxRef.current = {
        // The resolved per-instance store — tools read transient state
        // (pause/resume history, fresh elements, line-type defaults) through
        // this so multiple FlowCanvas instances never share the singleton.
        store: useCanvasStore,
        elements,
        selectedIds,
        activeTool,
        currentStyle,
        isDrawing,
        drawStart,
        showGrid,
        addElement,
        updateElement,
        deleteElements,
        setSelectedIds,
        clearSelection,
        setActiveTool,
        commitTool,
        setIsDrawing,
        setDrawStart,
        pushHistory,
        getPointerPos,
        snapPos,
        currentElementIdRef,
        shiftKeyRef,
        startBindingRef,
        snapThreshold,
        hysteresisMargin,
        setSnapTarget,
        selectionBox,
        setSelectionBox,
        setAutoEditTextId,
        linearEdit: {
            isEditing: linearEdit.isEditing,
            elementId: linearEdit.elementId,
            exitEditMode: linearEdit.exitEditMode,
            enterEditMode: linearEdit.enterEditMode,
        },
        onElementCreate,
        onElementDelete,
    };

    // ─── Tool lifecycle: deactivate the outgoing tool on a tool switch ──
    // Every active-tool change (keyboard shortcut, toolbar, Escape, the
    // imperative handle, or a tool committing back to 'select') flows through
    // the store's activeTool. When it changes, run the OUTGOING tool's
    // deactivate() so any in-flight gesture is finalized/aborted: paused history
    // is resumed and module-level gesture state is reset. Without this,
    // switching mid-draw would strand resumeHistory() (killing undo/redo for the
    // whole session) and leak gesture state.
    const prevToolRef = useRef<ToolType>(activeTool);
    useEffect(() => {
        const prevTool = prevToolRef.current;
        prevToolRef.current = activeTool;
        if (prevTool === activeTool) return;
        // deactivate is idempotent — a no-op when the outgoing tool already
        // finished (e.g. a normal onMouseUp that committed back to 'select').
        getToolHandler(prevTool)?.deactivate?.(toolCtxRef.current);
    }, [activeTool]);

    // ─── Tool lifecycle: deactivate on release/cancel OUTSIDE the Stage ──
    // When the pointer is released (pointerup) or the gesture is cancelled
    // (pointercancel) outside the Konva stage — including over the toolbar/style
    // panel — the Stage's onMouseUp never fires, so the active tool would never
    // end its gesture, stranding paused history and gesture state. Funnel these
    // through the tool's deactivate(), which is idempotent and self-guards when
    // no gesture exists. Releases INSIDE the stage are skipped here because the
    // Stage onMouseUp already handles them — this is the guard against
    // double-finalizing an already-handled gesture.
    useEffect(() => {
        const finalizeOutsideStage = (e: PointerEvent) => {
            const stageContainer = stageRef.current?.container();
            if (stageContainer && e.target instanceof Node && stageContainer.contains(e.target)) return;
            const ctx = toolCtxRef.current;
            getToolHandler(ctx.activeTool)?.deactivate?.(ctx);
        };
        window.addEventListener('pointerup', finalizeOutsideStage);
        window.addEventListener('pointercancel', finalizeOutsideStage);
        return () => {
            window.removeEventListener('pointerup', finalizeOutsideStage);
            window.removeEventListener('pointercancel', finalizeOutsideStage);
        };
    }, []);

    // ─── Mouse Down ───────────────────────────────────────────
    const handleMouseDown = useCallback(
        (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
            if (readOnly) return;

            // Space+drag panning: let Konva Stage handle the drag, skip all tool logic
            if (spaceKeyRef.current) return;

            // Right-click: set flag so handleElementSelect skips selection change
            // (Konva fires `click` for right-click too, unlike DOM)
            const nativeEvt = e.evt as MouseEvent;
            if (nativeEvt.button === 2) {
                isRightClickRef.current = true;
                if (contextMenu) setContextMenu(null);
                return;
            }
            isRightClickRef.current = false;

            const ctx = toolCtxRef.current;
            const pos = ctx.getPointerPos();
            if (!pos) return;

            // Dismiss context menu on left click
            if (contextMenu) setContextMenu(null);

            // Hand tool panning is handled by Konva's native Stage dragging
            if (ctx.activeTool === 'hand' || isSpacePanning) return;

            // ── Commit any in-progress text edit BEFORE selection changes ──
            // When text is being edited via the HTML overlay, mousedown fires
            // BEFORE blur.  If the selection changes here (e.g. clearSelection
            // on empty canvas click), the TextShape unmounts/remounts between
            // layers.  The remounted component would re-open the editor with
            // stale text content (the value before the edit), and when that
            // second editor eventually blurs it overwrites the committed
            // value — reverting the user's edit.
            //
            // Fix: explicitly blur() the active editable element first.  This fires the
            // existing finishEdit handler synchronously, which commits the
            // new text to the store and cleans up editing state.  By the time
            // the tool handler runs (and potentially calls clearSelection),
            // the store already has the correct text.
            if (editingTextId) {
                blurTextEditingTarget(document.activeElement);
            }

            // Delegate to tool handler
            const handler = getToolHandler(ctx.activeTool);
            handler?.onMouseDown(e, pos, ctx);

            // After dispatch: if drawing was started, isolate the new element
            // on a dedicated DrawingLayer (keeps static + interactive stable).
            if (currentElementIdRef.current) {
                setDrawingElementId(currentElementIdRef.current);
                // NOTE: We intentionally do NOT reduce Konva.pixelRatio here.
                // DrawingLayer renders only 1 element so full-res draw is cheap.
                // Reducing pixelRatio would create a low-res canvas for the
                // DrawingLayer and cause blurry preview when zoomed in.
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [readOnly, contextMenu, isSpacePanning, editingTextId]
    );

    // ─── Mouse Move ───────────────────────────────────────────
    const handleMouseMoveCore = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
        // Skip all move logic during space-panning — Konva handles drag
        if (spaceKeyRef.current) return;
        if (readOnly) return;

        const ctx = toolCtxRef.current;
        const pos = ctx.getPointerPos();
        if (!pos) return;

        // Broadcast cursor position to collaboration peers
        collabUpdateCursor(pos);

        // Delegate to tool handler
        const handler = getToolHandler(ctx.activeTool);
        handler?.onMouseMove(e, pos, ctx);
    }, [readOnly, collabUpdateCursor]);

    // RAF-throttle mouse move to batch updates to 1 per animation frame.
    // This dramatically reduces CPU usage during drawing and drag operations.
    const throttledMouseMoveRef = useRef<ReturnType<typeof rafThrottle> | null>(null);

    // Keep the throttled function in sync with the latest handleMouseMoveCore
    const mouseMoveRef = useRef(handleMouseMoveCore);
    mouseMoveRef.current = handleMouseMoveCore;

    // Create a stable RAF-throttled wrapper
    const handleMouseMove = useMemo(() => {
        // Clean up previous throttle
        throttledMouseMoveRef.current?.cancel?.();
        const throttled = rafThrottle((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
            mouseMoveRef.current(e);
        });
        throttledMouseMoveRef.current = throttled;
        return throttled;
    }, []); // stable — delegates to mouseMoveRef.current

    // Cleanup RAF on unmount
    useEffect(() => {
        return () => {
            throttledMouseMoveRef.current?.cancel?.();
            // Dispose only THIS instance's elbow worker — never a shared global
            // one. Other FlowCanvas instances keep their own managers alive.
            // Idempotent: marking disposed lets a StrictMode remount recreate it.
            elbowManagerRef.current?.dispose();
            elbowManagerDisposedRef.current = true;
            disposeExportWorkerManager();
        };
    }, []);

    // ─── Mouse Up ────────────────────────────────────────────
    const handleMouseUp = useCallback(() => {
        // Delegate to tool handler — each tool manages its own cleanup
        const ctx = toolCtxRef.current;
        const handler = getToolHandler(ctx.activeTool);
        handler?.onMouseUp(ctx);
        // Delay clearing drawingElementId by one frame so the StaticLayer
        // picks up the finalized element (via useEffect → layer.cache) before
        // the DrawingLayer disappears. Without this there is a 1-frame gap
        // where the element is visible on neither layer → flicker on mouseUp.
        requestAnimationFrame(() => {
            setDrawingElementId(null);
        });
    }, [setDrawingElementId]);

    // ─── Wheel (Zoom) ────────────────────────────────────────
    const handleWheel = useCallback(
        (e: Konva.KonvaEventObject<WheelEvent>) => {
            e.evt.preventDefault();
            const stage = stageRef.current;
            if (!stage) return;

            const pointer = stage.getPointerPosition();
            if (!pointer) return;

            const scaleBy = 1.02;
            const dir = e.evt.deltaY > 0 ? -1 : 1;
            const targetScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM,
                dir > 0 ? viewport.scale * scaleBy : viewport.scale / scaleBy
            ));
            setViewport(zoomAtPoint({ viewport, point: pointer, targetScale }));
        },
        [viewport, setViewport]
    );

    const handleStageDragMove = useCallback(
        (e: Konva.KonvaEventObject<DragEvent>) => {
            if (activeTool !== 'hand' && !spaceKeyRef.current && !isSpacePanning) return;
            setViewport({ x: e.target.x(), y: e.target.y() });
        },
        [activeTool, setViewport, isSpacePanning]
    );

    // Both onDragMove and onDragEnd need the same handler — reuse the reference
    const handleStageDragEnd = handleStageDragMove;

    const handleElementSelect = useCallback(
        (id: string) => {
            const { activeTool, elements, selectedIds: currentSelectedIds, setSelectedIds } = useCanvasStore.getState();
            if (activeTool !== 'select' || readOnly) return;

            // Right-click: skip selection change — handleContextMenu handles it.
            // This prevents Konva's right-click `click` event from destroying
            // multi-selection before the context menu opens.
            if (isRightClickRef.current) {
                isRightClickRef.current = false;
                return;
            }

            // ── Cross-layer double-click detection ────────────────────────
            // When clicking an element that was NOT selected, it moves from the
            // Static Layer to the Interactive Layer — the underlying Konva node
            // is destroyed and re-created. Konva tracks dblclick per-node, so
            // the second click on the new node cannot trigger a native dblclick.
            // Detect the rapid second click here and forward it manually.
            const now = Date.now();
            const last = lastClickRef.current;
            const wasAlreadySelected = currentSelectedIds.includes(id);
            if (last && last.id === id && (now - last.time) < 400 && !wasAlreadySelected) {
                // This is the second click within the dblclick window on a
                // shape that just transitioned layers. Fire double-click.
                lastClickRef.current = null;
                dblClickHandlerRef.current?.(id);
                return; // selection was already set by the first click
            }
            // Record this click for future dblclick detection
            lastClickRef.current = { id, time: now };

            const additive = shiftKeyRef.current || metaKeyRef.current;
            const nextIds = computeNextSelection(elements, currentSelectedIds, id, additive);
            setSelectedIds(nextIds);

            /*
             * Single-click never enters linear point-edit (double-click does).
             * Exit edit mode when the sole editing target is no longer selected alone.
             */
            const linearState = useLinearEditStore.getState();
            if (linearState.isEditing) {
                if (nextIds.length !== 1 || nextIds[0] !== linearState.elementId) {
                    linearState.exitEditMode();
                }
            }
        },
        [readOnly]
    );

    // ─── Batched drag updates ─────────────────────────────────
    // When multi-selecting N elements and dragging, Konva fires
    // onDragMove for EACH element synchronously in the same frame.
    // Without batching, this causes N separate store writes → N
    // array allocations → N cascading re-renders.
    //
    // Solution: buffer individual updates in a Map, then flush
    // them as a single batchUpdateElements call via microtask.
    // Cost per frame: 1 array.slice() + 1 React re-render.
    //
    // MULTI-SELECT FAST PATH: When many elements are selected
    // (> MULTI_DRAG_STORE_SKIP_THRESHOLD), skip the store update
    // entirely during drag.  Konva natively moves the visual nodes
    // so the canvas looks correct.  Store syncs on dragEnd.
    // This eliminates: resolvedElements recompute, R-tree rebuild,
    // partition, 100+ CanvasElementComponent re-renders per frame.
    const dragBatchRef = useRef<Map<string, Partial<CanvasElementType>> | null>(null);
    const dragFlushScheduledRef = useRef(false);
    /** Track whether we're in a multi-drag that skips store updates */
    const isMultiDragSkippingRef = useRef(false);
    /** This stage's saved pixel ratio while it is reduced during a drag */
    const savedPixelRatioRef = useRef<number | null>(null);

    // ─── Per-stage pixelRatio (drag performance) ──────────────
    // Reducing the pixel ratio during drag cuts draw cost ~50% on Retina.
    // We scope this to THIS instance's stage layers (never the global
    // `Konva.pixelRatio`) so two simultaneous drags on different canvases
    // can't race, and an interrupted drag/unmount can't strand the global
    // default at low-res.
    const setStagePixelRatio = useCallback((ratio: number) => {
        const stage = stageRef.current;
        if (!stage) return;
        stage.getLayers().forEach((layer) => {
            layer.getCanvas().setPixelRatio(ratio);
        });
        stage.batchDraw();
    }, []);

    /** Reduce this stage's pixel ratio for the duration of a drag. Idempotent. */
    const beginDragPixelRatio = useCallback(() => {
        if (savedPixelRatioRef.current !== null) return;
        const firstLayer = stageRef.current?.getLayers()[0];
        savedPixelRatioRef.current = firstLayer
            ? firstLayer.getCanvas().getPixelRatio()
            : Konva.pixelRatio;
        setStagePixelRatio(1);
    }, [setStagePixelRatio]);

    /** Restore this stage's pixel ratio after a drag ends OR is interrupted. Idempotent. */
    const restoreDragPixelRatio = useCallback(() => {
        if (savedPixelRatioRef.current === null) return;
        setStagePixelRatio(savedPixelRatioRef.current);
        savedPixelRatioRef.current = null;
    }, [setStagePixelRatio]);

    // Crash-safety: dragEnd normally restores the ratio, but if a drag is
    // interrupted (pointer released/cancelled outside the stage, or the
    // component unmounts mid-drag) restore it here too. Idempotent — a no-op
    // when no drag reduced it.
    useEffect(() => {
        window.addEventListener('pointerup', restoreDragPixelRatio);
        window.addEventListener('pointercancel', restoreDragPixelRatio);
        return () => {
            window.removeEventListener('pointerup', restoreDragPixelRatio);
            window.removeEventListener('pointercancel', restoreDragPixelRatio);
            restoreDragPixelRatio();
        };
    }, [restoreDragPixelRatio]);

    const flushDragBatch = useCallback(() => {
        dragFlushScheduledRef.current = false;
        const batch = dragBatchRef.current;
        if (!batch || batch.size === 0) return;
        const updates = Array.from(batch, ([id, upd]) => ({ id, updates: upd }));
        batch.clear();
        useCanvasStore.getState().batchUpdateElements(updates);
    }, []);

    // Lightweight position update during drag — no history push.
    // When dragging a bound connector directly, unbind it first.
    const unboundConnectorIdsRef = useRef<Set<string>>(new Set());
    // ─── Helper: imperatively sync shape-bound text Konva nodes ──
    // Shape + bound text = one visual unit.  During drag / transform,
    // React props haven't updated yet (batched microtask), so we must
    // move the Konva text nodes directly for frame-perfect sync.
    const syncBoundTextNodes = useCallback(
        (el: CanvasElementType, newX: number, newY: number, newW?: number, newH?: number) => {
            if (!el.boundElements || !stageRef.current) return;
            if (!CONTAINER_TYPES.has(el.type)) return;
            const elements = useCanvasStore.getState().elements;
            const shapeW = newW ?? el.width;
            const shapeH = newH ?? el.height;
            for (const be of el.boundElements) {
                if (be.type !== 'text') continue;
                const txt = elements.find(e => e.id === be.id) as TextElement | undefined;
                if (!txt) continue;
                const textNode = stageRef.current.findOne('#' + be.id);
                if (!textNode) continue;
                const textNodeH = (textNode as any).height?.() ?? txt.height;
                const pos = computeBoundTextPosition(
                    { x: newX, y: newY, width: shapeW, height: shapeH },
                    { height: textNodeH, verticalAlign: txt.verticalAlign },
                );
                (textNode as any).width?.(pos.width);
                textNode.x(pos.x);
                textNode.y(pos.y);
            }
        },
        []
    );

    const handleElementDragMove = useCallback(
        (id: string, updates: Partial<CanvasElementType>) => {
            if (readOnly) return;

            // ─── Reduce this stage's pixelRatio during drag ───
            // Cuts draw cost ~50% on Retina displays (4× fewer pixels).
            // Restored on dragEnd in handleElementChange / flushDragEndBatch,
            // and on pointerup/cancel/unmount as a crash-safety net.
            beginDragPixelRatio();

            const { elements, selectedIds } = useCanvasStore.getState();

            // ─── Multi-select fast path ───────────────────────
            // When many elements are selected, skip store writes.
            // Konva handles visual positioning natively — the nodes
            // are already at the correct screen position.  Syncing
            // to React state on every frame causes O(n) cascading
            // recomputation that dominates frame time with 1K+ elements.
            if (selectedIds.length > MULTI_DRAG_STORE_SKIP_THRESHOLD) {
                isMultiDragSkippingRef.current = true;
                // Still need to sync shape-bound text since those nodes
                // are not draggable (listening=false) — Konva won't move them.
                const el = elements.find(e => e.id === id);
                if (el) {
                    const nx = (updates as { x?: number }).x ?? el.x;
                    const ny = (updates as { y?: number }).y ?? el.y;
                    syncBoundTextNodes(el, nx, ny);
                }
                return;
            }
            isMultiDragSkippingRef.current = false;

            // Check if this is a bound connector being dragged directly
            const el = elements.find(e => e.id === id);
            if (el && (el.type === 'line' || el.type === 'arrow') && !unboundConnectorIdsRef.current.has(id)) {
                const conn = el as LineElement | ArrowElement;
                if (conn.startBinding || conn.endBinding) {
                    // First drag frame: unbind this connector
                    unboundConnectorIdsRef.current.add(id);
                    const unbindUpdates: Partial<LineElement | ArrowElement> = {};
                    const connType = conn.type as 'arrow' | 'line';

                    if (conn.startBinding) {
                        const fresh = useCanvasStore.getState().elements;
                        syncBoundElements(id, connType, conn.startBinding, null, fresh, useCanvasStore.getState().updateElement);
                        unbindUpdates.startBinding = null;
                    }
                    if (conn.endBinding) {
                        const fresh2 = useCanvasStore.getState().elements;
                        syncBoundElements(id, connType, conn.endBinding, null, fresh2, useCanvasStore.getState().updateElement);
                        unbindUpdates.endBinding = null;
                    }
                    // Connector unbinding is rare — write immediately
                    useCanvasStore.getState().updateElement(id, { ...updates, ...unbindUpdates });
                    return;
                }
            }

            // ─── Imperatively move shape-bound text during drag ──
            // Shape + bound text = one visual unit.  Move text nodes
            // directly for frame-perfect sync (store updates are deferred).
            if (el) {
                const nx = (updates as { x?: number }).x ?? el.x;
                const ny = (updates as { y?: number }).y ?? el.y;
                const nw = (updates as { width?: number }).width;
                const nh = (updates as { height?: number }).height;
                syncBoundTextNodes(el, nx, ny, nw, nh);
            }

            // ─── Flush strategy ───────────────────────────────
            // Single-element drag: flush SYNCHRONOUSLY.  The microtask
            // indirection causes a 1-frame lag where the shape is moved
            // by Konva's internal drag logic but the bound connectors
            // haven't recomputed yet — visible as flicker at the source
            // endpoint of arrows attached to the dragged shape.
            //
            // Multi-element drag (2..SKIP_THRESHOLD): Konva fires
            // onDragMove once per selected element in the same frame, so
            // buffer via microtask to coalesce into a single store write.
            if (selectedIds.length <= 1) {
                useCanvasStore.getState().batchUpdateElements([{ id, updates }]);
            } else {
                if (!dragBatchRef.current) dragBatchRef.current = new Map();
                dragBatchRef.current.set(id, updates);
                if (!dragFlushScheduledRef.current) {
                    dragFlushScheduledRef.current = true;
                    queueMicrotask(flushDragBatch);
                }
            }
        },
        [readOnly, flushDragBatch, syncBoundTextNodes]
    );

    // Alignment snap: single-select uses per-element guides; multi-select snaps
    // the selection AABB as one unit and reuses the delta for every per-element
    // call in the same frame (microtask-cleared cache).
    const multiDragSnapCacheRef = useRef<{
        dx: number;
        dy: number;
        guides: AlignGuide[];
    } | null>(null);
    const multiDragSnapClearScheduledRef = useRef(false);

    const handleDragSnap = useCallback(
        (id: string, bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number } | null => {
            const { elements: els, selectedIds: selIds } = useCanvasStore.getState();

            if (selIds.length > 1) {
                if (!multiDragSnapCacheRef.current) {
                    const snap = computeMultiSelectAlignSnap(id, bounds, els, selIds);
                    multiDragSnapCacheRef.current = {
                        dx: snap.dx,
                        dy: snap.dy,
                        guides: snap.guides,
                    };
                    setAlignGuides(snap.guides);
                    if (!multiDragSnapClearScheduledRef.current) {
                        multiDragSnapClearScheduledRef.current = true;
                        queueMicrotask(() => {
                            multiDragSnapCacheRef.current = null;
                            multiDragSnapClearScheduledRef.current = false;
                        });
                    }
                }
                const cached = multiDragSnapCacheRef.current;
                if (!cached || (cached.dx === 0 && cached.dy === 0)) {
                    return null;
                }
                return {
                    x: bounds.x + cached.dx,
                    y: bounds.y + cached.dy,
                };
            }

            const excludeIds = new Set(selIds);
            const result = computeAlignGuides(bounds, els, excludeIds);
            setAlignGuides(result.guides);
            if (result.x !== undefined || result.y !== undefined) {
                return {
                    x: result.x ?? bounds.x,
                    y: result.y ?? bounds.y,
                };
            }
            return null;
        },
        []
    );

    // ─── Batched dragEnd support ────────────────────────────────
    // When multi-select drag ends, all N shapes fire onDragEnd
    // synchronously. Without batching, this causes N separate
    // updateElement + connector recomputation + pushHistory calls.
    // Buffer into a Map and flush once via microtask.
    const dragEndBatchRef = useRef<Map<string, Partial<CanvasElementType>> | null>(null);
    const dragEndFlushScheduledRef = useRef(false);

    const flushDragEndBatch = useCallback(() => {
        dragEndFlushScheduledRef.current = false;
        const batch = dragEndBatchRef.current;
        if (!batch || batch.size === 0) return;
        const entries = Array.from(batch);
        batch.clear();
        isMultiDragSkippingRef.current = false;

        const store = useCanvasStore.getState();
        // Single batch store write for all position updates
        store.batchUpdateElements(entries.map(([id, upd]) => ({ id, updates: upd })));

        // Clear alignment guides once
        setAlignGuides([]);

        // ─── Post-update: connector + bound text sync ─────────
        const freshElements = useCanvasStore.getState().elements;
        const movedIds = entries.map(([id]) => id);
        for (const id of movedIds) unboundConnectorIdsRef.current.delete(id);

        const { updates: syncUpdates } = syncAfterDrag(movedIds, freshElements);
        if (syncUpdates.length > 0) {
            useCanvasStore.getState().batchUpdateElements(syncUpdates);
        }

        // Single history push for the entire drag operation
        useCanvasStore.getState().pushHistory();

        // Restore full pixelRatio after drag completes
        restoreDragPixelRatio();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleElementChange = useCallback(
        (id: string, updates: Partial<CanvasElementType>) => {
            if (readOnly) return;

            const { selectedIds } = useCanvasStore.getState();

            // ─── Multi-select dragEnd batch ──────────────────
            // When many elements finish drag simultaneously, batch
            // all updates into a single store write + single history push.
            if (selectedIds.length > MULTI_DRAG_STORE_SKIP_THRESHOLD) {
                if (!dragEndBatchRef.current) dragEndBatchRef.current = new Map();
                dragEndBatchRef.current.set(id, updates);

                if (!dragEndFlushScheduledRef.current) {
                    dragEndFlushScheduledRef.current = true;
                    queueMicrotask(flushDragEndBatch);
                }
                return;
            }

            updateElement(id, updates);

            // Clear alignment guides on drag end
            setAlignGuides([]);

            // Clear unbind tracking for dragged connectors
            unboundConnectorIdsRef.current.delete(id);

            // ─── Post-update: connector + bound text sync ─────────
            const freshElements = useCanvasStore.getState().elements;
            const { updates: syncUpdates } = syncAfterDrag([id], freshElements);
            for (const su of syncUpdates) updateElement(su.id, su.updates);

            // ─── Auto-resize container height when bound text grows ──────────
            const elMap = new Map<string, CanvasElementType>();
            for (const e of useCanvasStore.getState().elements) elMap.set(e.id, e);
            const el = elMap.get(id);
            if (el?.type === 'text') {
                const txt = el as TextElement;
                if (txt.containerId) {
                    const ctr = elMap.get(txt.containerId);
                    if (ctr && CONTAINER_TYPES.has(ctr.type)) {
                        const minH = txt.height + BOUND_TEXT_PADDING * 2;
                        if (ctr.height < minH) {
                            updateElement(ctr.id, { height: minH });
                            // Recompute connectors for the resized container
                            const updatedElements = useCanvasStore.getState().elements;
                            const { updates: resizeSync } = syncAfterDrag([ctr.id], updatedElements);
                            for (const su of resizeSync) updateElement(su.id, su.updates);
                        }
                    }
                }
            }

            pushHistory();

            // Restore full pixelRatio after drag completes
            restoreDragPixelRatio();
        },
        [updateElement, pushHistory, readOnly, flushDragEndBatch, restoreDragPixelRatio]
    );

    // ─── Group drag end ─────────────────────────────────────────
    // When a <KonvaGroup> wrapping grouped elements finishes dragging
    // in the static layer, apply the delta to all member positions,
    // sync connectors and bound text, then push history once.
    const handleGroupDragEnd = useCallback(
        (groupId: string, dx: number, dy: number) => {
            if (readOnly || (dx === 0 && dy === 0)) return;

            const store = useCanvasStore.getState();
            const allEls = store.elements;

            // Find all elements belonging to this group
            const members = allEls.filter(
                el => el.groupIds?.includes(groupId)
            );
            if (members.length === 0) return;

            // Batch position updates for all group members
            const posUpdates = members.map(el => ({
                id: el.id,
                updates: { x: el.x + dx, y: el.y + dy } as Partial<CanvasElementType>,
            }));
            store.batchUpdateElements(posUpdates);

            // ─── Post-update: connector + bound text sync ─────────
            const freshElements = useCanvasStore.getState().elements;
            const memberIds = new Set(members.map(m => m.id));
            const { updates: syncUpdates } = syncAfterDrag(
                memberIds,
                freshElements,
                memberIds, // skip group-internal connectors & text (already moved)
            );
            if (syncUpdates.length > 0) {
                useCanvasStore.getState().batchUpdateElements(syncUpdates);
            }

            store.pushHistory();
        },
        [readOnly]
    );

    // ─── Double-click: linear edit OR create bound text ─────────
    const handleElementDoubleClick = useCallback(
        (id: string) => {
            // Clear cross-layer click tracking — a real dblclick arrived,
            // no need to fire again from the select handler.
            lastClickRef.current = null;
            if (readOnly) return;
            const { activeTool: tool, elements: els, currentStyle: style,
                    addElement: add, updateElement: update, setSelectedIds: setSel,
            } = useCanvasStore.getState();
            if (tool !== 'select') return;
            const el = els.find((e) => e.id === id);
            if (!el) return;

            // Let consumer intercept — return true to prevent default
            if (onElementDoubleClick?.(id, el) === true) return;

            // Standalone text → enter edit mode directly
            if (el.type === 'text' && !(el as TextElement).containerId) {
                setSel([id]);
                setAutoEditTextId(id);
                return;
            }

            // Linear elements:
            //   double-click → point-edit mode
            //   Shift+double-click → create/edit connector label
            if (el.type === 'line' || el.type === 'arrow') {
                if (shiftKeyRef.current) {
                    const existingTextBinding = el.boundElements?.find(be => be.type === 'text');
                    if (existingTextBinding) {
                        setSel([existingTextBinding.id, id]);
                        setAutoEditTextId(existingTextBinding.id);
                        return;
                    }

                    /*
                     * Use the RESOLVED connector (with recomputed bound points)
                     * rather than the raw store element so the label midpoint
                     * matches the visual path.
                     */
                    const textId = generateId();
                    const resolved = resolvedMapRef.current.get(id) as LineElement | ArrowElement | undefined;
                    const conn = (resolved ?? el) as LineElement | ArrowElement;
                    const labelPos = computeConnectorLabelPosition(conn, 100, 30);

                    const textEl: TextElement = {
                        id: textId,
                        type: 'text',
                        x: labelPos.x,
                        y: labelPos.y,
                        width: 100,
                        height: 30,
                        rotation: 0,
                        style: { ...style, fillColor: 'transparent' },
                        isLocked: false,
                        isVisible: true,
                        boundElements: null,
                        text: '',
                        containerId: id,
                        textAlign: 'center',
                        verticalAlign: 'middle',
                        version: 0,
                    };

                    add(textEl);
                    onElementCreate?.(textEl);

                    const currentBound = el.boundElements ?? [];
                    update(id, {
                        boundElements: [...currentBound, { id: textId, type: 'text' }],
                    });

                    setSel([textId, id]);
                    setAutoEditTextId(textId);
                    return;
                }

                setSel([id]);
                useLinearEditStore.getState().enterEditMode(id);
                return;
            }

            // Shape elements (rect, ellipse, diamond) → create/edit bound text
            if (el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond' || el.type === 'image') {
                // Check if already has a bound text element
                const existingTextBinding = el.boundElements?.find(be => be.type === 'text');
                if (existingTextBinding) {
                    // Focus existing bound text for editing
                    // Keep parent shape in selection so the transformer stays
                    // visible — prevents flicker from rapid select/deselect.
                    setSel([existingTextBinding.id, id]);
                    setAutoEditTextId(existingTextBinding.id);
                    return;
                }

                // Create new bound text element
                const textId = generateId();
                const textEl: TextElement = {
                    id: textId,
                    type: 'text',
                    x: el.x,
                    y: el.y,
                    width: el.width,
                    height: 30,
                    rotation: 0,
                    style: { ...style, fillColor: 'transparent' },
                    isLocked: false,
                    isVisible: true,
                    boundElements: null,
                    text: '',
                    containerId: id,
                    textAlign: 'center',
                    verticalAlign: 'middle',
                    version: 0,
                };

                // Add text element
                add(textEl);
                onElementCreate?.(textEl);

                // Update container's boundElements with text ref
                const currentBound = el.boundElements ?? [];
                update(id, {
                    boundElements: [...currentBound, { id: textId, type: 'text' }],
                });

                // Select and auto-edit the new text
                // Keep parent shape in selection so the transformer stays
                // visible — prevents flicker from rapid select/deselect.
                setSel([textId, id]);
                setAutoEditTextId(textId);
                return;
            }
        },
        [readOnly, onElementDoubleClick, onElementCreate],
    );

    // Keep the ref in sync so handleElementSelect can call it without
    // a circular useCallback dependency.
    dblClickHandlerRef.current = handleElementDoubleClick;

    // ─── Linear Edit: point changes (with history push) ──────
    const handleLinearPointsChange = useCallback(
        (id: string, updates: Partial<LineElement | ArrowElement>) => {
            if (readOnly) return;
            const { elements: els, updateElement: update, pushHistory: push } = useCanvasStore.getState();
            // Get previous bindings before applying updates
            const prevEl = els.find((e) => e.id === id) as LineElement | ArrowElement | undefined;
            update(id, updates);

            // Sync bidirectional boundElements if bindings changed
            if (prevEl && (updates.startBinding !== undefined || updates.endBinding !== undefined)) {
                const connType = prevEl.type as 'arrow' | 'line';
                if (updates.startBinding !== undefined) {
                    const fresh = useCanvasStore.getState().elements;
                    syncBoundElements(id, connType, prevEl.startBinding, updates.startBinding ?? null, fresh, useCanvasStore.getState().updateElement);
                }
                if (updates.endBinding !== undefined) {
                    const fresh = useCanvasStore.getState().elements;
                    syncBoundElements(id, connType, prevEl.endBinding, updates.endBinding ?? null, fresh, useCanvasStore.getState().updateElement);
                }
            }
            push();
        },
        [readOnly],
    );

    // ─── Linear Edit: lightweight point drag (no history) ────
    const handleLinearPointDragMove = useCallback(
        (id: string, updates: Partial<LineElement | ArrowElement>) => {
            if (readOnly) return;
            useCanvasStore.getState().updateElement(id, updates);
        },
        [readOnly],
    );

    // ─── Linear Edit: snap target during endpoint drag ───────
    const handleLinearSnapTargetChange = useCallback(
        (target: SnapTarget | null) => {
            setSnapTarget(target);
        },
        [],
    );

    // ─── Text Edit callbacks ──────────────────────────────────
    const handleTextEditStart = useCallback(
        (id: string) => {
            setEditingTextId(id);
        },
        [],
    );

    const handleTextEditEnd = useCallback(
        (id: string, isEmpty: boolean) => {
            setEditingTextId(null);
            setAutoEditTextId(null);

            const { elements: els, selectedIds: currentSel, setSelectedIds: setSel,
                    updateElement: update, deleteElements: del } = useCanvasStore.getState();
            const textEl = els.find(e => e.id === id);
            const containerId = (textEl?.type === 'text') ? (textEl as TextElement).containerId : null;

            // Auto-delete empty text elements
            if (isEmpty) {
                // If bound text, also remove the reference from the container
                if (containerId) {
                    const container = els.find(e => e.id === containerId);
                    if (container?.boundElements) {
                        update(containerId, {
                            boundElements: container.boundElements.filter(be => be.id !== id),
                        });
                    }
                }
                del([id]);
                onElementDelete?.([id]);
            } else {
                useCanvasStore.getState().pushHistory();
            }

            // Restore selection to the parent shape (remove text from selectedIds)
            // so the user returns to "shape selected" state after editing.
            if (containerId && currentSel.includes(containerId)) {
                setSel([containerId]);
            } else if (containerId) {
                // If shape wasn't in selection, just clear text from selection
                setSel(currentSel.filter(sid => sid !== id));
            }
        },
        [onElementDelete],
    );

    // ─── Context Menu ─────────────────────────────────────────
    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            if (readOnly) return;
            e.preventDefault();
            const container = containerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();

            // ── Right-click element selection ──────────────────
            // Konva onClick doesn't fire for right-click, so we need to
            // hit-detect the element under the cursor and select it
            // before opening the context menu.
            const stage = stageRef.current;
            if (stage) {
                const pointerPos = stage.getPointerPosition();
                // Fallback: compute pointer position from the React event
                // (in case Konva hasn't updated its internal pointer yet).
                const px = pointerPos?.x ?? (e.clientX - rect.left);
                const py = pointerPos?.y ?? (e.clientY - rect.top);
                const vp = useCanvasStore.getState().viewport;
                const canvasX = (px - vp.x) / vp.scale;
                const canvasY = (py - vp.y) / vp.scale;

                // Find the topmost element under the pointer (iterate in reverse for z-order)
                const { elements: currentElements, selectedIds: currentSelectedIds, setSelectedIds: storeSetSelectedIds } = useCanvasStore.getState();
                let hitElement: typeof currentElements[0] | null = null;

                for (let i = currentElements.length - 1; i >= 0; i--) {
                    const el = currentElements[i];
                    // Skip bound text elements — they overlap their container
                    // and are not individually selectable via click.
                    // We'll hit the container underneath instead.
                    if (el.type === 'text' && (el as any).containerId) continue;

                    // Simple AABB hit test
                    let elX = el.x, elY = el.y, elW = el.width, elH = el.height;
                    if ((el.type === 'arrow' || el.type === 'line') && 'points' in el) {
                        const pts = (el as any).points as number[];
                        const xs: number[] = [], ys: number[] = [];
                        for (let j = 0; j < pts.length; j += 2) {
                            xs.push(el.x + pts[j]);
                            ys.push(el.y + pts[j + 1]);
                        }
                        elX = Math.min(...xs);
                        elY = Math.min(...ys);
                        elW = Math.max(...xs) - elX;
                        elH = Math.max(...ys) - elY;
                    }
                    // Add a small hit tolerance for thin/small elements
                    const tolerance = Math.max(4, (el.style?.strokeWidth ?? 2));
                    if (canvasX >= elX - tolerance && canvasX <= elX + elW + tolerance &&
                        canvasY >= elY - tolerance && canvasY <= elY + elH + tolerance) {
                        hitElement = el;
                        break;
                    }
                }

                if (hitElement) {
                    // If the hit element is already in the selection, keep current selection
                    // (preserves multi-selection for context menu actions like Group)
                    if (!currentSelectedIds.includes(hitElement.id)) {
                        // Group-aware selection
                        if (hitElement.groupIds?.length) {
                            const outermostGroupId = hitElement.groupIds[hitElement.groupIds.length - 1];
                            const groupMembers = currentElements
                                .filter(el => el.groupIds?.includes(outermostGroupId))
                                .map(el => el.id);
                            storeSetSelectedIds(groupMembers);
                        } else {
                            storeSetSelectedIds([hitElement.id]);
                        }
                    }
                }
                // If no element hit, keep current selection (right-click on empty canvas)
            }

            setContextMenu({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            });
        },
        [readOnly],
    );

    const contextMenuItems: ContextMenuItem[] = useMemo(() => {
        // Skip expensive item computation when the menu is closed
        if (!contextMenu) return [];

        const hasSelection = selectedIds.length > 0;
        const isMac = navigator.platform.includes('Mac');
        const mod = isMac ? '⌘' : 'Ctrl+';

        const items: ContextMenuItem[] = [];

        items.push({
            label: 'Copy',
            shortcut: `${mod}C`,
            disabled: !hasSelection,
            action: () => {
                if (hasSelection) {
                    setClipboard(gatherElementsForCopy(selectedIds, elements));
                }
            },
        });
        items.push({
            label: 'Paste',
            shortcut: `${mod}V`,
            disabled: !hasClipboardContent(),
            action: () => {
                const clip = getClipboard();
                if (clip.length === 0) return;
                const OFFSET = 20;
                const { clones, selectedCloneIds } = cloneAndRemapElements(clip, clip, OFFSET);
                clones.forEach((el) => addElement(el));
                setSelectedIds(selectedCloneIds.length > 0 ? selectedCloneIds : clones.map((c) => c.id));
                pushHistory();
                setClipboard(clip.map(el => ({ ...el, x: el.x + OFFSET, y: el.y + OFFSET })));
            },
        });
        items.push({
            label: 'Duplicate',
            shortcut: `${mod}D`,
            disabled: !hasSelection,
            action: () => {
                if (hasSelection) store.duplicateElements(selectedIds);
            },
        });
        items.push({
            label: 'Delete',
            shortcut: 'Del',
            disabled: !hasSelection,
            divider: true,
            action: () => {
                if (hasSelection) {
                    deleteElements(selectedIds);
                    onElementDelete?.(selectedIds);
                }
            },
        });

        items.push({
            label: 'Bring to Front',
            shortcut: `${mod}⇧]`,
            disabled: !hasSelection,
            divider: true,
            action: () => { if (hasSelection) store.bringToFront(selectedIds); },
        });
        items.push({
            label: 'Send to Back',
            shortcut: `${mod}⇧[`,
            disabled: !hasSelection,
            action: () => { if (hasSelection) store.sendToBack(selectedIds); },
        });

        // ─── Group / Ungroup section ──────────────────────────
        // Both items belong in the same visual group.  Only the FIRST
        // item gets `divider: true` to separate from the section above.
        let groupSectionStarted = false;

        if (selectedIds.length >= 2) {
            // Only show "Group" if the selection isn't already a single
            // intact group.  When clicking a grouped node, handleElementSelect
            // auto-selects all group members — without this guard, the user
            // could re-group an already-grouped set (creating a useless
            // nested wrapper).
            const selectedEls = elements.filter(el => selectedIds.includes(el.id));
            const outermostIds = new Set(
                selectedEls
                    .filter(el => el.groupIds?.length)
                    .map(el => el.groupIds![el.groupIds!.length - 1])
            );
            // Show Group if: not all elements share the same single outermost group,
            // or some elements are ungrouped.
            const allGrouped = selectedEls.every(el => el.groupIds?.length);
            const isSingleGroup = allGrouped && outermostIds.size === 1;
            if (!isSingleGroup) {
                items.push({
                    label: 'Group',
                    shortcut: `${mod}G`,
                    divider: true,
                    action: () => store.groupElements(selectedIds),
                });
                groupSectionStarted = true;
            }
        }
        if (hasSelection) {
            const selectedEls = elements.filter(el => selectedIds.includes(el.id));
            const hasGroup = selectedEls.some(el => el.groupIds?.length);
            if (hasGroup) {
                // Collect all group members (including non-selected ones) for proper ungroup
                const groupIdsToUngroup = new Set<string>();
                for (const el of selectedEls) {
                    if (el.groupIds?.length) {
                        groupIdsToUngroup.add(el.groupIds[el.groupIds.length - 1]);
                    }
                }
                const allGroupMemberIds = elements
                    .filter(el => el.groupIds?.some(gid => groupIdsToUngroup.has(gid)))
                    .map(el => el.id);
                items.push({
                    label: 'Ungroup',
                    shortcut: `${mod}⇧G`,
                    divider: !groupSectionStarted,
                    action: () => store.ungroupElements(allGroupMemberIds),
                });
            }
        }

        items.push({
            label: 'Select All',
            shortcut: `${mod}A`,
            divider: true,
            action: () => setSelectedIds(elements.map(el => el.id)),
        });

        // Lock / Unlock
        if (hasSelection) {
            const selectedEls = elements.filter(el => selectedIds.includes(el.id));
            const allLockedSel = selectedEls.every(el => el.isLocked);
            const anyLockedSel = selectedEls.some(el => el.isLocked);
            items.push({
                label: allLockedSel ? 'Unlock' : (anyLockedSel ? 'Unlock All' : 'Lock'),
                shortcut: `${mod}⇧L`,
                divider: true,
                action: () => store.toggleLockElements(selectedIds),
            });
        }

        // Convert to shape (only for shape elements)
        if (hasSelection) {
            const convertibleTypes = new Set(['rectangle', 'ellipse', 'diamond']);
            const shapeSel = elements.filter(el => selectedIds.includes(el.id) && convertibleTypes.has(el.type));
            if (shapeSel.length > 0) {
                const currentTypes = new Set(shapeSel.map(el => el.type));
                const convTargets: { label: string; type: 'rectangle' | 'ellipse' | 'diamond' }[] = [
                    { label: 'Rectangle', type: 'rectangle' },
                    { label: 'Ellipse', type: 'ellipse' },
                    { label: 'Diamond', type: 'diamond' },
                ];
                const applicable = convTargets.filter(t => !currentTypes.has(t.type) || currentTypes.size > 1);
                if (applicable.length > 0) {
                    applicable.forEach((t, i) => {
                        items.push({
                            label: `Convert to ${t.label}`,
                            divider: i === 0,
                            action: () => store.convertElementType(shapeSel.map(e => e.id), t.type),
                        });
                    });
                }
            }
        }

        // Append consumer-provided context menu items
        if (contextMenuItemsProp) {
            const extraItems = typeof contextMenuItemsProp === 'function'
                ? contextMenuItemsProp({
                    selectedIds,
                    elements,
                    position: contextMenu ?? { x: 0, y: 0 },
                    close: () => setContextMenu(null),
                })
                : contextMenuItemsProp;
            if (extraItems.length > 0) {
                // Add divider before custom items
                items.push({ ...extraItems[0], divider: true });
                for (let i = 1; i < extraItems.length; i++) {
                    items.push(extraItems[i]);
                }
            }
        }

        return items;
    }, [selectedIds, elements, store, addElement, deleteElements, setSelectedIds, pushHistory, onElementDelete, contextMenuItemsProp, contextMenu]);

    // ─── Imperative Handle ────────────────────────────────────
    useImperativeHandle(ref, () => ({
        getElements: () => useCanvasStore.getState().elements,
        setElements: (els) => { setElements(els); pushHistory(); },
        addElement: (el) => { addElement(el); },
        deleteElements: (ids) => { deleteElements(ids); },
        getSelectedIds: () => useCanvasStore.getState().selectedIds,
        setSelectedIds: (ids) => { setSelectedIds(ids); },
        clearSelection: () => { clearSelection(); },
        setActiveTool: (tool: ToolType) => { setActiveTool(tool); },
        getActiveTool: () => useCanvasStore.getState().activeTool,
        undo: () => { undo(); },
        redo: () => { redo(); },
        zoomTo: (scale: number) => { setViewport({ scale: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale)) }); },
        resetView: () => { setViewport({ x: 0, y: 0, scale: 1 }); },
        scrollToElement: (id: string, options?: { zoom?: number; animate?: boolean }) => {
            const el = useCanvasStore.getState().elements.find(e => e.id === id);
            if (!el) return;
            const container = containerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const stageW = rect.width;
            const stageH = rect.height;
            const targetScale = options?.zoom ?? Math.max(useCanvasStore.getState().viewport.scale, 1);
            const clampedScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetScale));
            // Center element in viewport
            const cx = el.x + (el.width ?? 0) / 2;
            const cy = el.y + (el.height ?? 0) / 2;
            const newX = stageW / 2 - cx * clampedScale;
            const newY = stageH / 2 - cy * clampedScale;
            const target = { x: newX, y: newY, scale: clampedScale };
            if (options?.animate) {
                animateViewport(useCanvasStore.getState().viewport, target, setViewport);
            } else {
                setViewport(target);
            }
        },
        zoomToFit: (ids?: string[], options?: { padding?: number; maxZoom?: number; animate?: boolean }) => {
            const container = containerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const stageW = rect.width;
            const stageH = rect.height;
            // Delegate to the store action which now uses camera utilities
            useCanvasStore.getState().zoomToFit(stageW, stageH, ids, {
                padding: options?.padding,
                maxZoom: options?.maxZoom,
                animate: options?.animate,
            });
        },
        exportPNG: () => stageRef.current?.toDataURL({ pixelRatio: 2 }) ?? null,
        exportJSON: () => JSON.stringify(useCanvasStore.getState().elements, null, 2),
        exportSVG: () => exportToSVG(useCanvasStore.getState().elements),
        importJSON: (json: string) => {
            try {
                const parsed = JSON.parse(json);
                if (Array.isArray(parsed)) {
                    // setElements internally filters invalid elements and warns in dev mode
                    setElements(parsed);
                    pushHistory();
                }
            } catch {
                if (import.meta.env.DEV) {
                    console.warn('[f1ow] importJSON: failed to parse JSON');
                }
            }
        },
        getStage: () => stageRef.current,
        // Deps: the closed-over store actions (stable Zustand refs) plus
        // `useCanvasStore` itself, which only changes if the `store` prop does —
        // most reads go through getState(), and refs are stable. This avoids
        // rebuilding the imperative handle on every render.
    }), [useCanvasStore, setElements, addElement, deleteElements, setSelectedIds, clearSelection, setActiveTool, undo, redo, setViewport, pushHistory]);

    // ─── Hover cursor ─────────────────────────────────────────
    // Drive the Konva container's cursor imperatively so it reflects what's
    // under the pointer WITHOUT forcing React re-renders (Konva owns that DOM
    // node, so React never fights these writes):
    //   • select → 'move' over a shape, 'default' over empty canvas
    //   • hand / space-pan → 'grab', switching to 'grabbing' while panning
    // Transformer anchors keep their own resize/rotate cursors. For drawing
    // tools the container cursor is cleared so the base getCursor() shows through.
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const container = stage.container();
        const clear = () => { container.style.cursor = ''; };

        if (readOnly) { clear(); return; }

        if (activeTool === 'hand' || isSpacePanning) {
            const grab = () => { container.style.cursor = 'grab'; };
            const grabbing = () => { container.style.cursor = 'grabbing'; };
            grab();
            stage.on('dragstart.hovercur', grabbing);
            stage.on('dragend.hovercur', grab);
            return () => { stage.off('.hovercur'); clear(); };
        }

        if (activeTool === 'select') {
            container.style.cursor = 'default';
            const onMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
                const t = e.target;
                // Skip Transformer anchors/border so their resize/rotate cursors win.
                const parent = t.getParent();
                if (t !== stage && parent && parent.className === 'Transformer') return;
                container.style.cursor = t && t !== stage ? 'move' : 'default';
            };
            stage.on('mousemove.hovercur', onMove);
            return () => { stage.off('.hovercur'); clear(); };
        }

        // Drawing tools (rectangle/ellipse/line/text/eraser/…): let the base
        // getCursor() crosshair/text cursor show through the cleared container.
        clear();
        return () => { stage.off('.hovercur'); clear(); };
    }, [activeTool, isSpacePanning, readOnly]);

    // ─── Cursor ───────────────────────────────────────────────
    const getCursor = (): string => {
        if (readOnly) return 'default';
        if (isSpacePanning) return 'grab';
        if (activeTool === 'hand') return 'grab';
        // Delegate to tool handler for cursor — falls back to 'default' for select
        const handler = getToolHandler(activeTool);
        return handler?.getCursor?.() ?? 'default';
    };

    // ─── Visible tools filter ─────────────────────────────────
    const visibleTools = tools
        ? TOOLS.filter((t) => tools.includes(t.type))
        : TOOLS;

    const showStylePanelComputed =
        showStylePanelProp &&
        !readOnly &&
        (
            // Show for drawing tools (not hand/eraser)
            !['hand', 'select', 'eraser'].includes(activeTool) ||
            // Also show in select mode when elements are selected
            (activeTool === 'select' && selectedIds.length > 0)
        );

    // Elements layer should only be interactive for select/eraser/hand.
    // For drawing tools (arrow, line, rectangle, etc.) shapes must NOT
    // capture events — clicks/drags go straight to the Stage, exactly
    // standard canvas editor behavior.
    // Also disable when space-panning so shapes don't intercept drags.
    const elementsListening = !isSpacePanning && ['select', 'eraser', 'image'].includes(activeTool);

    // ─── Render ───────────────────────────────────────────────
    return (
        <CanvasStoreProvider store={useCanvasStore}>
        <WorkerConfigContext.Provider value={workerConfigProviderValue}>
            <div
                ref={containerRef}
                className={className}
                onContextMenu={handleContextMenu}
                onMouseLeave={() => collabUpdateCursor(null)}
                style={{
                    position: 'relative',
                    width,
                    height,
                    overflow: 'hidden',
                    background: theme.canvasBackground,
                }}
            >
            {/* Toolbar */}
            {showToolbar && !readOnly && toolbarPosition !== 'hidden' && (
                <Toolbar visibleTools={visibleTools} theme={theme} position={toolbarPosition} />
            )}

            {/* Style Panel */}
            {showStylePanelComputed && <StylePanel theme={theme} />}

            {/* Canvas */}
            <div style={{ cursor: getCursor(), position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                {/* EXPERIMENTAL: WebGL hybrid static layer — a transparent canvas
                    BEHIND the Konva Stage. Mounted only for the 'webgl-hybrid'
                    strategy; renders nothing until a WebGL2 context initialises
                    and the element threshold is met (otherwise the Konva static
                    layer below still draws). */}
                {rendererStrategy === 'webgl-hybrid' && (
                    <canvas
                        ref={webglCanvasRef}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            pointerEvents: 'none',
                        }}
                    />
                )}
                <Stage
                    ref={stageRef}
                    width={dimensions.width}
                    height={dimensions.height}
                    x={viewport.x}
                    y={viewport.y}
                    scaleX={viewport.scale}
                    scaleY={viewport.scale}
                    draggable={(activeTool === 'hand' || isSpacePanning) && !readOnly}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onWheel={handleWheel}
                    onDragMove={handleStageDragMove}
                    onDragEnd={handleStageDragEnd}
                    onTouchStart={handleMouseDown}
                    onTouchMove={handleMouseMove}
                    onTouchEnd={handleMouseUp}
                >
                    {showGrid && (
                        <Layer listening={false} hitGraphEnabled={false}>
                            <GridLayer
                                width={dimensions.width}
                                height={dimensions.height}
                                viewport={viewport}
                                gridColor={theme.gridColor}
                            />
                        </Layer>
                    )}

                    {/* EXPERIMENTAL: tiled static layer — cached tile bitmaps as
                        Konva images, in place of the Konva static layer. Rendered
                        only when the 'tiled' engine is active; otherwise the Konva
                        static layer below draws (fallback). Non-listening: selected
                        elements live on the interactive layer (HARD RULE 2). */}
                    {renderDecision.strategy === 'tiled' && renderDecision.useAccelerated && (
                        <Layer listening={false} hitGraphEnabled={false}>
                            {renderedTiles.map((t) => (
                                <KonvaImage
                                    key={t.key}
                                    image={t.bitmap as unknown as HTMLImageElement}
                                    x={t.worldX}
                                    y={t.worldY}
                                    width={t.worldSize}
                                    height={t.worldSize}
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
                            ))}
                        </Layer>
                    )}

                    {/* Static Layer: non-selected elements — memoized wrapper skips
                        entire subtree when static content hasn't changed (e.g. during
                        drag of selected element, context menu, selection box, etc.).
                        On the default 'konva' strategy `useKonvaStatic` is always true,
                        so this renders exactly as before. */}
                    {renderDecision.useKonvaStatic && (
                        <MemoizedStaticLayer
                            elements={progressiveStaticElements}
                            listening={elementsListening}
                            onSelect={handleElementSelect}
                            onChange={handleElementChange}
                            onDragMove={handleElementDragMove}
                            onDoubleClick={handleElementDoubleClick}
                            autoEditTextId={autoEditTextId}
                            onTextEditStart={handleTextEditStart}
                            onTextEditEnd={handleTextEditEnd}
                            allElements={resolvedElements}
                            gridSnap={showGrid ? GRID_SIZE : undefined}
                            onDragSnap={!showGrid ? handleDragSnap : undefined}
                            viewportScale={viewport.scale}
                            onGroupDragEnd={handleGroupDragEnd}
                        />
                    )}

                    {/* Interactive Layer: selected elements + transformer + linear handles */}
                    <Layer listening={elementsListening}>
                        {interactiveElements
                            /* Drawing element lives on its own layer — keeps this layer
                               stable (zero re-renders) during active stroke. */
                            .filter(el => el.id !== drawingElementId)
                            .map((el) => (
                            <CanvasElementComponent
                                key={el.id}
                                element={el}
                                isSelected={true}
                                isEditing={isLinearEditing && linearEdit.elementId === el.id}
                                onSelect={handleElementSelect}
                                onChange={handleElementChange}
                                onDragMove={handleElementDragMove}
                                onDoubleClick={handleElementDoubleClick}
                                autoEditText={autoEditTextId === el.id}
                                onTextEditStart={handleTextEditStart}
                                onTextEditEnd={handleTextEditEnd}
                                allElements={resolvedElements}
                                gridSnap={showGrid ? GRID_SIZE : undefined}
                                onDragSnap={!showGrid ? handleDragSnap : undefined}
                                viewportScale={efficientZoom}
                            />
                        ))}

                        {activeTool === 'select' && !readOnly && (() => {
                            // Never show shape transformer on line/arrow or bound text elements
                            // Also hide when text is being edited (textarea is visible)
                            const transformableIds = selectedIds.filter(sid => {
                                const el = resolvedElementMap.get(sid);
                                if (!el) return false;
                                if (el.type === 'line' || el.type === 'arrow') return false;
                                // Bound text moves with container — not independently transformable
                                if (el.type === 'text' && (el as TextElement).containerId) return false;
                                // Hide transformer while text is being edited
                                if (sid === editingTextId) return false;
                                // Hide transformer for the container shape while its bound text is
                                // being edited — keeps the selection glow but removes resize handles
                                if (editingTextId) {
                                    const editingEl = resolvedElementMap.get(editingTextId);
                                    if (editingEl?.type === 'text' && (editingEl as TextElement).containerId === sid) return false;
                                }
                                return true;
                            });
                            if (transformableIds.length === 0) return null;
                            return (
                                <SelectionTransformer
                                    selectedIds={transformableIds}
                                    selectionColor={theme.selectionColor}
                                />
                            );
                        })()}

                        {/* Linear element edit handles — needs listening for drag */}
                        {isLinearEditing && (() => {
                            const editEl = linearEditElement;
                            if (!editEl) return null;
                            return (
                                <LinearElementHandles
                                    element={editEl}
                                    allElements={resolvedElements}
                                    onPointsChange={handleLinearPointsChange}
                                    onPointDragMove={handleLinearPointDragMove}
                                    onSnapTargetChange={handleLinearSnapTargetChange}
                                    color={theme.selectionColor}
                                    snapThreshold={snapThreshold}
                                    hysteresisMargin={hysteresisMargin}
                                />
                            );
                        })()}
                    </Layer>

                    {/* Drawing Layer — single-element canvas for the active stroke.
                        Completely isolated so Interactive Layer never re-renders during
                        drawing. hitGraphEnabled=false: can't click what you're drawing. */}
                    {drawingElementId && (() => {
                        const drawingEl = resolvedElementMap.get(drawingElementId);
                        if (!drawingEl) return null;
                        return (
                            <Layer listening={false} hitGraphEnabled={false}>
                                <CanvasElementComponent
                                    key={drawingEl.id}
                                    element={drawingEl}
                                    isSelected={false}
                                    onSelect={handleElementSelect}
                                    onChange={handleElementChange}
                                    onDragMove={handleElementDragMove}
                                    onDoubleClick={handleElementDoubleClick}
                                    allElements={resolvedElements}
                                    gridSnap={showGrid ? GRID_SIZE : undefined}
                                    viewportScale={viewport.scale}
                                />
                            </Layer>
                        );
                    })()}

                    {/* Overlay Layer: non-interactive UI decorations */}
                    <Layer listening={false} hitGraphEnabled={false}>
                        <SelectionBox box={selectionBox} selectionColor={theme.selectionColor} viewportScale={viewport.scale} />

                        {/* Connection point indicators for line/arrow tools AND linear edit endpoint drag */}
                        <ConnectionPointsOverlay
                            elements={resolvedElements}
                            snapTarget={snapTarget}
                            visible={
                                ((activeTool === 'line' || activeTool === 'arrow') || isLinearDragging) && !readOnly
                            }
                            showCenterIndicator={showCenterSnapIndicator}
                            color={theme.selectionColor}
                            viewportScale={viewport.scale}
                        />

                        {/* Smart alignment guide lines */}
                        {alignGuides.map((g, i) =>
                            g.orientation === 'v' ? (
                                <KonvaLine
                                    key={`ag-${i}`}
                                    points={[g.position, g.start, g.position, g.end]}
                                    stroke={theme.selectionColor}
                                    strokeWidth={1 / viewport.scale}
                                    dash={[4 / viewport.scale, 4 / viewport.scale]}
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
                            ) : (
                                <KonvaLine
                                    key={`ag-${i}`}
                                    points={[g.start, g.position, g.end, g.position]}
                                    stroke={theme.selectionColor}
                                    strokeWidth={1 / viewport.scale}
                                    dash={[4 / viewport.scale, 4 / viewport.scale]}
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
                            ),
                        )}

                        {/* Lock indicator badges for locked elements */}
                        {resolvedElements.filter(el => el.isLocked && selectedIdsSet.has(el.id)).map(el => (
                            <LockBadge key={`lock-${el.id}`} element={el} scale={viewport.scale} />
                        ))}

                        {/* Remote collaboration cursors */}
                        {peers.length > 0 && (
                            <CursorOverlay
                                peers={peers}
                                viewport={viewport}
                                stageWidth={dimensions.width}
                                stageHeight={dimensions.height}
                                elements={resolvedElements}
                            />
                        )}
                    </Layer>
                </Stage>

                {/* Text HTML Overlay — markdown rendering + editing */}
                <TextHtmlOverlay
                    viewport={viewport}
                    autoEditTextId={autoEditTextId}
                    onEditStart={handleTextEditStart}
                    onEditEnd={handleTextEditEnd}
                    onChange={handleElementChange}
                />
            </div>

            {/* Context Menu */}
            {contextMenu && (
                renderContextMenu ? (
                    renderContextMenu({
                        selectedIds,
                        elements,
                        position: contextMenu,
                        close: () => setContextMenu(null),
                    })
                ) : (
                    <ContextMenu
                        x={contextMenu.x}
                        y={contextMenu.y}
                        items={contextMenuItems}
                        onClose={() => setContextMenu(null)}
                        theme={theme}
                    />
                )
            )}

            {/* Custom Annotations Overlay */}
            {renderAnnotation && (
                <AnnotationsOverlay
                    elements={resolvedElements}
                    viewport={viewport}
                    containerWidth={dimensions.width}
                    containerHeight={dimensions.height}
                    renderAnnotation={renderAnnotation}
                />
            )}

            {/* Status Bar */}
            {showStatusBar && <StatusBar theme={theme} />}
        </div>
        </WorkerConfigContext.Provider>
        </CanvasStoreProvider>
    );
});

FlowCanvas.displayName = 'FlowCanvas';

// ─── Status Bar ─────────────────────────────────────────────
// Uses granular Zustand selectors so it only re-renders when its
// specific data changes — not on every element update.
const StatusBar: React.FC<{ theme: typeof DEFAULT_THEME }> = React.memo(({ theme }) => {
    const useCanvasStore = useCanvasStoreInstance();
    // Count only "logical" elements — bound text (containerId != null) is
    // part of its parent shape, not a separate user-visible element.
    const elementCount = useCanvasStore((s) =>
        s.elements.filter(el => !(el.type === 'text' && (el as TextElement).containerId)).length
    );
    const activeTool = useCanvasStore((s) => s.activeTool);
    const selectedCount = useCanvasStore((s) => {
        const els = s.elements;
        // Exclude bound text from the selected count — selecting a shape
        // with bound text may include the text id internally but the user
        // perceives it as one element.
        return s.selectedIds.filter(id => {
            const el = els.find(e => e.id === id);
            return el && !(el.type === 'text' && (el as TextElement).containerId);
        }).length;
    });

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 16,
                left: 12,
                zIndex: 50,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: theme.toolbarBg,
                backdropFilter: 'blur(8px)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                borderRadius: 8,
                padding: '4px 12px',
                border: `1px solid ${theme.toolbarBorder}`,
                fontSize: 11,
                color: theme.mutedTextColor,
                userSelect: 'none',
            }}
        >
            <span>
                Tool: <strong style={{ color: theme.textColor, textTransform: 'capitalize' }}>{activeTool}</strong>
            </span>
            <span style={{ opacity: 0.4 }}>|</span>
            <span>
                Elements: <strong style={{ color: theme.textColor }}>{elementCount}</strong>
            </span>
            {selectedCount > 0 && (
                <>
                    <span style={{ opacity: 0.4 }}>|</span>
                    <span>
                        Selected: <strong style={{ color: theme.activeToolColor }}>{selectedCount}</strong>
                    </span>
                </>
            )}
        </div>
    );
});

export default FlowCanvas;
