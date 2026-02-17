/**
 * collaboration/CollaborationManager.ts — Instance-based collaboration manager.
 *
 * Encapsulates the Yjs provider + sync bridge lifecycle in a single class,
 * replacing the legacy module-level singletons. This allows multiple
 * FlowCanvas instances on the same page to have independent collaboration
 * sessions.
 *
 * Usage:
 *   const mgr = new CollaborationManager();
 *   mgr.connect(config);
 *   mgr.startSync(store, 50);
 *   // ... later
 *   mgr.dispose();
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { CanvasElement } from '@/types';
import type {
    CollaborationConfig,
    ConnectionStatus,
    AwarenessState,
} from './types';

// Re-use the serialization helpers from syncBridge
import { elementToYMap, yMapToElement } from './syncBridgeCodec';

// ─── Types ────────────────────────────────────────────────────

export interface CollaborationManagerOptions {
    /** Debounce interval for local→Yjs sync (ms). @default 50 */
    syncDebounceMs?: number;
}

type StoreApi = {
    getState: () => { elements: CanvasElement[]; selectedIds: string[]; activeTool: string };
    subscribe: (listener: (state: { elements: CanvasElement[]; selectedIds: string[]; activeTool: string }, prev: { elements: CanvasElement[]; selectedIds: string[]; activeTool: string }) => void) => () => void;
    setElements: (elements: CanvasElement[]) => void;
};

// ─── Manager Class ────────────────────────────────────────────

export class CollaborationManager {
    // Provider state
    private _doc: Y.Doc | null = null;
    private _provider: WebsocketProvider | null = null;
    private _config: CollaborationConfig | null = null;

    // Sync state
    private _isApplyingRemote = false;
    private _isApplyingLocal = false;
    private _lastElements: CanvasElement[] = [];
    private _syncTimer: ReturnType<typeof setTimeout> | null = null;
    private _deepTimer: ReturnType<typeof setTimeout> | null = null;
    private _dirtyIds = new Set<string>();
    private _storeUnsub: (() => void) | null = null;
    private _yObserverCleanup: (() => void) | null = null;

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

