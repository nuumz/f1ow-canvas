/**
 * useLinearEditStore.ts
 *
 * Zustand store managing the LinearElementEditor state.
 * Handles entering/exiting edit mode, selecting points,
 * dragging points, adding midpoints, and deleting points.
 */
import { create } from 'zustand';

// ─── State ────────────────────────────────────────────────────
interface LinearEditStoreState {
    /** ID of the element being edited, or null */
    elementId: string | null;
    /** Full editing mode (point handles visible & interactive) */
    isEditing: boolean;
    /** Indices of selected point(s) */
    selectedPointIndices: number[];
    /** Hovered point index (-1 = none) */
    hoveredPointIndex: number;
    /** Hovered midpoint index (null = none) */
    hoveredMidpointIndex: number | null;
    /** Currently dragging a point */
    isDraggingPoint: boolean;

    // ── Actions ───────────────────────────────────────────────
    enterEditMode: (elementId: string) => void;
    exitEditMode: () => void;
    setSelectedPoints: (indices: number[]) => void;
    togglePointSelection: (index: number) => void;
    setHoveredPoint: (index: number) => void;
    setHoveredMidpoint: (index: number | null) => void;
    setIsDraggingPoint: (dragging: boolean) => void;
    /** Reset everything */
    reset: () => void;
}

const INITIAL: Pick<
    LinearEditStoreState,
    'elementId' | 'isEditing' | 'selectedPointIndices' | 'hoveredPointIndex' | 'hoveredMidpointIndex' | 'isDraggingPoint'
> = {
    elementId: null,
    isEditing: false,
    selectedPointIndices: [],
    hoveredPointIndex: -1,
    hoveredMidpointIndex: null,
    isDraggingPoint: false,
};

export const useLinearEditStore = create<LinearEditStoreState>((set) => ({
    ...INITIAL,

    enterEditMode: (elementId) =>
        set({
            elementId,
            isEditing: true,
            selectedPointIndices: [],
            hoveredPointIndex: -1,
            hoveredMidpointIndex: null,
            isDraggingPoint: false,
        }),

    exitEditMode: () => set({ ...INITIAL }),

    setSelectedPoints: (indices) => set({ selectedPointIndices: indices }),

    togglePointSelection: (index) =>
        set((s) => {
            const has = s.selectedPointIndices.includes(index);
            return {
                selectedPointIndices: has
                    ? s.selectedPointIndices.filter((i) => i !== index)
                    : [...s.selectedPointIndices, index],
            };
        }),

    setHoveredPoint: (index) => set({ hoveredPointIndex: index }),
    setHoveredMidpoint: (index) => set({ hoveredMidpointIndex: index }),
    setIsDraggingPoint: (dragging) => set({ isDraggingPoint: dragging }),
    reset: () => set({ ...INITIAL }),
}));
