/**
 * collaboration/useCollaboration.ts — React hook for CRDT collaboration.
 *
 * Declarative API for enabling real-time, genuinely-convergent collaboration on
 * a FlowCanvas instance. Drives a single {@link CollaborationManager} (the
 * consolidated instance-scoped engine) through its full lifecycle:
 *   1. Create Yjs document + WebSocket provider (via the manager)
 *   2. Start op-based bidirectional sync with the canvas store
 *   3. Share cursor / selection / tool awareness
 *   4. Clean up on unmount
 *
 * Usage:
 * ```tsx
 * function App() {
 *   const { isConnected, peers, connectionStatus } = useCollaboration({
 *     serverUrl: 'wss://yjs.example.com',
 *     roomName: 'my-canvas-room',
 *     user: { id: 'user-1', name: 'Alice', color: '#ff6b6b' },
 *   });
 *
 *   return <FlowCanvas />;
 * }
 * ```
 *
 * `yjs` / `y-websocket` stay optional peer dependencies: `CollaborationManager`
 * (which statically imports them) is loaded via dynamic `import()` only when
 * `config` is non-null, so apps that never enable collaboration do not need
 * those packages installed.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { CollaborationConfig, ConnectionStatus, AwarenessState } from './types';
import type { CollaborationManager as CollaborationManagerClass } from './CollaborationManager';
import { useCanvasStore, type CanvasStore } from '@/store/useCanvasStore';

// ─── Lazy module loading ──────────────────────────────────────

let _managerModulePromise: Promise<typeof import('./CollaborationManager')> | null = null;

function loadManagerModule() {
    if (!_managerModulePromise) {
        _managerModulePromise = import('./CollaborationManager');
    }
    return _managerModulePromise;
}

// ─── Hook Return Type ─────────────────────────────────────────

export interface UseCollaborationReturn {
    /** Whether the WebSocket connection is established */
    isConnected: boolean;
    /** Detailed connection status */
    connectionStatus: ConnectionStatus;
    /** Remote peers awareness states */
    peers: AwarenessState[];
    /** Manually disconnect from collaboration */
    disconnect: () => void;
    /** Manually reconnect after disconnect */
    reconnect: () => void;
    /** Update local cursor position (call from mouse move handler) */
    updateCursor: (position: { x: number; y: number } | null) => void;
}

/**
 * React hook to enable CRDT collaboration on the canvas.
 * Pass `null` as config to disable collaboration.
 *
 * @param config collaboration config, or `null` to disable
 * @param store  the canvas store to mirror. Defaults to the module-level
 *   `useCanvasStore` singleton so existing single-instance call sites keep
 *   working unchanged; multi-instance wiring passes the per-instance store.
 */
export function useCollaboration(
    config: CollaborationConfig | null,
    store: CanvasStore = useCanvasStore,
): UseCollaborationReturn {
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
    const [peers, setPeers] = useState<AwarenessState[]>([]);

    // Keep cursor throttle current without re-running the connection effect.
    const throttleRef = useRef(config?.awarenessThrottleMs ?? 100);
    throttleRef.current = config?.awarenessThrottleMs ?? 100;
    const lastCursorUpdateRef = useRef(0);

    const managerRef = useRef<CollaborationManagerClass | null>(null);

    // ─── Connection lifecycle ─────────────────────────────────
    useEffect(() => {
        if (!config) {
            // Tear down any previously-created manager.
            managerRef.current?.dispose();
            managerRef.current = null;
            setConnectionStatus('disconnected');
            setPeers([]);
            return;
        }

        // Gate: live collaboration is disabled by default due to a known
        // data-loss bug — a remote edit arriving within the local sync debounce
        // window can drop a peer's concurrent change and leave the two clients'
        // documents permanently divergent (`syncEngine._applyRemote`). Require
        // an explicit `experimental: true` acknowledgement before connecting.
        if (!config.experimental) {
            console.warn(
                '[f1ow] Live collaboration is disabled by default: a known data-loss bug ' +
                    'can drop concurrent edits made within the sync debounce window and leave ' +
                    'peers permanently divergent. Set `collaboration.experimental = true` to ' +
                    'enable it at your own risk (not production-ready).',
            );
            managerRef.current?.dispose();
            managerRef.current = null;
            setConnectionStatus('disconnected');
            setPeers([]);
            return;
        }

        let cancelled = false;
        let cleanup: (() => void) | null = null;

        loadManagerModule()
            .then(({ CollaborationManager }) => {
                if (cancelled) return;

                const mgr = new CollaborationManager();
                managerRef.current = mgr;

                mgr.connect(config);
                mgr.startSync(store, config.syncDebounceMs ?? 50);

                const unsubStatus = mgr.onStatusChange(setConnectionStatus);

                const awarenessHandler = () => {
                    const remote = mgr.getRemoteAwareness();
                    // Carry the Yjs clientID onto each peer so the cursor overlay
                    // can key by it (same user in two tabs shares user.id but has
                    // distinct clientIDs).
                    setPeers(Array.from(remote, ([clientID, state]) => ({ ...state, clientID })));
                };
                mgr.provider?.awareness.on('change', awarenessHandler);

                // Share selection / tool presence from the resolved store.
                const unsubStore = store.subscribe((state, prevState) => {
                    if (state.selectedIds !== prevState.selectedIds) {
                        mgr.updateAwareness({ selectedIds: state.selectedIds });
                    }
                    if (state.activeTool !== prevState.activeTool) {
                        mgr.updateAwareness({ activeTool: state.activeTool });
                    }
                });

                cleanup = () => {
                    unsubStatus();
                    unsubStore();
                    mgr.provider?.awareness.off('change', awarenessHandler);
                    mgr.dispose();
                    managerRef.current = null;
                };
            })
            .catch((err) => {
                // Surface a clear message when optional deps are missing.
                console.error(
                    '[f1ow] Failed to load collaboration modules. ' +
                        'Ensure `yjs` and `y-websocket` are installed when collaboration is enabled.',
                    err,
                );
                setConnectionStatus('disconnected');
            });

        return () => {
            cancelled = true;
            if (cleanup) cleanup();
            setConnectionStatus('disconnected');
            setPeers([]);
        };
    }, [
        // Re-create if server/room/user/store changes
        config?.serverUrl,
        config?.roomName,
        config?.user.id,
        config?.experimental,
        store,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        config?.syncDebounceMs,
    ]);

    // ─── Cursor update (throttled) ────────────────────────────
    const updateCursor = useCallback((position: { x: number; y: number } | null) => {
        // Leave/clear (null) must propagate immediately — if it gets dropped
        // inside the throttle window the peer's cursor stays stuck on screen.
        if (position === null) {
            lastCursorUpdateRef.current = Date.now();
            managerRef.current?.updateAwareness({ cursor: null });
            return;
        }
        const now = Date.now();
        if (now - lastCursorUpdateRef.current < throttleRef.current) return;
        lastCursorUpdateRef.current = now;
        managerRef.current?.updateAwareness({ cursor: position });
    }, []);

    // ─── Manual connect/disconnect ────────────────────────────
    const disconnect = useCallback(() => {
        managerRef.current?.provider?.disconnect();
    }, []);

    const reconnect = useCallback(() => {
        managerRef.current?.provider?.connect();
    }, []);

    return {
        isConnected: connectionStatus === 'connected',
        connectionStatus,
        peers,
        disconnect,
        reconnect,
        updateCursor,
    };
}
