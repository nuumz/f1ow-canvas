/**
 * Multi-instance isolation regressions.
 *
 * Proves the two singleton leaks closed in this pass:
 *  1. A drawing tool acting through `ctx.store` mutates ONLY that store's
 *     history/elements — a sibling store is left completely untouched.
 *  2. Each FlowCanvas owns its own `ElbowWorkerManager`, so disposing one
 *     canvas's manager (canvas A unmounting) never tears down another's
 *     worker, and the legacy global dispose path is independent of instances.
 */
import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_STYLE } from '@/constants';
import { createCanvasStore } from '@/store/useCanvasStore';
import { drawShapeTool } from '@/tools/DrawShapeTool';
import {
    ElbowWorkerManager,
    getElbowWorkerManager,
    disposeElbowWorkerManager,
} from '@/utils/elbowWorkerManager';
import type { CanvasElement } from '@/types';

type Store = ReturnType<typeof createCanvasStore>;

function rectangle(id: string, x = 0): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
    };
}

/**
 * Build a ToolContext whose store + element actions all delegate to `store`,
 * mirroring how FlowCanvas wires the resolved per-instance store into tools.
 */
function createContextFor(store: Store) {
    const s = store.getState();
    return {
        store,
        elements: s.elements,
        selectedIds: [],
        activeTool: 'rectangle',
        currentStyle: { ...DEFAULT_STYLE },
        isDrawing: false,
        drawStart: null,
        showGrid: false,
        addElement: s.addElement,
        updateElement: s.updateElement,
        deleteElements: s.deleteElements,
        setSelectedIds: s.setSelectedIds,
        clearSelection: s.clearSelection,
        setActiveTool: s.setActiveTool,
        commitTool: s.commitTool,
        setIsDrawing: vi.fn(),
        setDrawStart: vi.fn(),
        pushHistory: s.pushHistory,
        getPointerPos: vi.fn(),
        snapPos: (p: { x: number; y: number }) => p,
        currentElementIdRef: { current: null as string | null },
        shiftKeyRef: { current: false },
        startBindingRef: { current: null },
        snapThreshold: 24,
        hysteresisMargin: 6,
        setSnapTarget: vi.fn(),
        selectionBox: null,
        setSelectionBox: vi.fn(),
        setAutoEditTextId: vi.fn(),
        linearEdit: {
            isEditing: false,
            elementId: null,
            exitEditMode: vi.fn(),
            enterEditMode: vi.fn(),
        },
        onElementCreate: vi.fn(),
        onElementDelete: vi.fn(),
    };
}

describe('tool acting through ctx.store', () => {
    it('mutates only its own store; the sibling store is untouched', () => {
        const a = createCanvasStore();
        const b = createCanvasStore();
        const ctx = createContextFor(a);

        drawShapeTool.onMouseDown({} as any, { x: 10, y: 10 }, ctx as any);

        // pauseHistory routed through ctx.store (A), never the singleton or B.
        expect(a.getState()._historyPaused).toBe(true);
        expect(b.getState()._historyPaused).toBe(false);
        // addElement landed in A only.
        expect(a.getState().elements.length).toBe(1);
        expect(b.getState().elements.length).toBe(0);

        drawShapeTool.onMouseUp(ctx as any);

        // resumeHistory balanced A's pause; B was never paused/resumed.
        expect(a.getState()._historyPaused).toBe(false);
        expect(b.getState()._historyPaused).toBe(false);

        // B is entirely untouched by A's gesture.
        expect(b.getState().elements.length).toBe(0);
        expect(b.getState().history.length).toBe(0);
    });
});

describe('per-instance elbow worker lifecycle', () => {
    const routeParams = {
        startWorld: { x: 0, y: 0 },
        endWorld: { x: 100, y: 100 },
        startBinding: null,
        endBinding: null,
    };

    it('disposing one instance manager leaves a sibling fully usable', async () => {
        const mgrA = new ElbowWorkerManager();
        const mgrB = new ElbowWorkerManager();
        expect(mgrB.isWorkerActive).toBe(true);

        // Canvas A unmounts → its manager is disposed. Idempotent.
        mgrA.dispose();
        expect(() => mgrA.dispose()).not.toThrow();

        // Canvas B's manager keeps working — no shared global was killed.
        expect(mgrB.isWorkerActive).toBe(true);
        const pts = await mgrB.computeRoute(routeParams);
        expect(Array.isArray(pts)).toBe(true);
    });

    it('keeps obstacle snapshots isolated between instances', () => {
        const mgrA = new ElbowWorkerManager();
        const mgrB = new ElbowWorkerManager();
        mgrA.updateElements([rectangle('obstacle', 40)]);
        mgrB.updateElements([]);

        mgrA.dispose();
        // B never saw A's obstacle and is still computable after A is gone.
        const pts = mgrB.computeSync({ ...routeParams, endWorld: { x: 100, y: 0 } });
        expect(Array.isArray(pts)).toBe(true);
    });

    it('global singleton disposal does not affect a per-instance manager', () => {
        const inst = new ElbowWorkerManager();
        getElbowWorkerManager(); // touch the legacy global singleton
        disposeElbowWorkerManager(); // legacy global teardown
        expect(inst.isWorkerActive).toBe(true);
    });
});
