/**
 * collaboration/CollaborationManager.ts — Instance-scoped collaboration engine.
 *
 * The single live engine for real-time collaboration. Each FlowCanvas instance
 * owns one manager, which encapsulates:
 *   - the Yjs `Y.Doc` + `WebsocketProvider` lifecycle,
 *   - awareness (cursor / selection / tool presence),
 *   - and a {@link CanvasSyncEngine} that performs genuine op-based CRDT
 *     synchronization between the doc and a Zustand store.
 *
 * Convergence (no lost updates under concurrent edits) is provided by the
 * sync engine + shared codec, NOT by this class — see `syncEngine.ts` and
 * `syncBridgeCodec.ts`. This class is the transport + presence wrapper and the
 * consolidation point that the legacy module-level bridge (`syncBridge.ts`) and
 * worker (`syncWorker.worker.ts`) are deprecated in favour of.
 *
 * Usage:
 *   const mgr = new CollaborationManager();
 *   mgr.connect(config);
 *   mgr.startSync(store, 50);   // store: CanvasStore
 *   // ... later
 *   mgr.dispose();
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { CanvasElement } from '@/types';
import type { CanvasStore } from '@/store/useCanvasStore';
import type {
    CollaborationConfig,
    ConnectionStatus,
    AwarenessState,
} from './types';
import { CanvasSyncEngine, type EngineStore } from './syncEngine';

// ─── Types ────────────────────────────────────────────────────

export interface CollaborationManagerOptions {
    /** Debounce interval for local→Yjs sync (ms). @default 50 */
    syncDebounceMs?: number;
}

// ─── Manager Class ────────────────────────────────────────────

export class CollaborationManager {
    // Provider state
    private _doc: Y.Doc | null = null;
    private _provider: WebsocketProvider | null = null;
    private _config: CollaborationConfig | null = null;

    // Sync engine
    private _engine: CanvasSyncEngine | null = null;

    // Status listeners
    private _statusListeners = new Set<(status: ConnectionStatus) => void>();

    // ─── Provider Lifecycle ───────────────────────────────────

    get doc() { return this._doc; }
    get provider() { return this._provider; }
    get config() { return this._config; }

    get isActive(): boolean {
        return this._provider !== null && this._provider.wsconnected;
    }

    /**
     * Connect to a collaboration room.
     * If already connected, disconnects first.
     */
    connect(config: CollaborationConfig): { doc: Y.Doc; provider: WebsocketProvider } {
        this.dispose();

        this._config = config;
        this._doc = new Y.Doc();

        this._provider = new WebsocketProvider(
            config.serverUrl,
            config.roomName,
            this._doc,
            {
                connect: true,
                params: config.authToken ? { token: config.authToken } : undefined,
            },
        );

        // Set local awareness state
        this._provider.awareness.setLocalState({
            user: config.user,
            cursor: null,
            selectedIds: [],
        } satisfies AwarenessState);

        // Forward connection status changes
        this._provider.on('status', (event: { status: string }) => {
            const status = event.status as ConnectionStatus;
            for (const listener of this._statusListeners) {
                listener(status);
            }
        });

        return { doc: this._doc, provider: this._provider };
    }

    /** Get the shared Y.Map for elements. */
    getYElements(): Y.Map<Y.Map<unknown>> | null {
        return (this._doc?.getMap('elements') as Y.Map<Y.Map<unknown>>) ?? null;
    }

    /** Get the shared tombstone map (deleted element ids → timestamp). */
    getTombstones(): Y.Map<number> | null {
        return (this._doc?.getMap('tombstones') as Y.Map<number>) ?? null;
    }

    // ─── Awareness ────────────────────────────────────────────

    updateAwareness(update: Partial<AwarenessState>): void {
        if (!this._provider) return;
        const current = this._provider.awareness.getLocalState() as AwarenessState | null;
        this._provider.awareness.setLocalState({ ...current, ...update });
    }

    getRemoteAwareness(): Map<number, AwarenessState> {
        if (!this._provider) return new Map();
        const all = this._provider.awareness.getStates();
        const localId = this._provider.awareness.clientID;
        const remote = new Map<number, AwarenessState>();
        for (const [clientId, state] of all) {
            if (clientId !== localId && state && (state as AwarenessState).user) {
                remote.set(clientId, state as AwarenessState);
            }
        }
        return remote;
    }

    // ─── Status Listeners ─────────────────────────────────────

    onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
        this._statusListeners.add(listener);
        return () => { this._statusListeners.delete(listener); };
    }

    // ─── Sync Bridge ─────────────────────────────────────────

    /**
     * Start bidirectional, genuinely-convergent sync between the connected Yjs
     * doc and the provided store. Idempotent: a prior engine is stopped first.
     *
     * @param store      the canvas store to mirror (per-instance)
     * @param debounceMs local→Yjs batching debounce (ms)
     */
    startSync(store: CanvasStore, debounceMs = 50): void {
        const doc = this._doc;
        if (!doc) {
            console.warn('[CollaborationManager] Cannot start sync — not connected');
            return;
        }
        this.stopSync();

        const engineStore: EngineStore = {
            getElements: () => store.getState().elements,
            setElements: (elements: CanvasElement[]) => store.getState().setElements(elements),
            subscribeElements: (listener) =>
                store.subscribe((state, prev) => {
                    if (state.elements !== prev.elements) listener(state.elements);
                }),
        };

        this._engine = new CanvasSyncEngine(doc, engineStore, { debounceMs });
        this._engine.start();
    }

    stopSync(): void {
        this._engine?.stop();
        this._engine = null;
    }

    // ─── Dispose ──────────────────────────────────────────────

    dispose(): void {
        this.stopSync();
        if (this._provider) {
            this._provider.awareness.setLocalState(null);
            this._provider.disconnect();
            this._provider.destroy();
            this._provider = null;
        }
        if (this._doc) {
            this._doc.destroy();
            this._doc = null;
        }
        this._config = null;
        this._statusListeners.clear();
    }
}
