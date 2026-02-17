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
import { generateId } from '@/utils/id';
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
    /** Optional named mark/checkpoint for grouping */
    mark?: string;
    /** Timestamp for squash heuristics */
    timestamp: number;
}

// ─── Store State ──────────────────────────────────────────────
interface CanvasState {
    // Elements
    elements: CanvasElement[];
    selectedIds: string[];

    // Tool
    activeTool: ToolType;
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

export const useCanvasStore = create<CanvasState>((set, get) => ({
    // ─── Initial State ────────────────────────────────────────
    elements: [],
    selectedIds: [],
    activeTool: 'select',
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
    _historyPaused: false,
    showGrid: false,

    // ─── Element Actions ──────────────────────────────────────
    addElement: (element) => {
        set((state) => ({
            elements: [...state.elements, element],
        }));
        get().pushHistory();
    },

    updateElement: (id, updates) => {
        set((state) => {
            const elements = state.elements;
            const idx = elements.findIndex(el => el.id === id);
            if (idx === -1) return state;
            const updated = { ...elements[idx], ...updates } as CanvasElement;
            // Reuse array when element reference is identical (no actual change)
            if (updated === elements[idx]) return state;
            const next = elements.slice();
            next[idx] = updated;
            return { elements: next };
        });
    },

    batchUpdateElements: (batchUpdates) => {
        if (batchUpdates.length === 0) return;
        // Single update — skip batch overhead
        if (batchUpdates.length === 1) {
            get().updateElement(batchUpdates[0].id, batchUpdates[0].updates);
            return;
        }
        set((state) => {
            const elements = state.elements;
            // Build ID→index lookup for O(1) access
            const idxMap = new Map<string, number>();
            for (let i = 0; i < elements.length; i++) {
                idxMap.set(elements[i].id, i);
            }
            let next: CanvasElement[] | null = null;
            for (const { id, updates } of batchUpdates) {
                const idx = idxMap.get(id);
                if (idx === undefined) continue;
                const src = next ? next[idx] : elements[idx];
                const updated = { ...src, ...updates } as CanvasElement;
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
        // Reset baseline when elements are set directly (initialization, import)
        const baseline = new Map<string, CanvasElement>();
        for (const el of elements) {
            baseline.set(el.id, el);
        }
        set({ elements, _historyBaseline: baseline });
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

                // Build converted element preserving all shared properties
                const base = {
                    ...el,
                    type: targetType,
                };

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
            const others = state.elements.filter((el) => !ids.includes(el.id));
            const targets = state.elements.filter((el) => ids.includes(el.id));
            return { elements: [...others, ...targets] };
        });
        get().pushHistory();
    },

    sendToBack: (ids) => {
        set((state) => {
            const others = state.elements.filter((el) => !ids.includes(el.id));
            const targets = state.elements.filter((el) => ids.includes(el.id));
            return { elements: [...targets, ...others] };
        });
        get().pushHistory();
    },

    bringForward: (ids) => {
        set((state) => {
            const elems = [...state.elements];
            const idSet = new Set(ids);
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
            const idSet = new Set(ids);
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
        const { elements, _historyBaseline, _historyPaused } = get();
        if (_historyPaused) return;

        // Compute diffs between baseline and current state
        const diffs: ElementDiff[] = [];
        const currentMap = new Map<string, CanvasElement>();
        for (const el of elements) {
            currentMap.set(el.id, el);
        }

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
        if (diffs.length === 0) return;

        set((state) => {
            // Truncate any redone history
            const newHistory = state.history.slice(0, state.historyIndex + 1);
            newHistory.push({
                diffs,
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

            // Update baseline to match the restored state
            const newBaseline = new Map<string, CanvasElement>();
            for (const el of elements) {
                newBaseline.set(el.id, el);
            }

            return {
                historyIndex: historyIndex - 1,
                elements,
                selectedIds: [],
                _historyBaseline: newBaseline,
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

            // Update baseline to match the restored state
            const newBaseline = new Map<string, CanvasElement>();
            for (const el of elements) {
                newBaseline.set(el.id, el);
            }

            return {
                historyIndex: newIndex,
                elements,
                selectedIds: [],
                _historyBaseline: newBaseline,
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
