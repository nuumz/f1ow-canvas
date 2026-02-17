/**
 * crdtPrep.ts — CRDT structural preparation utilities.
 *
 * Provides utilities for:
 *   1. Converting element array mutations to CRDT-compatible operations
 *   2. Applying operations to element state (for replay/sync)
 *   3. Managing operation history for collaboration
 *
 * This module is a "structural prep" — it establishes the interfaces
 * and patterns needed for full CRDT collaboration (Phase 4) without
 * actually implementing network sync or conflict resolution.
 *
 * When full CRDT (e.g., Yjs) is integrated later, these operations
 * can be mapped 1:1 to Y.Doc transactions.
 */
import type { CanvasElement, CanvasOperation, ElementStyle } from '@/types';

// ─── Operation History ────────────────────────────────────────

/**
 * Timestamped operation entry for the operation log.
 * The operation log is an append-only list that can be shared
 * across replicas for CRDT synchronization.
 */
export interface OperationEntry {
    /** Unique operation ID (for deduplication across replicas) */
    id: string;
    /** The operation itself */
    operation: CanvasOperation;
    /** Unix timestamp (ms) when the operation was created */
    timestamp: number;
    /** ID of the user/client that created this operation */
    clientId: string;
}

/**
 * Operation log — append-only list of operations.
 * In a full CRDT implementation, this would be synced via Yjs or similar.
 */
export class OperationLog {
    private _entries: OperationEntry[] = [];
    private _maxEntries: number;

    constructor(maxEntries = 10000) {
        this._maxEntries = maxEntries;
    }

    /** Append an operation to the log */
    push(entry: OperationEntry): void {
        this._entries.push(entry);
        // Trim oldest entries if over limit
        if (this._entries.length > this._maxEntries) {
            this._entries = this._entries.slice(this._entries.length - this._maxEntries);
        }
    }

    /** Get all entries (read-only) */
    get entries(): readonly OperationEntry[] {
        return this._entries;
    }

    /** Get entries since a specific timestamp */
    entriesSince(timestamp: number): OperationEntry[] {
        return this._entries.filter(e => e.timestamp >= timestamp);
    }

    /** Get entries by client ID */
    entriesByClient(clientId: string): OperationEntry[] {
        return this._entries.filter(e => e.clientId === clientId);
    }

    /** Clear all entries */
    clear(): void {
        this._entries = [];
    }

    /** Number of entries */
    get length(): number {
        return this._entries.length;
    }
}

// ─── Operation Builders ───────────────────────────────────────

/**
 * Create an 'add' operation for a new element.
 */
export function opAdd(element: CanvasElement): CanvasOperation {
    return { type: 'add', element };
}

/**
 * Create a 'delete' operation.
 */
export function opDelete(elementId: string): CanvasOperation {
    return { type: 'delete', elementId };
}

/**
 * Create a 'move' operation (delta-based for commutativity).
 */
export function opMove(elementId: string, dx: number, dy: number): CanvasOperation {
    return { type: 'move', elementId, dx, dy };
}

/**
 * Create a 'resize' operation.
 */
export function opResize(elementId: string, width: number, height: number, x?: number, y?: number): CanvasOperation {
    return { type: 'resize', elementId, width, height, x, y };
}

/**
 * Create a 'style' operation (partial style update).
 */
export function opStyle(elementId: string, changes: Partial<ElementStyle>): CanvasOperation {
    return { type: 'style', elementId, changes };
}

/**
 * Create a 'rotate' operation.
 */
export function opRotate(elementId: string, rotation: number): CanvasOperation {
    return { type: 'rotate', elementId, rotation };
}

/**
 * Create a 'reorder' operation (z-order change via fractional index).
 */
export function opReorder(elementId: string, sortOrder: string): CanvasOperation {
    return { type: 'reorder', elementId, sortOrder };
}

/**
 * Create an 'updatePoints' operation (for line/arrow/freedraw).
 */
export function opUpdatePoints(elementId: string, points: number[]): CanvasOperation {
    return { type: 'updatePoints', elementId, points };
}

/**
 * Create a 'setText' operation (for text elements).
 */
export function opSetText(elementId: string, text: string): CanvasOperation {
    return { type: 'setText', elementId, text };
}

/**
 * Create a batch operation (group multiple ops into one transaction).
 */
export function opBatch(...operations: CanvasOperation[]): CanvasOperation {
    return { type: 'batch', operations };
}

// ─── Operation Application ────────────────────────────────────

/**
 * Apply a single operation to an elements array.
 * Returns a new array (immutable — does not mutate input).
 *
 * This is the foundation for:
 *   - Replaying operation logs
 *   - Applying remote operations in CRDT sync
 *   - Undo/redo via inverse operations
 */
