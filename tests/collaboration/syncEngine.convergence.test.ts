/**
 * tests/collaboration/syncEngine.convergence.test.ts
 *
 * Convergence tests for the op-based CRDT sync engine. Two `CanvasSyncEngine`
 * instances run over two independent in-memory `Y.Doc`s that exchange Yjs
 * update messages — a faithful model of two collaborating clients. After
 * concurrent (offline) edits and a reconnect, BOTH stores must converge to the
 * same state with no lost updates.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { DEFAULT_STYLE } from '@/constants';
import type { CanvasElement } from '@/types';
import { CanvasSyncEngine, type EngineStore } from '@/collaboration/syncEngine';

// ─── Element factories ────────────────────────────────────────

function rectangle(id: string, x = 0, y = 0): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y,
        width: 100,
        height: 80,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        sortOrder: id,
        cornerRadius: 0,
    };
}

function line(id: string, points: number[]): CanvasElement {
    return {
        id,
        type: 'line',
        x: 0,
        y: 0,
        width: 100,
        height: 0,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        sortOrder: id,
        points,
        lineType: 'sharp',
        startBinding: null,
        endBinding: null,
    };
}

function textEl(id: string, text: string): CanvasElement {
    return {
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 24,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        sortOrder: id,
        text,
        containerId: null,
        textAlign: 'center',
        verticalAlign: 'middle',
    };
}

// ─── Mock store (EngineStore) ─────────────────────────────────

interface MockPeer {
    store: EngineStore;
    engine: CanvasSyncEngine;
    doc: Y.Doc;
    get(): CanvasElement[];
    byId(): Map<string, CanvasElement>;
    seed(elements: CanvasElement[]): void;
    update(id: string, patch: Partial<CanvasElement>): void;
    add(el: CanvasElement): void;
    remove(id: string): void;
}

function createPeer(initial: CanvasElement[] = []): MockPeer {
    let elements = initial;
    const listeners = new Set<(els: CanvasElement[]) => void>();

    const store: EngineStore = {
        getElements: () => elements,
        setElements: (els) => {
            elements = els;
            for (const l of listeners) l(elements);
        },
        subscribeElements: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
    };

    const doc = new Y.Doc();
    // debounceMs: 0 → local sync flushes synchronously for deterministic tests.
    const engine = new CanvasSyncEngine(doc, store, { debounceMs: 0 });

    return {
        store,
        engine,
        doc,
        get: () => elements,
        byId: () => new Map(elements.map((e) => [e.id, e])),
        seed: (els) => store.setElements(els),
        update: (id, patch) =>
            store.setElements(elements.map((e) => (e.id === id ? ({ ...e, ...patch } as CanvasElement) : e))),
        add: (el) => store.setElements([...elements, el]),
        remove: (id) => store.setElements(elements.filter((e) => e.id !== id)),
    };
}

// ─── Network relay (two docs exchanging updates) ──────────────

const REMOTE = 'remote';

/**
 * Sync two docs: full state exchange both ways, then a live update relay.
 * Returns a disconnect function (simulates going offline).
 */
function connect(a: MockPeer, b: MockPeer): () => void {
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), REMOTE);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), REMOTE);

    const onA = (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE) Y.applyUpdate(b.doc, update, REMOTE);
    };
    const onB = (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE) Y.applyUpdate(a.doc, update, REMOTE);
    };
    a.doc.on('update', onA);
    b.doc.on('update', onB);

    return () => {
        a.doc.off('update', onA);
        b.doc.off('update', onB);
    };
}

function expectConverged(a: MockPeer, b: MockPeer): Map<string, CanvasElement> {
    const ma = a.byId();
    const mb = b.byId();
    expect([...ma.keys()].sort()).toEqual([...mb.keys()].sort());
    for (const [id, ea] of ma) {
        expect(mb.get(id)).toEqual(ea);
    }
    return ma;
}

// ─── Tests ────────────────────────────────────────────────────

