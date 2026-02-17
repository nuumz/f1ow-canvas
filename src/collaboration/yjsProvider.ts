/**
 * collaboration/yjsProvider.ts — Yjs document + WebSocket provider management.
 *
 * Creates and manages:
 *   - Y.Doc: the shared CRDT document
 *   - Y.Map<Y.Map>: shared element state ("elements" map)
 *   - WebsocketProvider: network transport
 *   - Awareness: cursor/selection sharing protocol
 *
 * Lifecycle:
 *   1. `createCollaborationProvider(config)` — creates doc + provider
 *   2. Provider auto-connects on creation
 *   3. `destroyCollaborationProvider()` — disconnects + cleans up
 *
 * This module is intentionally separated from React — it's a plain
 * TypeScript singleton that can be used in any context. The React
 * integration lives in `useCollaboration.ts`.
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { CollaborationConfig, ConnectionStatus, AwarenessState } from './types';

// ─── State ────────────────────────────────────────────────────

let _doc: Y.Doc | null = null;
let _provider: WebsocketProvider | null = null;
let _config: CollaborationConfig | null = null;
let _statusListeners: Set<(status: ConnectionStatus) => void> = new Set();

// ─── Public API ───────────────────────────────────────────────

/**
 * Create (or re-create) the Yjs collaboration provider.
 * If a provider already exists, it will be destroyed first.
 */
export function createCollaborationProvider(config: CollaborationConfig): {
    doc: Y.Doc;
    provider: WebsocketProvider;
} {
    // Clean up existing
    if (_provider) {
        destroyCollaborationProvider();
    }

    _config = config;
    _doc = new Y.Doc();

    // Connect to WebSocket server
    _provider = new WebsocketProvider(
        config.serverUrl,
        config.roomName,
        _doc,
        {
            connect: true,
            params: config.authToken ? { token: config.authToken } : undefined,
        },
    );

    // Set local awareness state
    _provider.awareness.setLocalState({
        user: config.user,
        cursor: null,
        selectedIds: [],
    } satisfies AwarenessState);

    // Forward connection status changes
    _provider.on('status', (event: { status: string }) => {
        const status = event.status as ConnectionStatus;
        for (const listener of _statusListeners) {
            listener(status);
        }
    });

    return { doc: _doc, provider: _provider };
}

/**
 * Destroy the current collaboration provider and clean up resources.
 */
export function destroyCollaborationProvider(): void {
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
    _config = null;
}

// ─── Accessors ────────────────────────────────────────────────

/** Get the shared Y.Doc (null if not connected) */
export function getYDoc(): Y.Doc | null {
    return _doc;
}

/** Get the WebSocket provider (null if not connected) */
export function getYProvider(): WebsocketProvider | null {
    return _provider;
}

/** Get the shared Y.Map for elements (creates it on first access) */
export function getYElements(): Y.Map<Y.Map<unknown>> | null {
    return _doc?.getMap('elements') as Y.Map<Y.Map<unknown>> | null;
}

/** Get the current provider config */
export function getCollaborationConfig(): CollaborationConfig | null {
    return _config;
}

/** Whether collaboration is currently active */
export function isCollaborationActive(): boolean {
    return _provider !== null && _provider.wsconnected;
}

// ─── Status Listeners ─────────────────────────────────────────

/** Subscribe to connection status changes */
export function onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    _statusListeners.add(listener);
    return () => {
        _statusListeners.delete(listener);
    };
}

// ─── Awareness helpers ────────────────────────────────────────

/**
 * Update the local user's awareness state (cursor position, selection, etc.).
 * Partial update — merges with existing state.
 */
export function updateAwareness(update: Partial<AwarenessState>): void {
    if (!_provider) return;
    const current = _provider.awareness.getLocalState() as AwarenessState | null;
    _provider.awareness.setLocalState({
        ...current,
        ...update,
    });
}

/**
 * Get all remote awareness states (excluding local).
 * Returns a Map<clientId, AwarenessState>.
 */
export function getRemoteAwareness(): Map<number, AwarenessState> {
    if (!_provider) return new Map();
    const all = _provider.awareness.getStates();
    const localId = _provider.awareness.clientID;
    const remote = new Map<number, AwarenessState>();
    for (const [clientId, state] of all) {
        if (clientId !== localId && state && (state as AwarenessState).user) {
            remote.set(clientId, state as AwarenessState);
        }
    }
    return remote;
}
