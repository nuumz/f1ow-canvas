import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useCallback,
    useState,
} from 'react';
import { Stage, Layer, Line as KonvaLine, Group as KonvaGroup, Rect as KonvaRect, Path as KonvaPath } from 'react-konva';
import Konva from 'konva';

// ─── Konva global configuration ──────────────────────────────
// Disable runtime warnings — avoids console.warn + string-format overhead
// in hot paths (drawing, drag). Safe for a well-tested production app.
Konva.showWarnings = false;

import { useCanvasStore } from '../store/useCanvasStore';
import { useLinearEditStore } from '../store/useLinearEditStore';
import type {
    CanvasElement as CanvasElementType,
    Point,
    LineElement,
    ArrowElement,
    TextElement,
    ToolType,
    SnapTarget,
    Binding,
} from '../types';
import { generateId } from '../utils/id';
import { snapToGrid } from '../utils/geometry';
import {
    recomputeBoundPoints,
    findConnectorsForElement,
    syncBoundElements,
} from '../utils/connection';
import { MIN_ZOOM, MAX_ZOOM, DEFAULT_STYLE, TOOLS, GRID_SIZE } from '../constants';
import { computeCurveControlPoint, quadBezierAt, CURVE_RATIO } from '../utils/curve';
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
import { computeAlignGuides } from '../utils/alignment';
import type { AlignGuide } from '../utils/alignment';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useViewportCulling } from '../hooks/useViewportCulling';
import { useSpatialIndex } from '../hooks/useSpatialIndex';
import { useEfficientZoom } from '../hooks/useEfficientZoom';
import { useProgressiveRender } from '../hooks/useProgressiveRender';
import { rafThrottle, toSet } from '../utils/performance';
import { disposeElbowWorkerManager } from '../utils/elbowWorkerManager';
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

