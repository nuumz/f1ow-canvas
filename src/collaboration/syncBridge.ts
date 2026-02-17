/**
 * collaboration/syncBridge.ts — Bidirectional sync between Yjs and Zustand store.
 *
 * This is the heart of the CRDT collaboration layer. It maintains two-way
 * synchronization between:
 *   - Y.Map<Y.Map> (Yjs shared document — source of truth for collaboration)
 *   - useCanvasStore.elements[] (Zustand — source of truth for rendering)
 *
 * Sync directions:
 *   1. **Local → Remote**: When the local user edits elements, changes are
 *      detected and written to Yjs, which replicates them to other clients.
 *   2. **Remote → Local**: When Yjs receives changes from other clients,
 *      the observer updates the Zustand store to re-render.
 *
 * Conflict resolution:
 *   - Yjs provides Last-Writer-Wins (LWW) semantics per field.
 *   - Concurrent moves (dx, dy) use delta-based operations for commutativity.
 *   - Z-ordering uses fractional indices (no conflicts possible).
 *
 * Performance:
 *   - Batches Yjs transactions (one Y.Doc.transact per change batch)
 *   - Debounced local→remote sync (default 50ms)
 *   - Incremental updates (only changed fields are synced)
 */
import * as Y from 'yjs';
import type { CanvasElement } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';
import { getYDoc, getYElements } from './yjsProvider';
import {
    elementToYMap,
    yMapToElement,
    SYNC_FIELDS,
    STYLE_FIELDS,
} from './syncBridgeCodec';

// ─── Sync Bridge ──────────────────────────────────────────────

/** Flag to prevent echo loops (local change → Yjs → observer → Zustand → ∞) */
let _isApplyingRemote = false;
/** Flag to prevent Zustand sub → Yjs write echo */
let _isApplyingLocal = false;
/** Zustand unsubscribe function */
let _unsubscribe: (() => void) | null = null;
/** Yjs observer unsubscribe */
let _yObserverCleanup: (() => void) | null = null;
/** Debounce timer for local → Yjs */
let _syncTimer: ReturnType<typeof setTimeout> | null = null;
/** Last known elements reference for shallow comparison */
let _lastElements: CanvasElement[] = [];

/**
 * Start bidirectional synchronization between Yjs and Zustand.
 * Call this after `createCollaborationProvider()`.
 *
 * @param debounceMs - Debounce interval for local→Yjs sync (default: 50ms)
 */
export function startSync(debounceMs = 50): void {
    const doc = getYDoc();
    const yElements = getYElements();
    if (!doc || !yElements) {
        console.warn('[SyncBridge] Cannot start sync — no Yjs doc');
        return;
    }

    // Stop any existing sync
    stopSync();

    // ─── 1. Initial sync: Yjs → Zustand (remote state wins) ──
    // If Yjs already has elements (reconnecting to an existing room),
    // load them into the store.
    if (yElements.size > 0) {
        _isApplyingRemote = true;
        const elements = yMapCollectionToElements(yElements);
        useCanvasStore.getState().setElements(elements);
        _lastElements = elements;
        _isApplyingRemote = false;
    } else {
        // Yjs is empty — push local elements to Yjs
        const localElements = useCanvasStore.getState().elements;
        if (localElements.length > 0) {
            _isApplyingLocal = true;
            doc.transact(() => {
                for (const el of localElements) {
                    const yMap = new Y.Map<unknown>();
                    elementToYMap(el, yMap);
                    yElements.set(el.id, yMap as Y.Map<unknown>);
                }
            }, 'local-init');
            _isApplyingLocal = false;
        }
        _lastElements = localElements;
    }

    // ─── 2. Yjs → Zustand (remote changes) ───────────────────
    const yObserver = (events: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) => {
        // Skip if this change originated from local sync
        if (transaction.origin === 'local-sync' || transaction.origin === 'local-init') return;
        if (_isApplyingLocal) return;

        _isApplyingRemote = true;

        // Handle top-level adds/deletes incrementally
        const store = useCanvasStore.getState();
        let elements = [..._lastElements];
        let changed = false;

        // Process added/updated keys
        for (const [key, change] of events.keys) {
            if (change.action === 'add' || change.action === 'update') {
                const yMap = yElements.get(key);
                if (yMap) {
                    const el = yMapToElement(yMap);
                    if (el) {
                        const idx = elements.findIndex(e => e.id === key);
                        if (idx >= 0) {
                            elements[idx] = el;
                        } else {
                            elements.push(el);
                        }
                        changed = true;
                    }
                }
            } else if (change.action === 'delete') {
                elements = elements.filter(e => e.id !== key);
                changed = true;
            }
        }

        if (changed) {
            // Re-sort by sortOrder
            elements.sort((a, b) => {
                if (a.sortOrder && b.sortOrder) {
                    return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0;
                }
                return 0;
            });
            store.setElements(elements);
            _lastElements = elements;
        }

        _isApplyingRemote = false;
    };

    // Deep observer handles individual field changes within Y.Maps.
    // Instead of rebuilding ALL elements, only update the specific changed elements.
    let _deepObserverTimer: ReturnType<typeof setTimeout> | null = null;
    const _dirtyElementIds = new Set<string>();

    const deepObserver = (events: Y.YEvent<Y.Map<unknown>>[]) => {
        if (_isApplyingLocal) return;

        // Collect IDs of elements that had field-level changes
        for (const event of events) {
            // Walk up to find the element Y.Map and extract its ID
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let target: any = event.target;
            while (target && !(target instanceof Y.Map && target.parent === yElements)) {
                target = target.parent;
            }
            if (target instanceof Y.Map) {
                const id = target.get('id') as string;
                if (id) _dirtyElementIds.add(id);
            }
        }

        // Debounce: batch rapid deep changes (e.g. during collaborative drag)
        if (_deepObserverTimer) clearTimeout(_deepObserverTimer);
        _deepObserverTimer = setTimeout(() => {
            if (_dirtyElementIds.size === 0 || _isApplyingLocal) return;

            _isApplyingRemote = true;
            let elements = [..._lastElements];
            let changed = false;

            for (const id of _dirtyElementIds) {
                const yMap = yElements.get(id);
                if (!yMap) continue;
                const el = yMapToElement(yMap);
                if (!el) continue;

                const idx = elements.findIndex(e => e.id === id);
                if (idx >= 0) {
                    elements[idx] = el;
                    changed = true;
                }
            }

            _dirtyElementIds.clear();

            if (changed) {
                useCanvasStore.getState().setElements(elements);
                _lastElements = elements;
            }

            _isApplyingRemote = false;
        }, 16); // ~1 frame debounce for deep changes
    };

    yElements.observe(yObserver);
    yElements.observeDeep(deepObserver);

    _yObserverCleanup = () => {
        yElements.unobserve(yObserver);
        yElements.unobserveDeep(deepObserver);
        if (_deepObserverTimer) clearTimeout(_deepObserverTimer);
        _dirtyElementIds.clear();
    };

    // ─── 3. Zustand → Yjs (local changes) ────────────────────
    _unsubscribe = useCanvasStore.subscribe(
        (state) => {
            if (_isApplyingRemote) return;

            // Shallow reference check — only sync if elements actually changed
            if (state.elements === _lastElements) return;

            // Debounce: batch rapid changes (drag, continuous resize)
            if (_syncTimer) clearTimeout(_syncTimer);
            _syncTimer = setTimeout(() => {
                syncLocalToYjs(state.elements, yElements, doc);
            }, debounceMs);
        },
    );
}

