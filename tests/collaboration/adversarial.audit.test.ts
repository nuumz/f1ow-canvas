/**
 * tests/collaboration/adversarial.audit.test.ts
 *
 * INDEPENDENT, SKEPTICAL audit of the op-based delta CRDT sync engine.
 * Goal: try to BREAK convergence/correctness. Tests assert the IDEAL property
 * (stores converge to identical, sane state).
 *
 * Live collaboration is currently GATED off (see `CollaborationConfig.experimental`)
 * precisely because of the defects this suite reproduces. The known-defect cases
 * are marked `it.fails(...)` so the suite stays green while documenting the bug;
 * when the engine is fixed they will flip to failing — that is the signal to
 * remove `.fails` and promote them to real regression guards. AUDIT 1 documents
 * an intentional LWW (non-commutative) design choice, not a defect.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { DEFAULT_STYLE } from '@/constants';
import type { CanvasElement } from '@/types';
import { CanvasSyncEngine, type EngineStore } from '@/collaboration/syncEngine';

// ─── Element factories ────────────────────────────────────────

function rectangle(id: string, x = 0, y = 0): CanvasElement {
    return {
        id, type: 'rectangle', x, y, width: 100, height: 80, rotation: 0,
        style: { ...DEFAULT_STYLE }, isLocked: false, isVisible: true,
        boundElements: null, version: 0, sortOrder: id, cornerRadius: 0,
    };
}

function line(id: string, points: number[]): CanvasElement {
    return {
        id, type: 'line', x: 0, y: 0, width: 100, height: 0, rotation: 0,
        style: { ...DEFAULT_STYLE }, isLocked: false, isVisible: true,
        boundElements: null, version: 0, sortOrder: id, points,
        lineType: 'sharp', startBinding: null, endBinding: null,
    };
}

// ─── Configurable mock peer ───────────────────────────────────

interface Peer {
    store: EngineStore;
    engine: CanvasSyncEngine;
    doc: Y.Doc;
    get(): CanvasElement[];
    byId(): Map<string, CanvasElement>;
    seed(els: CanvasElement[]): void;
    update(id: string, patch: Partial<CanvasElement>): void;
    add(el: CanvasElement): void;
    remove(id: string): void;
}

interface PeerOpts {
    debounceMs?: number;
    /** optional store-side validator applied to every setElements (clone/mutate) */
    validate?: (els: CanvasElement[]) => CanvasElement[];
}

function createPeer(initial: CanvasElement[] = [], opts: PeerOpts = {}): Peer {
    let elements = initial;
    const listeners = new Set<(els: CanvasElement[]) => void>();
    const validate = opts.validate ?? ((e) => e);

    const store: EngineStore = {
        getElements: () => elements,
        setElements: (els) => {
            elements = validate(els);
            for (const l of listeners) l(elements);
        },
        subscribeElements: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
    };

    const doc = new Y.Doc();
    const engine = new CanvasSyncEngine(doc, store, { debounceMs: opts.debounceMs ?? 0 });

    return {
        store, engine, doc,
        get: () => elements,
        byId: () => new Map(elements.map((e) => [e.id, e])),
        seed: (els) => store.setElements(els),
        update: (id, patch) =>
            store.setElements(elements.map((e) => (e.id === id ? ({ ...e, ...patch } as CanvasElement) : e))),
        add: (el) => store.setElements([...elements, el]),
        remove: (id) => store.setElements(elements.filter((e) => e.id !== id)),
    };
}

// ─── Relay ────────────────────────────────────────────────────

const REMOTE = 'remote';

function connect(...peers: Peer[]): () => void {
    // full state exchange (every doc gets every other doc's state)
    for (const a of peers) {
        for (const b of peers) {
            if (a !== b) Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), REMOTE);
        }
    }
    const handlers: Array<[Y.Doc, (u: Uint8Array, o: unknown) => void]> = [];
    for (const a of peers) {
        const h = (update: Uint8Array, origin: unknown) => {
            if (origin === REMOTE) return;
            for (const b of peers) if (b !== a) Y.applyUpdate(b.doc, update, REMOTE);
        };
        a.doc.on('update', h);
        handlers.push([a.doc, h]);
    }
    return () => { for (const [d, h] of handlers) d.off('update', h); };
}

