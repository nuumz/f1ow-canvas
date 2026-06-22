import { create } from 'zustand';
import type {
    CanvasElement,
    ElementStyle,
    ElementType,
    ToolType,
    ViewportState,
    Point,
    LineType,
    Arrowhead,
} from '@/types';
import { DEFAULT_STYLE } from '@/constants';
import { clearBindingsForDeletedElements } from '@/utils/connection';
import { syncAfterDrag } from '@/utils/dragSync';
import { generateId } from '@/utils/id';
import { elementRegistry } from '@/utils/elementRegistry';
import { cloneAndRemapElements } from '@/utils/clone';
import {
    zoomAtPoint,
    getNextZoomStep,
    getPrevZoomStep,
    getElementsBounds,
    computeZoomToFit,
    animateViewport,
    cancelViewportAnimation,
} from '@/utils/camera';

// ─── Geometry field detection ─────────────────────────────────

/** Fields that affect element geometry — changing any of these bumps `version` */
const GEOMETRY_KEYS = new Set<string>([
    'x', 'y', 'width', 'height', 'rotation', 'ports', 'points',
    'cornerRadius', 'radiusX', 'radiusY',
]);

// ─── Z-order helpers ──────────────────────────────────────────

/**
 * Expand a set of element ids to include any text elements bound to those
 * shapes (via `containerId`). Ensures that z-order operations keep
 * shape-bound labels on top of their container.
 */
function expandWithBoundChildren(
    ids: string[],
    elements: CanvasElement[],
): Set<string> {
    const idSet = new Set(ids);
    for (const el of elements) {
        if (el.type === 'text' && el.containerId && idSet.has(el.containerId)) {
            idSet.add(el.id);
        }
    }
    return idSet;
}

// ─── History Entry ────────────────────────────────────────────

/** Single element diff: tracks what changed for one element */
interface ElementDiff {
    type: 'add' | 'modify' | 'delete';
    elementId: string;
    /** Element state before the change (for modify/delete) */
    before?: CanvasElement;
    /** Element state after the change (for add/modify) */
    after?: CanvasElement;
}

/**
 * Diff-based history entry.
 * Instead of storing full snapshots, we only store what changed.
 * This drastically reduces memory usage for large canvases.
 */
interface HistoryEntry {
    diffs: ElementDiff[];
    /** Element order before this entry, used to restore z-order changes. */
    beforeOrder?: string[];
    /** Element order after this entry, used to redo z-order changes. */
    afterOrder?: string[];
    /** Optional named mark/checkpoint for grouping */
    mark?: string;
    /** Timestamp for squash heuristics */
    timestamp: number;
}

type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';
type FlipAxis = 'horizontal' | 'vertical';

// ─── Store State ──────────────────────────────────────────────
interface CanvasState {
    // Elements
    elements: CanvasElement[];
    selectedIds: string[];

    // Tool
    activeTool: ToolType;
    /** Excalidraw-style "keep selected tool active after drawing" (Q). */
    toolLocked: boolean;
    currentStyle: ElementStyle;

    // Linear tool defaults (arrow/line)
    currentLineType: LineType;
    currentStartArrowhead: Arrowhead | null;
    currentEndArrowhead: Arrowhead | null;

    // Viewport (pan & zoom)
    viewport: ViewportState;

    // Drawing state
    isDrawing: boolean;
    drawStart: Point | null;

    // History (undo/redo) — diff-based
    history: HistoryEntry[];
    historyIndex: number;
    /** Baseline snapshot for computing diffs against current state */
    _historyBaseline: Map<string, CanvasElement>;
    /** Baseline element order for z-order history. */
    _historyOrderBaseline: string[];
    /** Whether history recording is temporarily paused */
    _historyPaused: boolean;

    // Grid
    showGrid: boolean;

    // ─── Actions ──────────────────────────────────────────────
    // Elements
    addElement: (element: CanvasElement) => void;
    updateElement: (id: string, updates: Partial<CanvasElement>) => void;
    /** Batch-update multiple elements in a single store write.
     *  Dramatically reduces re-renders when dragging N selected elements
     *  (1 array allocation instead of N per frame). */
    batchUpdateElements: (updates: Array<{ id: string; updates: Partial<CanvasElement> }>) => void;
    deleteElements: (ids: string[]) => void;
    setElements: (elements: CanvasElement[]) => void;
    duplicateElements: (ids: string[]) => void;
    convertElementType: (ids: string[], targetType: ElementType) => void;
    bringToFront: (ids: string[]) => void;
    sendToBack: (ids: string[]) => void;
    bringForward: (ids: string[]) => void;
    sendBackward: (ids: string[]) => void;

    // Transforms
    alignElements: (ids: string[], mode: AlignMode) => void;
    rotateElements: (ids: string[], deltaDegrees: number) => void;
    flipElements: (ids: string[], axis: FlipAxis) => void;