    /**
     * Get the shared Y.Map for elements.
     */
    getYElements(): Y.Map<Y.Map<unknown>> | null {
        return this._doc?.getMap('elements') as Y.Map<Y.Map<unknown>> | null;
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
     * Start bidirectional sync between Yjs and the provided store.
     */
    startSync(store: StoreApi, debounceMs = 50): void {
        const doc = this._doc;
        const yElements = this.getYElements();
        if (!doc || !yElements) {
            console.warn('[CollaborationManager] Cannot start sync — not connected');
            return;
        }

        this.stopSync();

        // ─── Initial sync ─────────────────────────────────────
        if (yElements.size > 0) {
            this._isApplyingRemote = true;
            const elements = this._yMapCollectionToElements(yElements);
            store.setElements(elements);
            this._lastElements = elements;
            this._isApplyingRemote = false;
        } else {
            const localElements = store.getState().elements;
            if (localElements.length > 0) {
                this._isApplyingLocal = true;
                doc.transact(() => {
                    for (const el of localElements) {
                        const yMap = new Y.Map<unknown>();
                        elementToYMap(el, yMap);
                        yElements.set(el.id, yMap);
                    }
                }, 'local-init');
                this._isApplyingLocal = false;
            }
            this._lastElements = localElements;
        }

        // ─── Yjs → Store (incremental top-level observer) ────
        const yObserver = (events: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) => {
            if (transaction.origin === 'local-sync' || transaction.origin === 'local-init') return;
            if (this._isApplyingLocal) return;

            this._isApplyingRemote = true;
            let elements = [...this._lastElements];
            let changed = false;

            for (const [key, change] of events.keys) {
                if (change.action === 'add' || change.action === 'update') {
                    const yMap = yElements.get(key);
                    if (yMap) {
                        const el = yMapToElement(yMap);
                        if (el) {
                            const idx = elements.findIndex(e => e.id === key);
                            if (idx >= 0) elements[idx] = el;
                            else elements.push(el);
                            changed = true;
                        }
                    }
                } else if (change.action === 'delete') {
                    elements = elements.filter(e => e.id !== key);
                    changed = true;
                }
            }

            if (changed) {
                elements.sort((a, b) => {
                    if (a.sortOrder && b.sortOrder) {
                        return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0;
                    }
                    return 0;
                });
                store.setElements(elements);
                this._lastElements = elements;
            }

            this._isApplyingRemote = false;
        };

        // ─── Deep observer (field-level changes) ─────────────
        const deepObserver = (events: Y.YEvent<Y.Map<unknown>>[]) => {
            if (this._isApplyingLocal) return;

            for (const event of events) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let target: any = event.target;
                while (target && !(target instanceof Y.Map && target.parent === yElements)) {
                    target = target.parent;
                }
                if (target instanceof Y.Map) {
                    const id = target.get('id') as string;
                    if (id) this._dirtyIds.add(id);
                }
            }

            if (this._deepTimer) clearTimeout(this._deepTimer);
            this._deepTimer = setTimeout(() => {
                if (this._dirtyIds.size === 0 || this._isApplyingLocal) return;

                this._isApplyingRemote = true;
                let elements = [...this._lastElements];
                let changed = false;

                for (const id of this._dirtyIds) {
                    const yMap = yElements.get(id);
                    if (!yMap) continue;
                    const el = yMapToElement(yMap);
                    if (!el) continue;
                    const idx = elements.findIndex(e => e.id === id);
                    if (idx >= 0) { elements[idx] = el; changed = true; }
                }
                this._dirtyIds.clear();

                if (changed) {
                    store.setElements(elements);
                    this._lastElements = elements;
                }
                this._isApplyingRemote = false;
            }, 16);
        };

        yElements.observe(yObserver);
        yElements.observeDeep(deepObserver);

        this._yObserverCleanup = () => {
            yElements.unobserve(yObserver);
            yElements.unobserveDeep(deepObserver);
            if (this._deepTimer) clearTimeout(this._deepTimer);
            this._dirtyIds.clear();
        };

        // ─── Store → Yjs (local changes) ─────────────────────
        this._storeUnsub = store.subscribe((state) => {
            if (this._isApplyingRemote) return;
            if (state.elements === this._lastElements) return;

            if (this._syncTimer) clearTimeout(this._syncTimer);
            this._syncTimer = setTimeout(() => {
                this._syncLocalToYjs(state.elements, yElements, doc);
            }, debounceMs);
        });
    }

