/**
 * collaboration/syncEngine.ts — Op-based CRDT sync engine (doc ⇄ store).
 *
 * The genuine convergence core, decoupled from any network transport and from
 * the concrete Zustand store. `CollaborationManager` composes one of these per
 * session (after it has created the `Y.Doc` + WebSocket provider); tests drive
 * two engines over two in-memory docs synced via Yjs update messages.
 *
 * Local → Yjs:
 *   A local store diff is turned into intent operations via
 *   `utils/crdtPrep.detectOperations`, which are translated into GRANULAR Yjs
 *   mutations by `applyOperationToYjs` (delta moves, Y.Array/Y.Text reconcile,
 *   per-field style LWW, tombstone deletes). Residual LWW fields not covered by
 *   an op are reconciled directly. Everything for one diff lands in a single
 *   `doc.transact(..., this)` so it is atomic and self-echo is suppressed by
 *   matching the transaction origin.
 *
 * Yjs → Local:
 *   A deep observer on the elements map plus an observer on the tombstone map
 *   collect the affected element ids of every *remote* transaction and rebuild
 *   exactly those elements (tombstone-aware) into the store. Untouched,
 *   locally-edited elements are never clobbered — concurrent edits MERGE.
 *
 * crdtPrep deliberately stays Yjs-free (it is re-exported from the root bundle,
 * which must not pull in the optional `yjs` peer dep). The op→Yjs translation
 * therefore lives in the codec, and this engine wires the two together.
 */
import * as Y from 'yjs';
import type { CanvasElement } from '@/types';
import { detectOperations } from '@/utils/crdtPrep';
import {
    elementToYMap,
    applyOperationToYjs,
    syncResidualFields,
    collectLiveElements,
    readLiveElement,
    sortBySortOrder,
} from './syncBridgeCodec';

/**
 * Minimal store abstraction the engine needs. Keeps the engine independent of
 * Zustand specifics and trivially mockable in tests. `CollaborationManager`
 * adapts a real `CanvasStore` to this shape.
 */
export interface EngineStore {
    /** Current element array (must be a stable reference between mutations). */
    getElements(): CanvasElement[];
    /** Replace the element array (remote → local application). */
    setElements(elements: CanvasElement[]): void;
    /**
     * Subscribe to element-array changes. The listener should fire only when
     * the array reference actually changes.
     * @returns unsubscribe function
     */
    subscribeElements(listener: (elements: CanvasElement[]) => void): () => void;
}

export interface SyncEngineOptions {
    /** Debounce (ms) for batching local → Yjs sync. 0 = synchronous. @default 50 */
    debounceMs?: number;
}

export class CanvasSyncEngine {
    private readonly _doc: Y.Doc;
    private readonly _store: EngineStore;
    private readonly _yElements: Y.Map<Y.Map<unknown>>;
    private readonly _tombstones: Y.Map<number>;
    private readonly _debounceMs: number;

    private _lastElements: CanvasElement[] = [];
    private _applyingRemote = false;
    private _pendingLocal: CanvasElement[] | null = null;
    private _syncTimer: ReturnType<typeof setTimeout> | null = null;
    private _storeUnsub: (() => void) | null = null;
    private _started = false;

    constructor(doc: Y.Doc, store: EngineStore, opts: SyncEngineOptions = {}) {
        this._doc = doc;
        this._store = store;
        this._debounceMs = opts.debounceMs ?? 50;
        this._yElements = doc.getMap('elements') as Y.Map<Y.Map<unknown>>;
        this._tombstones = doc.getMap('tombstones') as Y.Map<number>;
    }

    get doc(): Y.Doc { return this._doc; }
    get yElements(): Y.Map<Y.Map<unknown>> { return this._yElements; }
    get tombstones(): Y.Map<number> { return this._tombstones; }

    // ─── Lifecycle ────────────────────────────────────────────