    // Lock
    toggleLockElements: (ids: string[]) => void;

    // Grouping
    groupElements: (ids: string[]) => void;
    ungroupElements: (ids: string[]) => void;

    // Selection
    setSelectedIds: (ids: string[]) => void;
    clearSelection: () => void;

    // Tool
    setActiveTool: (tool: ToolType) => void;
    /** Toggle tool-lock (keep tool active after drawing). */
    toggleToolLock: () => void;
    /** Called by drawing tools on commit: revert to 'select' unless tool-lock is on.
     *  Does NOT touch selectedIds, so the just-created element stays selected. */
    commitTool: () => void;
    setCurrentStyle: (style: Partial<ElementStyle>) => void;
    setCurrentLineType: (lineType: LineType) => void;
    setCurrentStartArrowhead: (arrowhead: Arrowhead | null) => void;
    setCurrentEndArrowhead: (arrowhead: Arrowhead | null) => void;

    // Viewport
    setViewport: (viewport: Partial<ViewportState>) => void;
    /**
     * Zoom in one step. If `center` is provided (screen-space point),
     * zoom toward that point; otherwise zoom toward viewport center.
     */
    zoomIn: (center?: { x: number; y: number }, options?: { animate?: boolean }) => void;
    /**
     * Zoom out one step. If `center` is provided (screen-space point),
     * zoom toward that point; otherwise zoom toward viewport center.
     */
    zoomOut: (center?: { x: number; y: number }, options?: { animate?: boolean }) => void;
    resetZoom: (options?: { animate?: boolean }) => void;
    /**
     * Zoom the viewport to fit all elements (or specific IDs).
     * Requires stageWidth/stageHeight to calculate proper fit.
     */
    zoomToFit: (stageWidth: number, stageHeight: number, ids?: string[], options?: { padding?: number; maxZoom?: number; animate?: boolean }) => void;
    /**
     * Zoom the viewport to fit currently selected elements.
     */
    zoomToSelection: (stageWidth: number, stageHeight: number, options?: { padding?: number; maxZoom?: number; animate?: boolean }) => void;

    // Drawing
    setIsDrawing: (isDrawing: boolean) => void;
    setDrawStart: (point: Point | null) => void;

    // History
    pushHistory: (mark?: string) => void;
    undo: () => void;
    redo: () => void;
    /** Squash the last N history entries into one (for continuous ops like drag) */
    squashHistory: (count?: number) => void;
    /** Pause history recording (for batch operations) */
    pauseHistory: () => void;
    /** Resume history recording */
    resumeHistory: () => void;
    /** Check if history can undo */
    canUndo: () => boolean;
    /** Check if history can redo */
    canRedo: () => boolean;

    // Grid
    toggleGrid: () => void;
}

const MAX_HISTORY = 100;

/**
 * Efficiently deep-clone a single element for history storage.
 * Image elements share the `src` string reference to avoid
 * duplicating large base64 data.
 */
function cloneElement(el: CanvasElement): CanvasElement {
    if (el.type === 'image' && 'src' in el) {
        const { src, ...rest } = el as import('@/types').ImageElement;
        const cloned = structuredClone(rest);
        (cloned as any).src = src;
        return cloned as CanvasElement;
    }
    return structuredClone(el);
}

function orderOf(elements: CanvasElement[]): string[] {
    return elements.map((el) => el.id);
}

function sameOrder(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, index) => id === b[index]);
}

function restoreOrder(elements: CanvasElement[], order: string[]): CanvasElement[] {
    const byId = new Map(elements.map((el) => [el.id, el]));
    const ordered: CanvasElement[] = [];
    for (const id of order) {
        const el = byId.get(id);
        if (el) {
            ordered.push(el);
            byId.delete(id);
        }
    }
    for (const el of elements) {
        if (byId.has(el.id)) ordered.push(el);
    }
    return ordered;
}

function validSelectedIds(selectedIds: string[], elements: CanvasElement[]): string[] {
    const existingIds = new Set(elements.map((el) => el.id));
    return selectedIds.filter((id) => existingIds.has(id));
}

function selectedEditableElements(ids: string[], elements: CanvasElement[]): CanvasElement[] {
    const idSet = new Set(ids);
    return elements.filter((el) => idSet.has(el.id) && !el.isLocked);
}