    stopSync(): void {
        this._storeUnsub?.();
        this._storeUnsub = null;
        this._yObserverCleanup?.();
        this._yObserverCleanup = null;
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        this._lastElements = [];
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

    // ─── Private ──────────────────────────────────────────────

    private _syncLocalToYjs(
        elements: CanvasElement[],
        yElements: Y.Map<Y.Map<unknown>>,
        doc: Y.Doc,
    ): void {
        this._isApplyingLocal = true;
        this._lastElements = elements;

        const localMap = new Map<string, CanvasElement>();
        for (const el of elements) localMap.set(el.id, el);

        doc.transact(() => {
            for (const [id] of yElements.entries()) {
                if (!localMap.has(id)) yElements.delete(id);
            }
            for (const el of elements) {
                let yMap = yElements.get(el.id);
                if (!yMap) {
                    yMap = new Y.Map<unknown>();
                    elementToYMap(el, yMap);
                    yElements.set(el.id, yMap);
                } else {
                    this._updateYMapFromElement(el, yMap);
                }
            }
        }, 'local-sync');

        this._isApplyingLocal = false;
    }

    private _updateYMapFromElement(el: CanvasElement, yMap: Y.Map<unknown>): void {
        const SYNC_FIELDS = [
            'id', 'type', 'x', 'y', 'width', 'height', 'rotation',
            'isLocked', 'isVisible', 'sortOrder',
        ] as const;
        const STYLE_FIELDS = [
            'strokeColor', 'fillColor', 'strokeWidth', 'opacity',
            'strokeStyle', 'roughness', 'fontSize', 'fontFamily',
        ] as const;

        const elRecord = el as unknown as Record<string, unknown>;
        for (const field of SYNC_FIELDS) {
            const value = elRecord[field];
            if (value !== yMap.get(field)) yMap.set(field, value);
        }

        if (el.style) {
            for (const sf of STYLE_FIELDS) {
                const val = el.style[sf];
                if (val !== yMap.get(`style.${sf}`)) yMap.set(`style.${sf}`, val);
            }
        }

        const beJson = el.boundElements ? JSON.stringify(el.boundElements) : null;
        if (beJson !== yMap.get('boundElements')) yMap.set('boundElements', beJson);

        // Type-specific (delegated to codec)
        switch (el.type) {
            case 'rectangle':
                if (el.cornerRadius !== yMap.get('cornerRadius')) yMap.set('cornerRadius', el.cornerRadius);
                break;
            case 'line':
            case 'arrow': {
                const ptsJson = JSON.stringify(el.points);
                if (ptsJson !== yMap.get('points')) yMap.set('points', ptsJson);
                if (el.lineType !== yMap.get('lineType')) yMap.set('lineType', el.lineType);
                if (el.curvature !== yMap.get('curvature')) yMap.set('curvature', el.curvature);
                const sbJson = el.startBinding ? JSON.stringify(el.startBinding) : null;
                if (sbJson !== yMap.get('startBinding')) yMap.set('startBinding', sbJson);
                const ebJson = el.endBinding ? JSON.stringify(el.endBinding) : null;
                if (ebJson !== yMap.get('endBinding')) yMap.set('endBinding', ebJson);
                if (el.type === 'arrow') {
                    if (el.startArrowhead !== yMap.get('startArrowhead')) yMap.set('startArrowhead', el.startArrowhead);
                    if (el.endArrowhead !== yMap.get('endArrowhead')) yMap.set('endArrowhead', el.endArrowhead);
                }
                break;
            }
            case 'freedraw': {
                const fpJson = JSON.stringify(el.points);
                if (fpJson !== yMap.get('points')) yMap.set('points', fpJson);
                break;
            }
            case 'text':
                if (el.text !== yMap.get('text')) yMap.set('text', el.text);
                if (el.containerId !== yMap.get('containerId')) yMap.set('containerId', el.containerId);
                if (el.textAlign !== yMap.get('textAlign')) yMap.set('textAlign', el.textAlign);
                if (el.verticalAlign !== yMap.get('verticalAlign')) yMap.set('verticalAlign', el.verticalAlign);
                break;
            case 'image':
                if (el.src !== yMap.get('src')) yMap.set('src', el.src);
                if (el.naturalWidth !== yMap.get('naturalWidth')) yMap.set('naturalWidth', el.naturalWidth);
                if (el.naturalHeight !== yMap.get('naturalHeight')) yMap.set('naturalHeight', el.naturalHeight);
                if (el.scaleMode !== yMap.get('scaleMode')) yMap.set('scaleMode', el.scaleMode);
                const cropJson = el.crop ? JSON.stringify(el.crop) : null;
                if (cropJson !== yMap.get('crop')) yMap.set('crop', cropJson);
                if (el.cornerRadius !== yMap.get('cornerRadius')) yMap.set('cornerRadius', el.cornerRadius);
                if (el.alt !== yMap.get('alt')) yMap.set('alt', el.alt);
                break;
        }
    }

    private _yMapCollectionToElements(yElements: Y.Map<Y.Map<unknown>>): CanvasElement[] {
        const elements: CanvasElement[] = [];
        for (const [, yMap] of yElements.entries()) {
            const el = yMapToElement(yMap);
            if (el) elements.push(el);
        }
        elements.sort((a, b) => {
            if (a.sortOrder && b.sortOrder) {
                return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0;
            }
            return 0;
        });
        return elements;
    }
}