describe('CanvasSyncEngine convergence', () => {
    let a: MockPeer;
    let b: MockPeer;

    beforeEach(() => {
        a = createPeer();
        b = createPeer();
    });

    it('baseline: seeded elements replicate to a joining peer', () => {
        a.seed([rectangle('r1', 10, 10), rectangle('r2', 200, 50)]);
        a.engine.start();
        b.engine.start();
        connect(a, b);

        const merged = expectConverged(a, b);
        expect(merged.size).toBe(2);
        expect(merged.get('r1')!.x).toBe(10);
        expect(merged.get('r2')!.x).toBe(200);
    });

    it('concurrent moves of DIFFERENT elements both survive', () => {
        a.seed([rectangle('r1', 0, 0), rectangle('r2', 0, 0)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        // Go offline; each peer moves a different element.
        disconnect();
        a.update('r1', { x: 100, y: 40 }); // peer A drags r1
        b.update('r2', { x: 250, y: 70 }); // peer B drags r2

        // Reconnect → both moves must be present on both peers.
        connect(a, b);

        const merged = expectConverged(a, b);
        expect(merged.get('r1')!).toMatchObject({ x: 100, y: 40 });
        expect(merged.get('r2')!).toMatchObject({ x: 250, y: 70 });
    });

    it('concurrent edits to DIFFERENT scalar fields of the SAME element both survive', () => {
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        disconnect();
        a.update('r1', { x: 123 }); // A moves it (x scalar)
        b.update('r1', { style: { ...DEFAULT_STYLE, fillColor: '#ff0000' } }); // B recolors (style.fillColor)

        connect(a, b);

        const merged = expectConverged(a, b);
        // Both edits merged — neither clobbers the other.
        expect(merged.get('r1')!.x).toBe(123);
        expect(merged.get('r1')!.style.fillColor).toBe('#ff0000');
    });

    it('concurrent point edits MERGE (start vs end of the same line)', () => {
        a.seed([line('l1', [0, 0, 100, 0])]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        disconnect();
        // A drags the start point, B drags the end point.
        a.update('l1', { points: [10, 5, 100, 0] });
        b.update('l1', { points: [0, 0, 90, 5] });

        connect(a, b);

        const merged = expectConverged(a, b);
        const pts = (merged.get('l1') as Extract<CanvasElement, { points: number[] }>).points;
        // Both endpoint drags converge — not a whole-array clobber.
        expect(pts).toEqual([10, 5, 90, 5]);
    });

    it('concurrent text edits MERGE through Y.Text (different offsets)', () => {
        a.seed([textEl('t1', 'hello world')]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        disconnect();
        a.update('t1', { text: 'hello brave world' }); // A inserts "brave "
        b.update('t1', { text: 'hello world!' }); // B appends "!"

        connect(a, b);

        const merged = expectConverged(a, b);
        expect((merged.get('t1') as Extract<CanvasElement, { text: string }>).text).toBe(
            'hello brave world!',
        );
    });

    it('a delete does NOT clobber a concurrently-added remote element', () => {
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        disconnect();
        a.remove('r1'); // peer A deletes the shared element
        b.add(rectangle('r2', 300, 300)); // peer B adds a new element concurrently

        connect(a, b);

        const merged = expectConverged(a, b);
        expect(merged.has('r1')).toBe(false); // delete applied
        expect(merged.has('r2')).toBe(true); // concurrent add preserved
        expect(merged.get('r2')!).toMatchObject({ x: 300, y: 300 });
    });

    it('offline edits are applied after reconnect (both directions)', () => {
        a.seed([rectangle('r1', 0, 0), rectangle('r2', 0, 0)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        // Simulate peer A going offline and making several edits.
        disconnect();
        a.update('r1', { x: 80, y: 80 });
        a.update('r1', { rotation: 45 });
        a.update('r2', { isVisible: false }); // residual (non-op) LWW field
        // Peer B also edits offline.
        b.update('r2', { x: 500 });

        // Reconnect.
        connect(a, b);

        const merged = expectConverged(a, b);
        expect(merged.get('r1')!).toMatchObject({ x: 80, y: 80, rotation: 45 });
        expect(merged.get('r2')!).toMatchObject({ x: 500, isVisible: false });
    });

    it('explicit re-add after delete resurrects the element (tombstone cleared)', () => {
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        b.engine.start();
        connect(a, b);

        // Online delete then re-add of the same id (e.g. delete + undo).
        a.remove('r1');
        expect(a.get().some((e) => e.id === 'r1')).toBe(false);
        a.add(rectangle('r1', 42, 42));

        const merged = expectConverged(a, b);
        expect(merged.has('r1')).toBe(true);
        expect(merged.get('r1')!).toMatchObject({ x: 42, y: 42 });
    });
});