export function applyOperation(
    elements: CanvasElement[],
    op: CanvasOperation,
): CanvasElement[] {
    switch (op.type) {
        case 'add':
            return [...elements, op.element];

        case 'delete':
            return elements.filter(el => el.id !== op.elementId);

        case 'move':
            return elements.map(el =>
                el.id === op.elementId
                    ? { ...el, x: el.x + op.dx, y: el.y + op.dy }
                    : el,
            );

        case 'resize':
            return elements.map(el =>
                el.id === op.elementId
                    ? {
                        ...el,
                        width: op.width,
                        height: op.height,
                        ...(op.x !== undefined ? { x: op.x } : {}),
                        ...(op.y !== undefined ? { y: op.y } : {}),
                    }
                    : el,
            );

        case 'style':
            return elements.map(el =>
                el.id === op.elementId
                    ? { ...el, style: { ...el.style, ...op.changes } }
                    : el,
            );

        case 'rotate':
            return elements.map(el =>
                el.id === op.elementId
                    ? { ...el, rotation: op.rotation }
                    : el,
            );

        case 'reorder':
            return elements.map(el =>
                el.id === op.elementId
                    ? { ...el, sortOrder: op.sortOrder }
                    : el,
            );

        case 'updatePoints':
            return elements.map(el => {
                if (el.id !== op.elementId) return el;
                if ('points' in el) {
                    return { ...el, points: op.points };
                }
                return el;
            });

        case 'setText':
            return elements.map(el => {
                if (el.id !== op.elementId) return el;
                if (el.type === 'text') {
                    return { ...el, text: op.text };
                }
                return el;
            });

        case 'batch': {
            let result = elements;
            for (const subOp of op.operations) {
                result = applyOperation(result, subOp);
            }
            return result;
        }

        default:
            return elements;
    }
}

// ─── Diff Detection ───────────────────────────────────────────

/**
 * Detect what operations occurred between two element states.
 * Useful for converting imperative store mutations into operations
 * (bridge between current Zustand pattern and CRDT operations).
 *
 * @param before - Elements before the change
 * @param after - Elements after the change
 * @returns Array of operations that transform `before` into `after`
 */
export function detectOperations(
    before: CanvasElement[],
    after: CanvasElement[],
): CanvasOperation[] {
    const ops: CanvasOperation[] = [];
    const beforeMap = new Map<string, CanvasElement>();
    const afterMap = new Map<string, CanvasElement>();

    for (const el of before) beforeMap.set(el.id, el);
    for (const el of after) afterMap.set(el.id, el);

    // Detect additions
    for (const el of after) {
        if (!beforeMap.has(el.id)) {
            ops.push(opAdd(el));
        }
    }

    // Detect deletions
    for (const el of before) {
        if (!afterMap.has(el.id)) {
            ops.push(opDelete(el.id));
        }
    }

    // Detect modifications
    for (const el of after) {
        const prev = beforeMap.get(el.id);
        if (!prev || prev === el) continue; // not modified (same reference)

        // Position change
        if (prev.x !== el.x || prev.y !== el.y) {
            ops.push(opMove(el.id, el.x - prev.x, el.y - prev.y));
        }

        // Size change
        if (prev.width !== el.width || prev.height !== el.height) {
            ops.push(opResize(el.id, el.width, el.height));
        }

        // Rotation change
        if (prev.rotation !== el.rotation) {
            ops.push(opRotate(el.id, el.rotation));
        }

        // Style changes
        const styleChanges: Partial<ElementStyle> = {};
        let hasStyleChange = false;
        for (const key of Object.keys(el.style) as (keyof typeof el.style)[]) {
            if (prev.style[key] !== el.style[key]) {
                (styleChanges as Record<string, unknown>)[key] = el.style[key];
                hasStyleChange = true;
            }
        }
        if (hasStyleChange) {
            ops.push(opStyle(el.id, styleChanges));
        }

        // Text change
        if (el.type === 'text' && prev.type === 'text' && el.text !== prev.text) {
            ops.push(opSetText(el.id, el.text));
        }

        // Points change (line/arrow/freedraw)
        if (
            (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') &&
            (prev.type === 'line' || prev.type === 'arrow' || prev.type === 'freedraw')
        ) {
            const elPts = el.points;
            const prevPts = prev.points;
            if (elPts.length !== prevPts.length || elPts.some((v, i) => v !== prevPts[i])) {
                ops.push(opUpdatePoints(el.id, elPts));
            }
        }

        // Sort order change
        if (prev.sortOrder !== el.sortOrder && el.sortOrder !== undefined) {
            ops.push(opReorder(el.id, el.sortOrder));
        }
    }

    return ops;
}