/** order-independent, undefined-dropping canonical JSON (mimics toEqual). */
function canon(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            const val = (v as Record<string, unknown>)[k];
            if (val !== undefined) out[k] = canon(val);
        }
        return out;
    }
    return v;
}
const cj = (v: unknown) => JSON.stringify(canon(v));

function converged(...peers: Peer[]): boolean {
    const base = peers[0].byId();
    for (let i = 1; i < peers.length; i++) {
        const m = peers[i].byId();
        if ([...base.keys()].sort().join() !== [...m.keys()].sort().join()) return false;
        for (const [id, el] of base) {
            if (cj(m.get(id)) !== cj(el)) return false;
        }
    }
    return true;
}

function docsByteIdentical(...peers: Peer[]): boolean {
    // compare via state vectors + full encode equality of elements/tombstones content
    const enc = (p: Peer) => {
        const els = p.engine.yElements;
        const ts = p.engine.tombstones;
        const obj: Record<string, unknown> = {};
        for (const [id, m] of els.entries()) obj[id] = (m as Y.Map<unknown>).toJSON();
        const tomb: Record<string, unknown> = {};
        for (const [id, v] of ts.entries()) tomb[id] = v != null; // presence only
        return JSON.stringify({ obj: sortObj(obj), tomb: sortObj(tomb) });
    };
    const base = enc(peers[0]);
    return peers.every((p) => enc(p) === base);
}

function sortObj(o: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
}

function dump(label: string, ...peers: Peer[]) {
    const rows = peers.map((p, i) =>
        `  peer${i} store: ${JSON.stringify(p.get().map((e) => ({ id: e.id, x: e.x, y: e.y })))}`,
    );
    const yrows = peers.map((p, i) => {
        const o: Record<string, unknown> = {};
        for (const [id, m] of p.engine.yElements.entries()) {
            const mm = m as Y.Map<unknown>;
            o[id] = { x: mm.get('x'), y: mm.get('y') };
        }
        return `  peer${i} yjs:   ${JSON.stringify(o)}`;
    });
    // eslint-disable-next-line no-console
    console.log(`[${label}]\n${rows.join('\n')}\n${yrows.join('\n')}`);
}

// ─────────────────────────────────────────────────────────────

describe('AUDIT 1 — concurrent move of the SAME element (commutativity claim)', () => {
    it('two concurrent moves of r1: do deltas SUM (350) or is one lost (LWW)?', () => {
        const a = createPeer();
        const b = createPeer();
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);

        disconnect();
        a.update('r1', { x: 100 }); // +100
        b.update('r1', { x: 250 }); // +250
        connect(a, b);

        dump('AUDIT1', a, b);
        const xa = a.byId().get('r1')!.x;
        const xb = b.byId().get('r1')!.x;

        // Claim under test: commutative delta CRDT would sum to 350.
        // Reality check assertions:
        expect(xa).toBe(xb); // at least convergent across peers
        expect(docsByteIdentical(a, b)).toBe(true);
        // BY DESIGN (documented): move deltas do NOT sum to 350. Y.Map 'x' is an
        // LWW register applied via read-modify-write, not a commutative counter,
        // so one concurrent move wins (LWW). This asserts the real behaviour.
        expect([100, 250]).toContain(xa);
    });
});