function elementBounds(el: CanvasElement): { minX: number; minY: number; maxX: number; maxY: number } {
    if ((el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') && el.points.length >= 2) {
        let minLocalX = Infinity;
        let minLocalY = Infinity;
        let maxLocalX = -Infinity;
        let maxLocalY = -Infinity;
        for (let i = 0; i < el.points.length; i += 2) {
            minLocalX = Math.min(minLocalX, el.points[i]);
            minLocalY = Math.min(minLocalY, el.points[i + 1]);
            maxLocalX = Math.max(maxLocalX, el.points[i]);
            maxLocalY = Math.max(maxLocalY, el.points[i + 1]);
        }
        return {
            minX: el.x + minLocalX,
            minY: el.y + minLocalY,
            maxX: el.x + maxLocalX,
            maxY: el.y + maxLocalY,
        };
    }

    return {
        minX: el.x,
        minY: el.y,
        maxX: el.x + el.width,
        maxY: el.y + el.height,
    };
}

function boundsOf(elements: CanvasElement[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (elements.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
        const bounds = elementBounds(el);
        minX = Math.min(minX, bounds.minX);
        minY = Math.min(minY, bounds.minY);
        maxX = Math.max(maxX, bounds.maxX);
        maxY = Math.max(maxY, bounds.maxY);
    }
    return { minX, minY, maxX, maxY };
}

function normalizeRotation(rotation: number): number {
    return ((rotation % 360) + 360) % 360;
}

function flipPoints(points: number[] | undefined, min: number, max: number, axisOffset: 0 | 1): number[] | undefined {
    if (!points) return undefined;
    return points.map((value, index) => (index % 2 === axisOffset ? min + max - value : value));
}

/**
 * Run `syncAfterDrag` against a store snapshot and apply any resulting
 * binding/text-position updates via `batchUpdateElements`. Pulls state from
 * the supplied `get()` so the helper works with any store instance produced
 * by `createCanvasStore()` rather than the module-level singleton.
 */
function syncMovedElements(ids: Iterable<string>, get: () => CanvasState) {
    const state = get();
    const sync = syncAfterDrag(ids, state.elements);
    if (sync.updates.length > 0) {
        state.batchUpdateElements(sync.updates);
    }
}

/**
 * Factory: create a fresh canvas store instance.
 *
 * Each call returns an independent Zustand store with its own elements,
 * selection, viewport, and history. Use this with `CanvasStoreProvider`
 * to render multiple `<FlowCanvas>` instances side-by-side without state
 * cross-talk on the React subscriber side.
 *
 * Note: the module-level `useCanvasStore` singleton remains exported for
 * backward compatibility and is still used by tools, hooks, and the
 * collaboration sync bridge that read state via `getState()`. Full
 * multi-instance isolation across those subsystems is a follow-up phase.
 */
export type CanvasStore = ReturnType<typeof createCanvasStore>;

export function createCanvasStore() {
    return create<CanvasState>((set, get) => ({
    // ─── Initial State ────────────────────────────────────────
    elements: [],
    selectedIds: [],
    activeTool: 'select',
    toolLocked: false,
    currentStyle: { ...DEFAULT_STYLE },
    currentLineType: 'sharp' as LineType,
    currentStartArrowhead: null,
    currentEndArrowhead: 'arrow' as Arrowhead,
    viewport: { x: 0, y: 0, scale: 1 },
    isDrawing: false,
    drawStart: null,
    history: [],
    historyIndex: -1,
    _historyBaseline: new Map(),
    _historyOrderBaseline: [],
    _historyPaused: false,
    showGrid: false,

    // ─── Element Actions ──────────────────────────────────────
    addElement: (element) => {
        const validation = elementRegistry.validateElement(element);
        if (!validation.valid) {
            if (import.meta.env.DEV) {
                console.warn(`[f1ow] addElement rejected — ${validation.error}`, element);
            }
            return;
        }
        // Apply custom defaults for plugin element types (no-op for built-ins)
        const finalElement = elementRegistry.applyDefaults(element);
        set((state) => ({
            elements: [...state.elements, finalElement],
        }));
        get().pushHistory();
    },

    updateElement: (id, updates) => {
        const updateValidation = elementRegistry.validateUpdate(updates as Record<string, unknown>);
        if (!updateValidation.valid) {
            if (import.meta.env.DEV) {
                console.warn(`[f1ow] updateElement rejected — ${updateValidation.error}`);
            }
            return;
        }
        // Auto-bump version when geometry fields change
        const hasGeometryChange = Object.keys(updates).some(k => GEOMETRY_KEYS.has(k));
        set((state) => {
            const elements = state.elements;
            const idx = elements.findIndex(el => el.id === id);
            if (idx === -1) return state;
            const base = elements[idx];
            const versionBump = hasGeometryChange ? { version: (base.version ?? 0) + 1 } : {};
            const updated = { ...base, ...updates, ...versionBump } as CanvasElement;
            // Reuse array when element reference is identical (no actual change)
            if (updated === base) return state;
            const next = elements.slice();
            next[idx] = updated;
            return { elements: next };
        });
    },

    batchUpdateElements: (batchUpdates) => {
        if (batchUpdates.length === 0) return;
        // Single update — delegate to updateElement (already validated there)
        if (batchUpdates.length === 1) {
            get().updateElement(batchUpdates[0].id, batchUpdates[0].updates);
            return;
        }
        // Pre-validate ALL updates outside the set() callback.
        // Keeping the Zustand reducer pure (no side effects) is important for
        // StrictMode double-invocation and any future time-travel / replay support.
        const validUpdates = batchUpdates.filter(({ id, updates }) => {
            const v = elementRegistry.validateUpdate(updates as Record<string, unknown>);
            if (!v.valid) {
                if (import.meta.env.DEV) {
                    console.warn(`[f1ow] batchUpdateElements: skipping invalid update for "${id}" — ${v.error}`);
                }
                return false;
            }
            return true;
        });
        if (validUpdates.length === 0) return;
        set((state) => {
            const elements = state.elements;
            // Build ID→index lookup for O(1) access
            const idxMap = new Map<string, number>();
            for (let i = 0; i < elements.length; i++) {
                idxMap.set(elements[i].id, i);
            }
            let next: CanvasElement[] | null = null;
            for (const { id, updates } of validUpdates) {
                const idx = idxMap.get(id);
                if (idx === undefined) continue;
                const src = next ? next[idx] : elements[idx];
                const hasGeometryChange = Object.keys(updates).some(k => GEOMETRY_KEYS.has(k));
                const versionBump = hasGeometryChange ? { version: (src.version ?? 0) + 1 } : {};
                const updated = { ...src, ...updates, ...versionBump } as CanvasElement;
                if (updated === src) continue;
                if (!next) next = elements.slice();
                next[idx] = updated;
            }
            return next ? { elements: next } : state;
        });
    },

    deleteElements: (ids) => {
        const deletedSet = new Set(ids);
        // Cascade: also delete any bound text elements owned by deleted containers
        const { elements: current } = get();
        for (const el of current) {
            if (deletedSet.has(el.id) && el.boundElements) {
                for (const be of el.boundElements) {
                    if (be.type === 'text') {
                        deletedSet.add(be.id);
                    }
                }
            }
        }
        // Also delete bound text that references a deleted container (via containerId)
        for (const el of current) {
            if (el.type === 'text' && 'containerId' in el && (el as any).containerId && deletedSet.has((el as any).containerId)) {
                deletedSet.add(el.id);
            }
        }
        set((state) => {
            const remaining = state.elements.filter((el) => !deletedSet.has(el.id));
            // Clear any bindings that reference deleted elements
            const cleaned = clearBindingsForDeletedElements(deletedSet, remaining);
            return {
                elements: cleaned,
                selectedIds: state.selectedIds.filter((id) => !deletedSet.has(id)),
            };
        });
        get().pushHistory();
    },

    setElements: (elements) => {
        // O(1) short-circuit: if this is the exact same array reference already in
        // the store, no change is needed.  This is the common case in controlled mode
        // where the parent echoes back the same array it received from onChange —
        // skipping an unnecessary O(n) validation pass over all elements.
        if (elements === get().elements) return;

        // Validate every element; silently drop (and warn in dev) any that are invalid.
        // This protects against malformed data from importJSON, external setElements calls, etc.
        const valid = elements.filter((el) => {
            const result = elementRegistry.validateElement(el);
            if (!result.valid && import.meta.env.DEV) {
                console.warn(`[f1ow] setElements: removing invalid element — ${result.error}`, el);
            }
            return result.valid;
        });
        // Reset baseline when elements are set directly (initialization, import)
        const baseline = new Map<string, CanvasElement>();
        for (const el of valid) {
            baseline.set(el.id, el);
        }
        set({ elements: valid, _historyBaseline: baseline, _historyOrderBaseline: orderOf(valid) });
    },

    duplicateElements: (ids) => {
        const { elements } = get();
        const originals = elements.filter((el) => ids.includes(el.id));

        const { clones, selectedCloneIds } = cloneAndRemapElements(originals, elements);

        set((state) => ({
            elements: [...state.elements, ...clones],
            selectedIds: selectedCloneIds.length > 0 ? selectedCloneIds : clones.map((d) => d.id),
        }));
        get().pushHistory();
    },

    convertElementType: (ids, targetType) => {
        const shapeTypes = new Set(['rectangle', 'ellipse', 'diamond']);
        if (!shapeTypes.has(targetType)) return;

        set((state) => ({
            elements: state.elements.map((el) => {
                if (!ids.includes(el.id)) return el;
                if (!shapeTypes.has(el.type)) return el; // Can only convert shapes
                if (el.type === targetType) return el;   // Already the target type

                // Strip ALL type-specific fields from the source element so the
                // converted element has a clean schema with no orphaned properties.
                // e.g. rectangle→ellipse must not carry over cornerRadius.
                const { cornerRadius: _cr, ...sharedFields } = el as typeof el & { cornerRadius?: number };
                const base = { ...sharedFields, type: targetType };

                if (targetType === 'rectangle') {
                    return { ...base, cornerRadius: 0 } as CanvasElement;
                }
                // ellipse and diamond have no extra properties beyond BaseElement
                return base as CanvasElement;
            }),
        }));
        get().pushHistory();
    },

    bringToFront: (ids) => {
        set((state) => {
            const fullIds = expandWithBoundChildren(ids, state.elements);
            const others = state.elements.filter((el) => !fullIds.has(el.id));
            const targets = state.elements.filter((el) => fullIds.has(el.id));
            return { elements: [...others, ...targets] };
        });
        get().pushHistory();
    },

    sendToBack: (ids) => {
        set((state) => {
            const fullIds = expandWithBoundChildren(ids, state.elements);
            const others = state.elements.filter((el) => !fullIds.has(el.id));
            const targets = state.elements.filter((el) => fullIds.has(el.id));
            return { elements: [...targets, ...others] };
        });
        get().pushHistory();
    },

    bringForward: (ids) => {
        set((state) => {
            const elems = [...state.elements];
            const idSet = expandWithBoundChildren(ids, state.elements);
            // Move each target one position up (toward end)
            for (let i = elems.length - 2; i >= 0; i--) {
                if (idSet.has(elems[i].id) && !idSet.has(elems[i + 1].id)) {
                    [elems[i], elems[i + 1]] = [elems[i + 1], elems[i]];
                }
            }
            return { elements: elems };
        });
        get().pushHistory();
    },

    sendBackward: (ids) => {
        set((state) => {
            const elems = [...state.elements];
            const idSet = expandWithBoundChildren(ids, state.elements);
            // Move each target one position down (toward start)
            for (let i = 1; i < elems.length; i++) {
                if (idSet.has(elems[i].id) && !idSet.has(elems[i - 1].id)) {
                    [elems[i], elems[i - 1]] = [elems[i - 1], elems[i]];
                }
            }
            return { elements: elems };
        });
        get().pushHistory();
    },

    // ─── Transforms ──────────────────────────────────────────
    alignElements: (ids, mode) => {
        const movedIds: string[] = [];
        set((state) => {
            const targets = selectedEditableElements(ids, state.elements);
            if (targets.length < 2) return state;
            const bounds = boundsOf(targets);
            if (!bounds) return state;
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const centerY = (bounds.minY + bounds.maxY) / 2;
            const targetIds = new Set(targets.map((el) => el.id));
            const targetBounds = new Map(targets.map((el) => [el.id, elementBounds(el)]));
            let changed = false;

            const elements = state.elements.map((el) => {
                if (!targetIds.has(el.id)) return el;
                const elBounds = targetBounds.get(el.id);
                if (!elBounds) return el;
                let x = el.x;
                let y = el.y;
                if (mode === 'left') x += bounds.minX - elBounds.minX;
                if (mode === 'centerH') x += centerX - (elBounds.minX + elBounds.maxX) / 2;
                if (mode === 'right') x += bounds.maxX - elBounds.maxX;
                if (mode === 'top') y += bounds.minY - elBounds.minY;
                if (mode === 'centerV') y += centerY - (elBounds.minY + elBounds.maxY) / 2;
                if (mode === 'bottom') y += bounds.maxY - elBounds.maxY;
                if (x === el.x && y === el.y) return el;
                changed = true;
                movedIds.push(el.id);
                return { ...el, x, y, version: (el.version ?? 0) + 1 } as CanvasElement;
            });

            return changed ? { elements } : state;
        });
        if (movedIds.length > 0) {
            syncMovedElements(movedIds, get);
            get().pushHistory();
        }
    },

    rotateElements: (ids, deltaDegrees) => {
        const movedIds: string[] = [];
        set((state) => {
            const idSet = new Set(ids);
            let changed = false;
            const elements = state.elements.map((el) => {
                if (!idSet.has(el.id) || el.isLocked) return el;
                const rotation = normalizeRotation((el.rotation ?? 0) + deltaDegrees);
                if (rotation === el.rotation) return el;
                changed = true;
                movedIds.push(el.id);
                return { ...el, rotation, version: (el.version ?? 0) + 1 } as CanvasElement;
            });
            return changed ? { elements } : state;
        });
        if (movedIds.length > 0) {
            syncMovedElements(movedIds, get);
            get().pushHistory();
        }
    },

    flipElements: (ids, axis) => {
        const movedIds: string[] = [];
        set((state) => {
            const targets = selectedEditableElements(ids, state.elements);
            if (targets.length === 0) return state;
            const bounds = boundsOf(targets);
            if (!bounds) return state;
            const targetIds = new Set(targets.map((el) => el.id));
            const targetBounds = new Map(targets.map((el) => [el.id, elementBounds(el)]));
            let changed = false;

            const elements = state.elements.map((el) => {
                if (!targetIds.has(el.id)) return el;
                const elBounds = targetBounds.get(el.id);
                if (!elBounds) return el;
                const updates: Record<string, unknown> = {};
                if (axis === 'horizontal') {
                    updates.x = el.x + bounds.minX + bounds.maxX - elBounds.minX - elBounds.maxX;
                    if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
                        updates.points = flipPoints(el.points, elBounds.minX - el.x, elBounds.maxX - el.x, 0);
                    }
                } else {
                    updates.y = el.y + bounds.minY + bounds.maxY - elBounds.minY - elBounds.maxY;
                    if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
                        updates.points = flipPoints(el.points, elBounds.minY - el.y, elBounds.maxY - el.y, 1);
                    }
                }
                changed = true;
                movedIds.push(el.id);
                return { ...el, ...updates, version: (el.version ?? 0) + 1 } as CanvasElement;
            });

            return changed ? { elements } : state;
        });
        if (movedIds.length > 0) {
            syncMovedElements(movedIds, get);
            get().pushHistory();
        }
    },

    // ─── Lock ─────────────────────────────────────────────────
    toggleLockElements: (ids) => {
        set((state) => ({
            elements: state.elements.map((el) =>
                ids.includes(el.id)
                    ? { ...el, isLocked: !el.isLocked } as CanvasElement
                    : el
            ),
        }));
        get().pushHistory();
    },

    // ─── Grouping ─────────────────────────────────────────────
    groupElements: (ids) => {
        if (ids.length < 2) return;
        const groupId = generateId();
        const idSet = new Set(ids);

        // Auto-include bound text elements of selected containers
        const { elements } = get();
        for (const el of elements) {
            if (idSet.has(el.id) && el.boundElements) {
                for (const be of el.boundElements) {
                    if (be.type === 'text') {
                        idSet.add(be.id);
                    }
                }
            }
        }

        set((state) => ({
            elements: state.elements.map((el) =>
                idSet.has(el.id)
                    ? { ...el, groupIds: [...(el.groupIds ?? []), groupId] } as CanvasElement
                    : el
            ),
        }));
        get().pushHistory();
    },

    ungroupElements: (ids) => {
        const { elements } = get();
        const selected = elements.filter((el) => ids.includes(el.id));
        // Collect the outermost (last) groupId from each selected element
        const groupIdsToRemove = new Set<string>();
        for (const el of selected) {
            if (el.groupIds?.length) {
                groupIdsToRemove.add(el.groupIds[el.groupIds.length - 1]);
            }
        }
        if (groupIdsToRemove.size === 0) return;

        set((state) => ({
            elements: state.elements.map((el) => {
                if (!el.groupIds?.length) return el;
                const filtered = el.groupIds.filter((g) => !groupIdsToRemove.has(g));
                return {
                    ...el,
                    groupIds: filtered.length > 0 ? filtered : undefined,
                } as CanvasElement;
            }),
        }));
        get().pushHistory();
    },

    // ─── Selection ────────────────────────────────────────────
    setSelectedIds: (ids) => set({ selectedIds: ids }),
    clearSelection: () => set({ selectedIds: [] }),

    // ─── Tool ─────────────────────────────────────────────────
    setActiveTool: (tool) => set((state) => ({
        activeTool: tool,
        // Keep selection when switching back to 'select' (e.g. after creating an element)
        selectedIds: tool === 'select' ? state.selectedIds : [],
    })),

    toggleToolLock: () => set((state) => ({ toolLocked: !state.toolLocked })),

    // Drawing tools call this on commit instead of hardcoding setActiveTool('select'),
    // so tool-lock can keep the tool active. selectedIds is left untouched so the
    // just-created element (set by the tool's onMouseUp) stays selected.
    commitTool: () => set((state) => ({
        activeTool: state.toolLocked ? state.activeTool : 'select',
    })),

    setCurrentStyle: (style) =>
        set((state) => ({
            currentStyle: { ...state.currentStyle, ...style },
        })),

    setCurrentLineType: (lineType) => set({ currentLineType: lineType }),
    setCurrentStartArrowhead: (arrowhead) => set({ currentStartArrowhead: arrowhead }),
    setCurrentEndArrowhead: (arrowhead) => set({ currentEndArrowhead: arrowhead }),

    // ─── Viewport ─────────────────────────────────────────────
    setViewport: (viewport) => {
        cancelViewportAnimation();
        set((state) => ({
            viewport: { ...state.viewport, ...viewport },
        }));
    },

    zoomIn: (center, options) => {
        const { viewport } = get();
        const targetScale = getNextZoomStep(viewport.scale);
        // Default center: middle of a hypothetical 800×600 stage
        const pt = center ?? { x: 400, y: 300 };
        const target = zoomAtPoint({ viewport, point: pt, targetScale });

        if (options?.animate) {
            animateViewport(viewport, target, (v) => set((s) => ({ viewport: { ...s.viewport, ...v } })));
        } else {
            cancelViewportAnimation();
            set({ viewport: target });
        }
    },

    zoomOut: (center, options) => {
        const { viewport } = get();
        const targetScale = getPrevZoomStep(viewport.scale);
        const pt = center ?? { x: 400, y: 300 };
        const target = zoomAtPoint({ viewport, point: pt, targetScale });

        if (options?.animate) {
            animateViewport(viewport, target, (v) => set((s) => ({ viewport: { ...s.viewport, ...v } })));
        } else {
            cancelViewportAnimation();
            set({ viewport: target });
        }
    },

    resetZoom: (options) => {
        const { viewport } = get();
        const target: ViewportState = { x: 0, y: 0, scale: 1 };

        if (options?.animate) {
            animateViewport(viewport, target, (v) => set((s) => ({ viewport: { ...s.viewport, ...v } })));
        } else {
            cancelViewportAnimation();
            set({ viewport: target });
        }
    },

    zoomToFit: (stageWidth, stageHeight, ids, options) => {
        const { elements, viewport } = get();
        const targets = ids ? elements.filter(e => ids.includes(e.id)) : elements;
        const bounds = getElementsBounds(targets);
        if (!bounds) return;

        const target = computeZoomToFit(bounds, stageWidth, stageHeight, {
            padding: options?.padding,
            maxZoom: options?.maxZoom,
        });

        if (options?.animate) {
            animateViewport(viewport, target, (v) => set((s) => ({ viewport: { ...s.viewport, ...v } })));
        } else {
            cancelViewportAnimation();
            set({ viewport: target });
        }
    },

    zoomToSelection: (stageWidth, stageHeight, options) => {
        const { elements, selectedIds, viewport } = get();
        if (selectedIds.length === 0) return;
        const targets = elements.filter(e => selectedIds.includes(e.id));
        const bounds = getElementsBounds(targets);
        if (!bounds) return;

        const target = computeZoomToFit(bounds, stageWidth, stageHeight, {
            padding: options?.padding ?? 80,
            maxZoom: options?.maxZoom ?? 2,
        });

        if (options?.animate) {
            animateViewport(viewport, target, (v) => set((s) => ({ viewport: { ...s.viewport, ...v } })));
        } else {
            cancelViewportAnimation();
            set({ viewport: target });
        }
    },

    // ─── Drawing ──────────────────────────────────────────────
    setIsDrawing: (isDrawing) => set({ isDrawing }),
    setDrawStart: (point) => set({ drawStart: point }),

    // ─── History (Diff-based) ───────────────────────────────────
    pushHistory: (mark?: string) => {
        const { elements, _historyBaseline, _historyOrderBaseline, _historyPaused } = get();
        if (_historyPaused) return;

        // Compute diffs between baseline and current state
        const diffs: ElementDiff[] = [];
        const currentMap = new Map<string, CanvasElement>();
        for (const el of elements) {
            currentMap.set(el.id, el);
        }
        const currentOrder = orderOf(elements);
        const orderChanged = !sameOrder(_historyOrderBaseline, currentOrder);

        // Check for added and modified elements
        for (const el of elements) {
            const baseline = _historyBaseline.get(el.id);
            if (!baseline) {
                // New element
                diffs.push({ type: 'add', elementId: el.id, after: cloneElement(el) });
            } else if (baseline !== el) {
                // Modified element (reference check — works because we spread on update)
                diffs.push({
                    type: 'modify',
                    elementId: el.id,
                    before: cloneElement(baseline),
                    after: cloneElement(el),
                });
            }
        }

        // Check for deleted elements
        for (const [id, baseline] of _historyBaseline) {
            if (!currentMap.has(id)) {
                diffs.push({ type: 'delete', elementId: id, before: cloneElement(baseline) });
            }
        }

        // Skip if nothing changed
        if (diffs.length === 0 && !orderChanged) return;

        set((state) => {
            // Truncate any redone history
            const newHistory = state.history.slice(0, state.historyIndex + 1);
            newHistory.push({
                diffs,
                beforeOrder: orderChanged ? _historyOrderBaseline : undefined,
                afterOrder: orderChanged ? currentOrder : undefined,
                mark,
                timestamp: Date.now(),
            });
            if (newHistory.length > MAX_HISTORY) {
                newHistory.shift();
            }
            return {
                history: newHistory,
                historyIndex: newHistory.length - 1,
                // Update baseline to current state
                _historyBaseline: new Map(currentMap),
                _historyOrderBaseline: currentOrder,
            };
        });
    },

    undo: () => {
        const { historyIndex, history } = get();
        if (historyIndex < 0) return;

        const entry = history[historyIndex];
        // Apply diffs in reverse
        set((state) => {
            let elements = [...state.elements];

            // Process diffs in reverse order
            for (let i = entry.diffs.length - 1; i >= 0; i--) {
                const diff = entry.diffs[i];
                switch (diff.type) {
                    case 'add':
                        // Undo add → remove the element
                        elements = elements.filter(el => el.id !== diff.elementId);
                        break;
                    case 'modify':
                        // Undo modify → restore to before state
                        elements = elements.map(el =>
                            el.id === diff.elementId ? cloneElement(diff.before!) : el
                        );
                        break;
                    case 'delete':
                        // Undo delete → re-add the element
                        elements.push(cloneElement(diff.before!));
                        break;
                }
            }
            if (entry.beforeOrder) {
                elements = restoreOrder(elements, entry.beforeOrder);
            }

            // Update baseline to match the restored state
            const newBaseline = new Map<string, CanvasElement>();
            for (const el of elements) {
                newBaseline.set(el.id, el);
            }

            return {
                historyIndex: historyIndex - 1,
                elements,
                selectedIds: validSelectedIds(state.selectedIds, elements),
                _historyBaseline: newBaseline,
                _historyOrderBaseline: orderOf(elements),
            };
        });
    },

    redo: () => {
        const { historyIndex, history } = get();
        if (historyIndex >= history.length - 1) return;

        const newIndex = historyIndex + 1;
        const entry = history[newIndex];
        // Apply diffs forward
        set((state) => {
            let elements = [...state.elements];

            for (const diff of entry.diffs) {
                switch (diff.type) {
                    case 'add':
                        // Redo add → add the element
                        elements.push(cloneElement(diff.after!));
                        break;
                    case 'modify':
                        // Redo modify → apply the after state
                        elements = elements.map(el =>
                            el.id === diff.elementId ? cloneElement(diff.after!) : el
                        );
                        break;
                    case 'delete':
                        // Redo delete → remove the element
                        elements = elements.filter(el => el.id !== diff.elementId);
                        break;
                }
            }
            if (entry.afterOrder) {
                elements = restoreOrder(elements, entry.afterOrder);
            }

            // Update baseline to match the restored state
            const newBaseline = new Map<string, CanvasElement>();
            for (const el of elements) {
                newBaseline.set(el.id, el);
            }

            return {
                historyIndex: newIndex,
                elements,
                selectedIds: validSelectedIds(state.selectedIds, elements),
                _historyBaseline: newBaseline,
                _historyOrderBaseline: orderOf(elements),
            };
        });
    },

    squashHistory: (count = 2) => {
        set((state) => {
            if (state.history.length < count) return state;
            const startIdx = Math.max(0, state.history.length - count);
            const toSquash = state.history.slice(startIdx);

            // Merge all diffs, keeping only net effect per element
            const netDiffs = new Map<string, ElementDiff>();
            for (const entry of toSquash) {
                for (const diff of entry.diffs) {
                    const existing = netDiffs.get(diff.elementId);
                    if (!existing) {
                        netDiffs.set(diff.elementId, { ...diff });
                    } else {
                        // Merge: keep original before, update after
                        if (diff.type === 'delete') {
                            if (existing.type === 'add') {
                                // Added then deleted = no-op
                                netDiffs.delete(diff.elementId);
                            } else {
                                netDiffs.set(diff.elementId, {
                                    type: 'delete',
                                    elementId: diff.elementId,
                                    before: existing.before,
                                });
                            }
                        } else if (diff.type === 'modify') {
                            netDiffs.set(diff.elementId, {
                                type: existing.type === 'add' ? 'add' : 'modify',
                                elementId: diff.elementId,
                                before: existing.before,
                                after: diff.after,
                            });
                        }
                        // add after add shouldn't happen normally
                    }
                }
            }

            const squashed: HistoryEntry = {
                diffs: Array.from(netDiffs.values()),
                beforeOrder: toSquash.find((entry) => entry.beforeOrder)?.beforeOrder,
                afterOrder: [...toSquash].reverse().find((entry) => entry.afterOrder)?.afterOrder,
                mark: toSquash[toSquash.length - 1].mark,
                timestamp: Date.now(),
            };

            const newHistory = [...state.history.slice(0, startIdx), squashed];
            return {
                history: newHistory,
                historyIndex: newHistory.length - 1,
            };
        });
    },

    pauseHistory: () => set({ _historyPaused: true }),
    resumeHistory: () => set({ _historyPaused: false }),
    canUndo: () => get().historyIndex >= 0,
    canRedo: () => {
        const { historyIndex, history } = get();
        return historyIndex < history.length - 1;
    },

    // ─── Grid ─────────────────────────────────────────────────
    toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
}));
}

/**
 * Default singleton store. Used by tools, hooks, and the collaboration sync
 * bridge that read state via `getState()`. Most apps render a single
 * `<FlowCanvas>` per page, in which case this singleton is what the
 * `CanvasStoreProvider` exposes.
 */
export const useCanvasStore = createCanvasStore();