    start(): void {
        if (this._started) return;
        this._started = true;

        // Initial hydration. If the shared doc already has elements (joining an
        // existing room), remote state wins; otherwise seed the doc from local.
        if (this._yElements.size > 0) {
            this._applyingRemote = true;
            const elements = collectLiveElements(this._yElements, this._tombstones);
            this._store.setElements(elements);
            // Anchor to the store's post-set array (it may validate/clone), so a
            // later diff never mistakes a store-side transform for a real edit.
            this._lastElements = this._store.getElements();
            this._applyingRemote = false;
        } else {
            const local = this._store.getElements();
            if (local.length > 0) {
                this._doc.transact(() => {
                    for (const el of local) {
                        const yMap = new Y.Map<unknown>();
                        elementToYMap(el, yMap);
                        this._yElements.set(el.id, yMap);
                    }
                }, this);
            }
            this._lastElements = local;
        }

        this._yElements.observeDeep(this._onDeep);
        this._tombstones.observe(this._onTombstones);

        this._storeUnsub = this._store.subscribeElements((elements) => {
            if (this._applyingRemote) return;
            if (elements === this._lastElements) return;
            this._scheduleLocalSync(elements);
        });
    }

    stop(): void {
        if (!this._started) return;
        this._started = false;
        this._storeUnsub?.();
        this._storeUnsub = null;
        this._yElements.unobserveDeep(this._onDeep);
        this._tombstones.unobserve(this._onTombstones);
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        this._pendingLocal = null;
        this._lastElements = [];
    }

    /** Flush any pending debounced local sync immediately (deterministic tests). */
    flushLocal(): void {
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        if (this._pendingLocal) {
            const next = this._pendingLocal;
            this._pendingLocal = null;
            this._commitLocal(next);
        }
    }

    // ─── Local → Yjs ──────────────────────────────────────────

    private _scheduleLocalSync(elements: CanvasElement[]): void {
        this._pendingLocal = elements;
        if (this._debounceMs <= 0) {
            this.flushLocal();
            return;
        }
        if (this._syncTimer) clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => {
            this._syncTimer = null;
            this.flushLocal();
        }, this._debounceMs);
    }

    private _commitLocal(next: CanvasElement[]): void {
        const prev = this._lastElements;
        this._lastElements = next;

        const ops = detectOperations(prev, next);
        const prevById = new Map(prev.map((e) => [e.id, e]));

        this._doc.transact(() => {
            for (const op of ops) {
                applyOperationToYjs(op, this._yElements, this._tombstones);
            }
            // LWW fields no op covers (lock/visibility/version, coarse JSON,
            // type-specific scalars). New elements (added this diff) and
            // unchanged references are skipped to avoid redundant writes.
            for (const el of next) {
                const p = prevById.get(el.id);
                if (!p || p === el) continue;
                const yMap = this._yElements.get(el.id);
                if (yMap) syncResidualFields(el, yMap);
            }
        }, this);
    }

    // ─── Yjs → Local ──────────────────────────────────────────

    private _onDeep = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction): void => {
        if (txn.origin === this) return; // ignore our own writes
        const affected = new Set<string>();

        for (const event of events) {
            const target = event.target;
            if (target === this._yElements) {
                // Top-level add / update / delete of element keys.
                for (const key of (event as Y.YMapEvent<Y.Map<unknown>>).keys.keys()) {
                    affected.add(key);
                }
            } else {
                // Nested change (scalar field, points Y.Array, text Y.Text):
                // walk up to the owning element map (parent === yElements).
                let t: Y.AbstractType<unknown> | null = target;
                while (t && !(t instanceof Y.Map && t.parent === this._yElements)) {
                    t = (t.parent as Y.AbstractType<unknown> | null) ?? null;
                }
                if (t instanceof Y.Map) {
                    const id = t.get('id');
                    if (typeof id === 'string') affected.add(id);
                }
            }
        }

        if (affected.size > 0) this._applyRemote(affected);
    };

    private _onTombstones = (event: Y.YMapEvent<number>, txn: Y.Transaction): void => {
        if (txn.origin === this) return;
        const affected = new Set<string>();
        for (const key of event.keys.keys()) affected.add(key);
        if (affected.size > 0) this._applyRemote(affected);
    };

    private _applyRemote(ids: Set<string>): void {
        this._applyingRemote = true;
        const elements = [...this._lastElements];
        let changed = false;

        for (const id of ids) {
            const el = readLiveElement(this._yElements, this._tombstones, id);
            const idx = elements.findIndex((e) => e.id === id);
            if (el) {
                if (idx >= 0) elements[idx] = el;
                else elements.push(el);
                changed = true;
            } else if (idx >= 0) {
                elements.splice(idx, 1);
                changed = true;
            }
        }

        if (changed) {
            sortBySortOrder(elements);
            this._store.setElements(elements);
            // Anchor to the store's post-set array (validation/clone safe).
            this._lastElements = this._store.getElements();
        }
        this._applyingRemote = false;
    }
}