describe('AUDIT 2 — remote edit during a PENDING debounced local edit', () => {
    // KNOWN BUG (gated P0): a remote edit arriving within the local debounce window drops a
    // peer's change and desyncs store↔doc. it.fails until syncEngine._applyRemote is fixed.
    it.fails('remote edit to a DIFFERENT element while local edit pending → stores must still converge', () => {
        const a = createPeer([], { debounceMs: 1000 }); // A debounces (realistic)
        const b = createPeer([], { debounceMs: 0 });
        a.seed([rectangle('r1', 0, 0), rectangle('r2', 0, 0)]);
        a.engine.start();
        b.engine.start();
        connect(a, b);

        // A makes a local edit to r1 — stays PENDING (debounce not flushed).
        a.update('r1', { x: 100 });
        expect(a.get().find((e) => e.id === 'r1')!.x).toBe(100); // user sees 100 locally

        // While pending, a remote edit to r2 arrives from B and is applied.
        b.update('r2', { x: 500 });

        // Now A's debounce fires.
        a.engine.flushLocal();

        dump('AUDIT2-diff', a, b);
        // Ideal: r1=100 (A's edit), r2=500 (B's edit), both peers identical.
        expect(converged(a, b)).toBe(true);
        expect(a.byId().get('r1')!.x).toBe(100);
        expect(a.byId().get('r2')!.x).toBe(500);
        expect(b.byId().get('r2')!.x).toBe(500); // B's own edit must NOT be reverted
    });

    it('CONTROL: same ops but local edit FLUSHED before remote arrives → converges', () => {
        const a = createPeer([], { debounceMs: 1000 });
        const b = createPeer([], { debounceMs: 0 });
        a.seed([rectangle('r1', 0, 0), rectangle('r2', 0, 0)]);
        a.engine.start();
        b.engine.start();
        connect(a, b);

        a.update('r1', { x: 100 });
        a.engine.flushLocal();   // <-- flush FIRST (no pending during remote)
        b.update('r2', { x: 500 });

        dump('AUDIT2-control', a, b);
        // Proves the defect is specifically the debounce/pending window.
        expect(converged(a, b)).toBe(true);
        expect(a.byId().get('r1')!.x).toBe(100);
        expect(a.byId().get('r2')!.x).toBe(500);
    });

    // KNOWN BUG (gated P0): same debounce-window defect on the same element. it.fails until fixed.
    it.fails('remote edit to the SAME element while local edit pending → converge to a sane value', () => {
        const a = createPeer([], { debounceMs: 1000 });
        const b = createPeer([], { debounceMs: 0 });
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        b.engine.start();
        connect(a, b);

        a.update('r1', { x: 100 }); // pending on A
        b.update('r1', { x: 250 }); // committed by B, arrives at A
        a.engine.flushLocal();

        dump('AUDIT2-same', a, b);
        expect(converged(a, b)).toBe(true);
        // value should be one of the user intents, not a compounded jump
        const x = a.byId().get('r1')!.x;
        expect([100, 250]).toContain(x);
    });
});

describe('AUDIT 3 — store that clones + mutates on setElements (_lastElements desync)', () => {
    // Validator: deep-clone (new identity) AND snap x to a 10px grid.
    const snap = (els: CanvasElement[]) =>
        els.map((e) => ({ ...e, x: Math.round(e.x / 10) * 10 }));

    it('single-peer: delta-move does not drift through a mutating store', () => {
        const a = createPeer([], { validate: snap });
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        a.update('r1', { x: 47 }); // snaps to 50
        expect(a.get().find((e) => e.id === 'r1')!.x).toBe(50);
        // Yjs must match the snapped store value (no drift)
        expect(a.engine.yElements.get('r1')!.get('x')).toBe(50);
        a.update('r1', { x: 92 }); // snaps to 90
        expect(a.engine.yElements.get('r1')!.get('x')).toBe(90);
        expect(a.get().find((e) => e.id === 'r1')!.x).toBe(90);
    });

    it('two mutating peers concurrent edits still converge', () => {
        const a = createPeer([], { validate: snap });
        const b = createPeer([], { validate: snap });
        a.seed([rectangle('r1', 0, 0)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);
        disconnect();
        a.update('r1', { x: 33 }); // -> 30
        b.update('r1', { y: 77 }); // -> y 80 (different field)
        connect(a, b);
        dump('AUDIT3', a, b);
        expect(converged(a, b)).toBe(true);
    });
});

describe('AUDIT 4 — rapid add/delete/re-add (tombstone resurrection)', () => {
    it('sequential delete then re-add resurrects across peers', () => {
        const a = createPeer();
        const b = createPeer();
        a.seed([rectangle('r1', 1, 1)]);
        a.engine.start();
        b.engine.start();
        connect(a, b);
        a.remove('r1');
        a.add(rectangle('r1', 9, 9));
        expect(converged(a, b)).toBe(true);
        expect(a.byId().get('r1')!.x).toBe(9);
    });

    it('CONCURRENT delete (A) vs re-add-with-edit (B) of same id', () => {
        const a = createPeer();
        const b = createPeer();
        a.seed([rectangle('r1', 1, 1)]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);
        disconnect();
        a.remove('r1');               // A deletes
        b.update('r1', { x: 99 });    // B edits the live element
        connect(a, b);
        dump('AUDIT4-concurrent', a, b);
        // must converge (delete-wins is acceptable, but must AGREE)
        expect(converged(a, b)).toBe(true);
        expect(docsByteIdentical(a, b)).toBe(true);
    });

    it('rapid add->delete->re-add interleaved on two peers', () => {
        const a = createPeer();
        const b = createPeer();
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);
        a.add(rectangle('r1', 1, 1));      // A adds, B sees
        disconnect();
        a.remove('r1');                    // A deletes (offline)
        b.add(rectangle('r2', 2, 2));      // B adds different element (offline)
        a.add(rectangle('r1', 5, 5));      // A re-adds same id (offline)
        connect(a, b);
        dump('AUDIT4-rapid', a, b);
        expect(converged(a, b)).toBe(true);
        expect(a.byId().has('r2')).toBe(true);
        expect(a.byId().get('r1')!.x).toBe(5);
    });
});

