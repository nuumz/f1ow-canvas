/**
 * collaboration/syncWorker.worker.ts — Web Worker implementation.
 *
 * Runs Yjs document + WebSocket provider + sync logic entirely off the
 * main thread. Communicates with the main thread via postMessage.
 *
 * This file is designed to be imported via Vite's `new Worker(new URL(...))`.
 */

// Import Yjs (yjs and y-websocket are pure JS — no DOM dependency)
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { WorkerInMessage, WorkerOutMessage } from './syncWorker';
import type { CanvasElement } from '@/types';
import type { AwarenessState, CollaborationConfig } from './types';
import { elementToYMap, yMapToElement, SYNC_FIELDS, STYLE_FIELDS } from './syncBridgeCodec';

// ─── Worker State ─────────────────────────────────────────────

let _doc: Y.Doc | null = null;
let _provider: WebsocketProvider | null = null;
let _isApplyingRemote = false;
let _isApplyingLocal = false;
let _lastElements: CanvasElement[] = [];
let _syncTimer: ReturnType<typeof setTimeout> | null = null;
let _deepTimer: ReturnType<typeof setTimeout> | null = null;
const _dirtyIds = new Set<string>();
let _syncDebounceMs = 50;

// ─── Post Message Helper ─────────────────────────────────────

function post(msg: WorkerOutMessage): void {
    self.postMessage(msg);
}

// ─── Y.Map Collection Helpers ─────────────────────────────────

function yMapCollectionToElements(yElements: Y.Map<Y.Map<unknown>>): CanvasElement[] {
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

function updateYMapFromElement(el: CanvasElement, yMap: Y.Map<unknown>): void {
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

// ─── Connect / Disconnect ─────────────────────────────────────

function connect(config: CollaborationConfig, syncDebounceMs: number): void {
    disconnect();

    _syncDebounceMs = syncDebounceMs;
    _doc = new Y.Doc();

    _provider = new WebsocketProvider(
        config.serverUrl,
        config.roomName,
        _doc,
        {
            connect: true,
            params: config.authToken ? { token: config.authToken } : undefined,
        },
    );

    // Awareness
    _provider.awareness.setLocalState({
        user: config.user,
        cursor: null,
        selectedIds: [],
    } satisfies AwarenessState);

    // Status events
    _provider.on('status', (event: { status: string }) => {
        post({ type: 'status', status: event.status as WorkerOutMessage extends { type: 'status'; status: infer S } ? S : never });
    });

    // Awareness changes → peers
    _provider.awareness.on('change', () => {
        if (!_provider) return;
        const all = _provider.awareness.getStates();
        const localId = _provider.awareness.clientID;
        const peers: AwarenessState[] = [];
        for (const [clientId, state] of all) {
            if (clientId !== localId && state && (state as AwarenessState).user) {
                peers.push(state as AwarenessState);
            }
        }
        post({ type: 'peers', peers });
    });

    // Start sync
    const yElements = _doc.getMap('elements') as Y.Map<Y.Map<unknown>>;

    // Initial sync: if Yjs has data, send to main thread
    if (yElements.size > 0) {
        const elements = yMapCollectionToElements(yElements);
        _lastElements = elements;
        post({ type: 'remote-update', elements });
    }

    // Yjs observers → post remote-update
    yElements.observe((events, transaction) => {
        if (transaction.origin === 'local-sync' || transaction.origin === 'local-init') return;
        if (_isApplyingLocal) return;

        _isApplyingRemote = true;
        let elements = [..._lastElements];
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
            _lastElements = elements;
            post({ type: 'remote-update', elements });
        }
        _isApplyingRemote = false;
    });

    yElements.observeDeep((events) => {
        if (_isApplyingLocal) return;

        for (const event of events) {
            let target: Y.AbstractType<unknown> | null = event.target;
            while (target && !(target instanceof Y.Map && target.parent === yElements)) {
                target = target.parent as Y.AbstractType<unknown> | null;
            }
            if (target instanceof Y.Map) {
                const id = target.get('id') as string;
                if (id) _dirtyIds.add(id);
            }
        }

        if (_deepTimer) clearTimeout(_deepTimer);
        _deepTimer = setTimeout(() => {
            if (_dirtyIds.size === 0 || _isApplyingLocal) return;

            _isApplyingRemote = true;
            let elements = [..._lastElements];
            let changed = false;

            for (const id of _dirtyIds) {
                const yMap = yElements.get(id);
                if (!yMap) continue;
                const el = yMapToElement(yMap);
                if (!el) continue;
                const idx = elements.findIndex(e => e.id === id);
                if (idx >= 0) { elements[idx] = el; changed = true; }
            }
            _dirtyIds.clear();

            if (changed) {
                _lastElements = elements;
                post({ type: 'remote-update', elements });
            }
            _isApplyingRemote = false;
        }, 16);
    });
}

function disconnect(): void {
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    if (_deepTimer) { clearTimeout(_deepTimer); _deepTimer = null; }
    _dirtyIds.clear();

    if (_provider) {
        _provider.awareness.setLocalState(null);
        _provider.disconnect();
        _provider.destroy();
        _provider = null;
    }
    if (_doc) {
        _doc.destroy();
        _doc = null;
    }
    _lastElements = [];
    _isApplyingRemote = false;
    _isApplyingLocal = false;

    post({ type: 'status', status: 'disconnected' });
}

// ─── Local Update Handler ─────────────────────────────────────

function handleLocalUpdate(elements: CanvasElement[]): void {
    if (!_doc || _isApplyingRemote) return;
    if (elements === _lastElements) return;

    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => {
        if (!_doc) return;
        const yElements = _doc.getMap('elements') as Y.Map<Y.Map<unknown>>;

        _isApplyingLocal = true;
        _lastElements = elements;

        const localMap = new Map<string, CanvasElement>();
        for (const el of elements) localMap.set(el.id, el);

        _doc.transact(() => {
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
                    updateYMapFromElement(el, yMap);
                }
            }
        }, 'local-sync');

        _isApplyingLocal = false;
    }, _syncDebounceMs);
}

// ─── Awareness Update Handler ─────────────────────────────────

function handleAwareness(msg: Extract<WorkerInMessage, { type: 'awareness' }>): void {
    if (!_provider) return;
    const current = _provider.awareness.getLocalState() as AwarenessState | null;
    const update: Partial<AwarenessState> = { cursor: msg.cursor };
    if (msg.selectedIds) update.selectedIds = msg.selectedIds;
    if (msg.activeTool) update.activeTool = msg.activeTool;
    _provider.awareness.setLocalState({ ...current, ...update });
}

// ─── Message Router ───────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
    const msg = e.data;
    try {
        switch (msg.type) {
            case 'connect':
                connect(msg.config, msg.syncDebounceMs);
                break;
            case 'disconnect':
                disconnect();
                break;
            case 'local-update':
                handleLocalUpdate(msg.elements);
                break;
            case 'awareness':
                handleAwareness(msg);
                break;
        }
    } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
};