import type { FlowCanvasProps, FlowCanvasRef, ContextMenuContext } from './FlowCanvasProps';
import { DEFAULT_THEME } from './FlowCanvasProps';
import { useCollaboration } from '../collaboration/useCollaboration';
import CursorOverlay from '../collaboration/CursorOverlay';
import { WorkerConfigContext } from '../contexts/WorkerConfigContext';

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
    useEffect(() => {
        const layer = layerRef.current;
        if (!layer || elements.length === 0) return;

        // Always cache at native device resolution so elements look crisp
        // at any zoom level. The layer's transform (scale from viewport) is
        // applied on top of the cached bitmap, so we don't need to scale the
        // pixel ratio with zoom — the bitmap already reflects world-space
        // coordinates and Konva scales it to screen during compositing.
        const dpr = window.devicePixelRatio || 1;
        // Multiply by viewportScale to ensure the cached bitmap has enough resolution when zoomed in
        const cachePixelRatio = dpr * Math.max(1, viewportScale);

        // Wait one frame for react-konva to finish drawing children
        const rafId = requestAnimationFrame(() => {
            if (!layerRef.current) return;

            // Konva's layer.cache({pixelRatio}) internally calls
            // getClientRect({skipTransform: true}) to size its offscreen canvas.
            // We must use the same world-space rect for the guard so that the
            // check and the actual bitmap allocation agree.
            // (Using screen-space here would make the check 2–4× smaller than
            // the bitmap Konva actually creates, allowing silent failures when
            // the world extent × pixelRatio exceeds the browser canvas limit.)
            const rect = layer.getClientRect({ skipTransform: true });  // world-space
            const MAX_CACHE_DIM = 8192;

            // Guard: skip caching if the resulting bitmap would be too large
            // or has zero extent (nothing visible).
            const bitmapW = rect.width  * cachePixelRatio;
            const bitmapH = rect.height * cachePixelRatio;

            if (bitmapW > MAX_CACHE_DIM || bitmapH > MAX_CACHE_DIM || rect.width <= 0 || rect.height <= 0) {
                // Too large to cache — render children directly (no bitmap).
                // batchDraw() is required here so Konva repaints the layer
                // from its children instead of showing a stale (or blank)
                // cached bitmap from a previous state.
                layer.clearCache();
                layer.batchDraw();
                return;
            }

            layer.cache({ pixelRatio: cachePixelRatio });
            layer.batchDraw();
        });

        return () => {
            cancelAnimationFrame(rafId);
            layer.clearCache();
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
        collaboration: collaborationConfig,
        workerConfig,
        customElementTypes,
    } = props;

    const theme = { ...DEFAULT_THEME, ...themeProp };

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
    const { peers, updateCursor: collabUpdateCursor } = useCollaboration(collaborationConfig ?? null);

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

    // Shift key tracking (for symmetric / angle-constrained drawing)
    const shiftKeyRef = useRef(false);

    // Right-click tracking — Konva fires `click` for right-click too
    // (unlike DOM click which is left-button only). We need to suppress
    // handleElementSelect during right-click so it doesn't destroy
    // multi-selection before the context menu opens.
    const isRightClickRef = useRef(false);

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

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.type !== 'line' && el.type !== 'arrow') {
                if (result) result[i] = el;
                continue;
            }
            const conn = el as LineElement | ArrowElement;
            if (!conn.startBinding && !conn.endBinding) {
                if (result) result[i] = el;
                continue;
            }
            // Skip: connector being point-dragged — let the drag control its position
            if (isLinearDragging && linearEditId === el.id) {
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
            } else {
                if (result) result[i] = el;
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
            if (expanded.size !== effectiveSelected.size) {
                effectiveSelected = expanded;
            }
        }

        const statics: CanvasElementType[] = [];
        const interactive: CanvasElementType[] = [];
        for (const el of visibleElements) {
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
    }, [visibleElements, selectedIdsSet, drawingElementId]);

    // ─── Performance: progressive rendering for static layer ──
    // When the static layer has a large number of elements, render
    // them in batches across multiple frames to keep the UI responsive.
    // Interactive elements always render immediately (full interactivity).
    const { visibleElements: progressiveStaticElements } = useProgressiveRender(
        staticElements,
        { batchSize: 500, threshold: 500, enabled: true },
    );

    // ─── Keyboard Shortcuts ────────────────────────────────────
    // Always call the hook (Rules of Hooks) — pass enabled flag
    useKeyboardShortcuts(enableShortcuts && !readOnly, containerRef);

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
    // Enter is handled synchronously in handleElementSelect.
    // This effect covers edge cases: selection-box, Ctrl+A, tool change, etc.
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
            return;
        }

        // Auto-enter for creation path (line created → setActiveTool('select'))
        // When the line is selected and activeTool just became 'select',
        // the synchronous path didn’t run because it went through setSelectedIds
        // + setActiveTool (not handleElementSelect). Enter now.
        const el = elements.find(e => e.id === selectedIds[0]);
        if (el && (el.type === 'line' || el.type === 'arrow')) {
            if (!linState.isEditing || linState.elementId !== el.id) {
                linState.enterEditMode(el.id);
            }
        }
    }, [selectedIds, activeTool, elements]);

    // Shift key listener (for symmetric drawing)
    useEffect(() => {
        const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftKeyRef.current = true; };
        const onUp = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftKeyRef.current = false; };
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, []);

    // Space key listener (hold Space to pan)
    useEffect(() => {
        const onDown = (e: KeyboardEvent) => {
            // Skip if typing in an input/textarea
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
            const stage = stageRef.current;
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
            // Skip if typing in an input/textarea
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

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
        setIsDrawing,
        setDrawStart,
        pushHistory,
        getPointerPos,
        snapPos,
        currentElementIdRef,
        shiftKeyRef,
        startBindingRef,
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
        [readOnly, contextMenu, isSpacePanning]
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
            disposeElbowWorkerManager();
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

            const scaleBy = 1.05;
            const dir = e.evt.deltaY > 0 ? -1 : 1;
            const targetScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM,
                dir > 0 ? viewport.scale * scaleBy : viewport.scale / scaleBy
            ));
            setViewport(zoomAtPoint({ viewport, point: pointer, targetScale }));
        },
        [viewport, setViewport]
    );

    const handleStageDragEnd = useCallback(
        (e: Konva.KonvaEventObject<DragEvent>) => {
            if (activeTool !== 'hand' && !spaceKeyRef.current && !isSpacePanning) return;
            setViewport({ x: e.target.x(), y: e.target.y() });
        },
        [activeTool, setViewport, isSpacePanning]
    );

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

            // Synchronous enter/exit linear edit mode — avoids 1-frame
            // flash of SelectionTransformer on line/arrow elements.
            const el = elements.find(e => e.id === id);
            const isLinear = el && (el.type === 'line' || el.type === 'arrow');

            const linearState = useLinearEditStore.getState();
            if (isLinear) {
                // Enter edit mode immediately (before render)
                if (!linearState.isEditing || linearState.elementId !== id) {
                    linearState.enterEditMode(id);
                }
            } else {
                // Exit edit mode if selecting a non-linear element
                if (linearState.isEditing) {
                    linearState.exitEditMode();
                }
            }

            // Group-aware selection: select all members of the outermost group
            if (el?.groupIds?.length) {
                const outermostGroupId = el.groupIds[el.groupIds.length - 1];
                const groupMembers = elements
                    .filter(e => e.groupIds?.includes(outermostGroupId))
                    .map(e => e.id);
                setSelectedIds(groupMembers);
            } else {
                setSelectedIds([id]);
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
    /** Track whether Konva.pixelRatio has been reduced during drag */
    const savedPixelRatioRef = useRef<number | null>(null);

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
    const handleElementDragMove = useCallback(
        (id: string, updates: Partial<CanvasElementType>) => {
            if (readOnly) return;

            // ─── Reduce pixelRatio during drag ────────────────
            // Cuts draw cost ~50% on Retina displays (4× fewer pixels).
            // Restored on dragEnd in handleElementChange / flushDragEndBatch.
            if (savedPixelRatioRef.current === null) {
                savedPixelRatioRef.current = Konva.pixelRatio;
                Konva.pixelRatio = 1;
            }

            const { elements, selectedIds } = useCanvasStore.getState();

            // ─── Multi-select fast path ───────────────────────
            // When many elements are selected, skip store writes.
            // Konva handles visual positioning natively — the nodes
            // are already at the correct screen position.  Syncing
            // to React state on every frame causes O(n) cascading
            // recomputation that dominates frame time with 1K+ elements.
            if (selectedIds.length > MULTI_DRAG_STORE_SKIP_THRESHOLD) {
                isMultiDragSkippingRef.current = true;
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

            // ─── Buffer into batch ────────────────────────────
            if (!dragBatchRef.current) dragBatchRef.current = new Map();
            dragBatchRef.current.set(id, updates);

            // Schedule flush via microtask (runs after all sync onDragMove
            // callbacks in the same frame, but before the next paint).
            if (!dragFlushScheduledRef.current) {
                dragFlushScheduledRef.current = true;
                queueMicrotask(flushDragBatch);
            }
        },
        [readOnly, flushDragBatch]
    );

    // Alignment snap callback: shapes call this during drag to get snapped position + show guides
    // PERF: Skip alignment computation during multi-select drag.
    // Each selected shape independently calls this callback during drag,
    // resulting in N × O(total) computeAlignGuides calls per frame.
    // Alignment snapping for multi-drag is also semantically wrong
    // (you want to snap the group, not individual shapes).
    const handleDragSnap = useCallback(
        (id: string, bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number } | null => {
            const { elements: els, selectedIds: selIds } = useCanvasStore.getState();

            // Skip when dragging multiple elements — each would compute
            // independently (wrong) and the O(n²) cost is prohibitive
            if (selIds.length > 1) return null;

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
        // Build O(1) element lookup once (avoids N² .find() calls).
        // Track recomputed connector IDs to avoid duplicates when
        // two adjacent shapes share the same connector.
        const freshElements = useCanvasStore.getState().elements;
        const elMap = new Map<string, CanvasElementType>();
        for (const el of freshElements) elMap.set(el.id, el);

        const connectorUpdates: Array<{ id: string; updates: Partial<CanvasElementType> }> = [];
        const processedConnectors = new Set<string>();

        for (const [id] of entries) {
            unboundConnectorIdsRef.current.delete(id);

            // Connector recomputation (deduplicated)
            const connectors = findConnectorsForElement(id, freshElements);
            for (const conn of connectors) {
                if (processedConnectors.has(conn.id)) continue;
                processedConnectors.add(conn.id);
                const freshConn = elMap.get(conn.id) as LineElement | ArrowElement | undefined;
                if (!freshConn) continue;
                const recomputed = recomputeBoundPoints(freshConn, freshElements);
                if (recomputed) connectorUpdates.push({ id: freshConn.id, updates: recomputed });
            }

            // Bound text sync
            const el = elMap.get(id);
            if (el?.boundElements && ['rectangle', 'ellipse', 'diamond', 'image'].includes(el.type)) {
                const PADDING = 4;
                for (const be of el.boundElements) {
                    if (be.type !== 'text') continue;
                    const txt = elMap.get(be.id) as TextElement | undefined;
                    if (!txt) continue;
                    const tw = Math.max(20, el.width - PADDING * 2);
                    let ty: number;
                    if (txt.verticalAlign === 'top') ty = el.y + PADDING;
                    else if (txt.verticalAlign === 'bottom') ty = el.y + el.height - txt.height - PADDING;
                    else ty = el.y + (el.height - txt.height) / 2;
                    connectorUpdates.push({ id: be.id, updates: { x: el.x + PADDING, y: ty, width: tw } });
                }
            }
        }

        // Apply all connector/text updates in a single batch
        if (connectorUpdates.length > 0) {
            useCanvasStore.getState().batchUpdateElements(connectorUpdates);
        }

        // Single history push for the entire drag operation
        useCanvasStore.getState().pushHistory();

        // Restore full pixelRatio after drag completes
        if (savedPixelRatioRef.current !== null) {
            Konva.pixelRatio = savedPixelRatioRef.current;
            savedPixelRatioRef.current = null;
        }
    }, []);

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

            // Build fresh element list & O(1) Map for subsequent lookups
            // (avoids repeated .find() calls which are O(n) each)
            const freshElements = useCanvasStore.getState().elements;
            const elMap = new Map<string, CanvasElementType>();
            for (const e of freshElements) elMap.set(e.id, e);

            // Persist final connector points on drag-end (for serialization)
            const connectors = findConnectorsForElement(id, freshElements);
            for (const conn of connectors) {
                const freshConn = elMap.get(conn.id) as LineElement | ArrowElement | undefined;
                if (!freshConn) continue;
                const recomputed = recomputeBoundPoints(freshConn, freshElements);
                if (recomputed) updateElement(freshConn.id, recomputed);
            }

            // ─── Sync bound text stored coords when shape container changes ──
            const el = elMap.get(id);
            if (el?.boundElements && ['rectangle', 'ellipse', 'diamond', 'image'].includes(el.type)) {
                const PADDING = 4;
                for (const be of el.boundElements) {
                    if (be.type !== 'text') continue;
                    const txt = elMap.get(be.id) as TextElement | undefined;
                    if (!txt) continue;
                    const tw = Math.max(20, el.width - PADDING * 2);
                    let ty: number;
                    if (txt.verticalAlign === 'top') ty = el.y + PADDING;
                    else if (txt.verticalAlign === 'bottom') ty = el.y + el.height - txt.height - PADDING;
                    else ty = el.y + (el.height - txt.height) / 2;
                    updateElement(be.id, { x: el.x + PADDING, y: ty, width: tw });
                }
            }

            // ─── Auto-resize container height when bound text grows ──────────
            if (el?.type === 'text') {
                const txt = el as TextElement;
                if (txt.containerId) {
                    const ctr = elMap.get(txt.containerId);
                    if (ctr && ['rectangle', 'ellipse', 'diamond', 'image'].includes(ctr.type)) {
                        const PADDING = 4;
                        const minH = txt.height + PADDING * 2;
                        if (ctr.height < minH) {
                            updateElement(ctr.id, { height: minH });
                            // Recompute connectors for the resized container
                            // (refresh elements after updateElement above)
                            const updatedElements = useCanvasStore.getState().elements;
                            for (const c of findConnectorsForElement(ctr.id, updatedElements)) {
                                const fc = updatedElements.find(e => e.id === c.id) as LineElement | ArrowElement | undefined;
                                if (!fc) continue;
                                const r = recomputeBoundPoints(fc, updatedElements);
                                if (r) updateElement(fc.id, r);
                            }
                        }
                    }
                }
            }

            pushHistory();

            // Restore full pixelRatio after drag completes
            if (savedPixelRatioRef.current !== null) {
                Konva.pixelRatio = savedPixelRatioRef.current;
                savedPixelRatioRef.current = null;
            }
        },
        [updateElement, pushHistory, readOnly, flushDragEndBatch]
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
            const elMap = new Map<string, CanvasElementType>();
            for (const el of freshElements) elMap.set(el.id, el);

            const memberIds = new Set(members.map(m => m.id));
            const connectorUpdates: Array<{ id: string; updates: Partial<CanvasElementType> }> = [];
            const processedConnectors = new Set<string>();

            for (const member of members) {
                // Recompute connectors attached to moved shapes (deduplicated)
                const connectors = findConnectorsForElement(member.id, freshElements);
                for (const conn of connectors) {
                    if (processedConnectors.has(conn.id)) continue;
                    processedConnectors.add(conn.id);
                    // Skip connectors that are INSIDE the group (they already moved)
                    if (memberIds.has(conn.id)) continue;
                    const freshConn = elMap.get(conn.id) as LineElement | ArrowElement | undefined;
                    if (!freshConn) continue;
                    const recomputed = recomputeBoundPoints(freshConn, freshElements);
                    if (recomputed) connectorUpdates.push({ id: freshConn.id, updates: recomputed });
                }

                // Sync bound text positions
                const el = elMap.get(member.id);
                if (el?.boundElements && ['rectangle', 'ellipse', 'diamond', 'image'].includes(el.type)) {
                    const PADDING = 4;
                    for (const be of el.boundElements) {
                        if (be.type !== 'text') continue;
                        // Skip if bound text is also in the group (already moved)
                        if (memberIds.has(be.id)) continue;
                        const txt = elMap.get(be.id) as TextElement | undefined;
                        if (!txt) continue;
                        const tw = Math.max(20, el.width - PADDING * 2);
                        let ty: number;
                        if (txt.verticalAlign === 'top') ty = el.y + PADDING;
                        else if (txt.verticalAlign === 'bottom') ty = el.y + el.height - txt.height - PADDING;
                        else ty = el.y + (el.height - txt.height) / 2;
                        connectorUpdates.push({ id: be.id, updates: { x: el.x + PADDING, y: ty, width: tw } });
                    }
                }
            }

            if (connectorUpdates.length > 0) {
                useCanvasStore.getState().batchUpdateElements(connectorUpdates);
            }

            store.pushHistory();
        },
        [readOnly]
    );

    // ─── Double-click: linear edit OR create bound text ─────────
    const handleElementDoubleClick = useCallback(
        (id: string) => {
            if (readOnly) return;
            const { activeTool: tool, elements: els, currentStyle: style,
                    addElement: add, updateElement: update, setSelectedIds: setSel,
            } = useCanvasStore.getState();
            if (tool !== 'select') return;
            const el = els.find((e) => e.id === id);
            if (!el) return;

            // Let consumer intercept — return true to prevent default
            if (onElementDoubleClick?.(id, el) === true) return;

            // Linear elements → create/edit text label (point edit via single click)
            if (el.type === 'line' || el.type === 'arrow') {
                // Check if already has a bound text element
                const existingTextBinding = el.boundElements?.find(be => be.type === 'text');
                if (existingTextBinding) {
                    setSel([existingTextBinding.id]);
                    setAutoEditTextId(existingTextBinding.id);
                    return;
                }

                // Create new bound text at midpoint
                const textId = generateId();
                const conn = el as LineElement | ArrowElement;
                const pts = conn.points;
                const startPt = { x: pts[0], y: pts[1] };
                const endPt = { x: pts[pts.length - 2], y: pts[pts.length - 1] };

                let midX: number, midY: number;
                if (conn.lineType === 'curved') {
                    const cp = computeCurveControlPoint(startPt, endPt, (conn as ArrowElement).curvature ?? CURVE_RATIO);
                    const mid = quadBezierAt(startPt, cp, endPt, 0.5);
                    midX = conn.x + mid.x;
                    midY = conn.y + mid.y;
                } else {
                    midX = conn.x + (startPt.x + endPt.x) / 2;
                    midY = conn.y + (startPt.y + endPt.y) / 2;
                }

                const textEl: TextElement = {
                    id: textId,
                    type: 'text',
                    x: midX,
                    y: midY,
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
                };

                add(textEl);
                onElementCreate?.(textEl);

                const currentBound = el.boundElements ?? [];
                update(id, {
                    boundElements: [...currentBound, { id: textId, type: 'text' }],
                });

                setSel([textId]);
                setAutoEditTextId(textId);
                return;
            }

            // Shape elements (rect, ellipse, diamond) → create/edit bound text
            if (el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond' || el.type === 'image') {
                // Check if already has a bound text element
                const existingTextBinding = el.boundElements?.find(be => be.type === 'text');
                if (existingTextBinding) {
                    // Focus existing bound text for editing
                    setSel([existingTextBinding.id]);
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
                setSel([textId]);
                setAutoEditTextId(textId);
                return;
            }
        },
        [readOnly, onElementDoubleClick, onElementCreate],
    );

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
            // Auto-delete empty text elements
            if (isEmpty) {
                const { elements: els, updateElement: update, deleteElements: del, pushHistory: push } = useCanvasStore.getState();
                // If bound text, also remove the reference from the container
                const textEl = els.find(e => e.id === id);
                if (textEl?.type === 'text' && (textEl as TextElement).containerId) {
                    const containerId = (textEl as TextElement).containerId!;
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
    }));

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
        <WorkerConfigContext.Provider value={workerConfigValue}>
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

                    {/* Static Layer: non-selected elements — memoized wrapper skips
                        entire subtree when static content hasn't changed (e.g. during
                        drag of selected element, context menu, selection box, etc.) */}
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
                            const editEl = resolvedElementMap.get(
                                linearEdit.elementId ?? '',
                            ) as LineElement | ArrowElement | undefined;
                            if (!editEl) return null;
                            return (
                                <LinearElementHandles
                                    element={editEl}
                                    allElements={resolvedElements}
                                    onPointsChange={handleLinearPointsChange}
                                    onPointDragMove={handleLinearPointDragMove}
                                    onSnapTargetChange={handleLinearSnapTargetChange}
                                    color={theme.selectionColor}
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

            {/* Status Bar */}
            {showStatusBar && <StatusBar theme={theme} />}
        </div>
        </WorkerConfigContext.Provider>
    );
});

FlowCanvas.displayName = 'FlowCanvas';

// ─── Status Bar ─────────────────────────────────────────────
// Uses granular Zustand selectors so it only re-renders when its
// specific data changes — not on every element update.
const StatusBar: React.FC<{ theme: typeof DEFAULT_THEME }> = React.memo(({ theme }) => {
    const elementCount = useCanvasStore((s) => s.elements.length);
    const activeTool = useCanvasStore((s) => s.activeTool);
    const selectedCount = useCanvasStore((s) => s.selectedIds.length);

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