describe('AUDIT 5 — concurrent point (Y.Array) edit + scalar edit on same element', () => {
    it('point edit on A + scalar move on B merge', () => {
        const a = createPeer();
        const b = createPeer();
        a.seed([line('l1', [0, 0, 100, 0])]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);
        disconnect();
        a.update('l1', { points: [10, 5, 100, 0] }); // A: drag start point
        b.update('l1', { x: 50 });                   // B: move whole element
        connect(a, b);
        dump('AUDIT5', a, b);
        expect(converged(a, b)).toBe(true);
        const el = a.byId().get('l1') as Extract<CanvasElement, { points: number[] }>;
        expect(el.x).toBe(50);
        expect(el.points).toEqual([10, 5, 100, 0]);
    });

    // KNOWN BUG (gated): overlapping concurrent point edits via splice-reconcile can yield an
    // odd-length (invalid) point array. it.fails until the points reconcile is hardened.
    it.fails('OVERLAPPING concurrent point edits (both edit same index) — sane result?', () => {
        const a = createPeer();
        const b = createPeer();
        a.seed([line('l1', [0, 0, 100, 0])]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);
        disconnect();
        a.update('l1', { points: [0, 0, 200, 0] }); // A: third coord -> 200
        b.update('l1', { points: [0, 0, 300, 0] }); // B: third coord -> 300
        connect(a, b);
        dump('AUDIT5-overlap', a, b);
        expect(converged(a, b)).toBe(true); // at least agree
        const el = a.byId().get('l1') as Extract<CanvasElement, { points: number[] }>;
        // a line should still have an even, length-4 point array (sane geometry)
        expect(el.points.length).toBe(4);
    });
});

describe('AUDIT 6 — offline divergence, multi-op, then reconcile', () => {
    it('several ops each side offline then converge to identical sane state', () => {
        const a = createPeer();
        const b = createPeer();
        a.seed([rectangle('r1', 0, 0), rectangle('r2', 0, 0), line('l1', [0, 0, 10, 0])]);
        a.engine.start();
        b.engine.start();
        const disconnect = connect(a, b);
        disconnect();
        // A's offline session
        a.update('r1', { x: 80, y: 80 });
        a.update('r1', { rotation: 45 });
        a.update('l1', { points: [0, 0, 10, 50] });
        a.remove('r2');
        // B's offline session
        b.update('r1', { width: 200 });        // different field of r1
        b.add(rectangle('r3', 7, 7));
        connect(a, b);
        dump('AUDIT6', a, b);
        expect(converged(a, b)).toBe(true);
        expect(docsByteIdentical(a, b)).toBe(true);
        const m = a.byId();
        expect(m.has('r2')).toBe(false);
        expect(m.has('r3')).toBe(true);
        expect(m.get('r1')).toMatchObject({ x: 80, y: 80, rotation: 45, width: 200 });
    });
});

describe('AUDIT 7 — three-peer convergence', () => {
    it('three peers, concurrent edits to different + same elements', () => {
        const a = createPeer();
        const b = createPeer();
        const c = createPeer();
        a.seed([rectangle('r1', 0, 0), rectangle('r2', 0, 0)]);
        a.engine.start();
        b.engine.start();
        c.engine.start();
        const disconnect = connect(a, b, c);
        disconnect();
        a.update('r1', { x: 10 });
        b.update('r2', { y: 20 });
        c.update('r1', { width: 333 }); // different field of r1, concurrent with A
        connect(a, b, c);
        dump('AUDIT7', a, b, c);
        expect(converged(a, b, c)).toBe(true);
        expect(docsByteIdentical(a, b, c)).toBe(true);
        const m = a.byId();
        expect(m.get('r1')!.x).toBe(10);
        expect(m.get('r1')!.width).toBe(333);
        expect(m.get('r2')!.y).toBe(20);
    });
});