/**
 * Stop synchronization and clean up listeners.
 */
export function stopSync(): void {
    if (_unsubscribe) {
        _unsubscribe();
        _unsubscribe = null;
    }
    if (_yObserverCleanup) {
        _yObserverCleanup();
        _yObserverCleanup = null;
    }
    if (_syncTimer) {
        clearTimeout(_syncTimer);
        _syncTimer = null;
    }
    _lastElements = [];
}

// ─── Internal helpers ─────────────────────────────────────────

/**
 * Sync local elements to Yjs (incremental diff).
 * Only adds/removes/updates elements that actually changed.
 */
function syncLocalToYjs(
    elements: CanvasElement[],
    yElements: Y.Map<Y.Map<unknown>>,
    doc: Y.Doc,
): void {
    _isApplyingLocal = true;
    _lastElements = elements;

    const localMap = new Map<string, CanvasElement>();
    for (const el of elements) {
        localMap.set(el.id, el);
    }

    doc.transact(() => {
        // Remove deleted elements from Yjs
        for (const [id] of yElements.entries()) {
            if (!localMap.has(id)) {
                yElements.delete(id);
            }
        }

        // Add new / update existing elements
        for (const el of elements) {
            let yMap = yElements.get(el.id);
            if (!yMap) {
                // New element — create Y.Map
                yMap = new Y.Map<unknown>();
                elementToYMap(el, yMap);
                yElements.set(el.id, yMap as Y.Map<unknown>);
            } else {
                // Existing — update only changed fields (incremental)
                updateYMapFromElement(el, yMap);
            }
        }
    }, 'local-sync');

    _isApplyingLocal = false;
}

/**
 * Update a Y.Map with only the fields that changed from the element.
 * Avoids unnecessary Yjs operations (which create network traffic).
 */
function updateYMapFromElement(el: CanvasElement, yMap: Y.Map<unknown>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elRecord = el as unknown as Record<string, unknown>;
    for (const field of SYNC_FIELDS) {
        const value = elRecord[field];
        if (value !== yMap.get(field)) {
            yMap.set(field, value);
        }
    }

    // Style fields
    if (el.style) {
        for (const sf of STYLE_FIELDS) {
            const val = el.style[sf];
            if (val !== yMap.get(`style.${sf}`)) {
                yMap.set(`style.${sf}`, val);
            }
        }
    }

    // Bound elements
    const beJson = el.boundElements ? JSON.stringify(el.boundElements) : null;
    if (beJson !== yMap.get('boundElements')) {
        yMap.set('boundElements', beJson);
    }

    // Type-specific
    switch (el.type) {
        case 'rectangle':
            if (el.cornerRadius !== yMap.get('cornerRadius')) {
                yMap.set('cornerRadius', el.cornerRadius);
            }
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

/**
 * Convert all Y.Maps in the shared collection to CanvasElements.
 * Preserves z-order using sortOrder if available, otherwise insertion order.
 */
function yMapCollectionToElements(yElements: Y.Map<Y.Map<unknown>>): CanvasElement[] {
    const elements: CanvasElement[] = [];
    for (const [, yMap] of yElements.entries()) {
        const el = yMapToElement(yMap);
        if (el) elements.push(el);
    }

    // Sort by sortOrder if available, otherwise preserve Yjs insertion order
    elements.sort((a, b) => {
        if (a.sortOrder && b.sortOrder) {
            return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0;
        }
        return 0;
    });

    return elements;
}
