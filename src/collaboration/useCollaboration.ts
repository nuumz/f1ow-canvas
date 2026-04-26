/**
 * collaboration/useCollaboration.ts — React hook for CRDT collaboration.
 *
 * Provides a simple, declarative API for enabling real-time collaboration
 * on a FlowCanvas instance. Manages the full lifecycle:
 *   1. Create Yjs document + WebSocket provider
 *   2. Start bidirectional sync with Zustand store
 *   3. Share cursor/selection awareness
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
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { CollaborationConfig, ConnectionStatus, AwarenessState } from './types';
// NOTE: `yjsProvider` and `syncBridge` are imported dynamically below to keep
// `yjs` and `y-websocket` as truly optional peer dependencies. Importing them
// statically here would force every consumer (even those not using
// collaboration) to install `yjs`, defeating the optional peer metadata.
import type * as YjsProviderModule from './yjsProvider';
import type * as SyncBridgeModule from './syncBridge';
import { useCanvasStore } from '@/store/useCanvasStore';

// ─── Lazy module loading ──────────────────────────────────────

let _modulesPromise: Promise<{
    yjsProvider: typeof YjsProviderModule;
    syncBridge: typeof SyncBridgeModule;
}> | null = null;

function loadCollabModules() {
    if (!_modulesPromise) {
        _modulesPromise = Promise.all([
            import('./yjsProvider'),
            import('./syncBridge'),
        ]).then(([yjsProvider, syncBridge]) => ({ yjsProvider, syncBridge }));
    }
    return _modulesPromise;
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
 * `yjs` and `y-websocket` are loaded via dynamic `import()` only when
 * `config` is non-null, so apps that never enable collaboration do not
 * need those packages installed.
 */
export function useCollaboration(
    config: CollaborationConfig | null,
): UseCollaborationReturn {
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
    const [peers, setPeers] = useState<AwarenessState[]>([]);
    const configRef = useRef(config);
    configRef.current = config;

    // Track awarenessThrottleMs for cursor updates
    const throttleRef = useRef(config?.awarenessThrottleMs ?? 100);
    const lastCursorUpdateRef = useRef(0);
    const modulesRef = useRef<{
        yjsProvider: typeof YjsProviderModule;
        syncBridge: typeof SyncBridgeModule;
    } | null>(null);

    // ─── Connection lifecycle ─────────────────────────────────
    useEffect(() => {
        if (!config) {
            // If a previous activation loaded the modules, tear them down.
            const loaded = modulesRef.current;
            if (loaded) {
                loaded.yjsProvider.destroyCollaborationProvider();
                loaded.syncBridge.stopSync();
            }
            setConnectionStatus('disconnected');
            setPeers([]);
            return;
        }

        let cancelled = false;
        let cleanup: (() => void) | null = null;

        loadCollabModules()
            .then((mods) => {
                if (cancelled) return;
                modulesRef.current = mods;
                const { createCollaborationProvider, onStatusChange, getRemoteAwareness, updateAwareness } =
                    mods.yjsProvider;
                const { startSync, stopSync } = mods.syncBridge;

                const { provider } = createCollaborationProvider(config);
                startSync(config.syncDebounceMs ?? 50);

                const unsubStatus = onStatusChange(setConnectionStatus);

                const awarenessHandler = () => {
                    const remote = getRemoteAwareness();
                    setPeers(Array.from(remote.values()));
                };
                provider.awareness.on('change', awarenessHandler);

                const unsubStore = useCanvasStore.subscribe((state, prevState) => {
                    if (state.selectedIds !== prevState.selectedIds) {
                        updateAwareness({ selectedIds: state.selectedIds });
                    }
                    if (state.activeTool !== prevState.activeTool) {
                        updateAwareness({ activeTool: state.activeTool });
                    }
                });

                cleanup = () => {
                    unsubStatus();
                    unsubStore();
                    provider.awareness.off('change', awarenessHandler);
                    stopSync();
                    mods.yjsProvider.destroyCollaborationProvider();
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
        // Re-create if server/room/user changes
        config?.serverUrl,
        config?.roomName,
        config?.user.id,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        config?.syncDebounceMs,
    ]);

    // ─── Cursor update (throttled) ────────────────────────────
    const updateCursor = useCallback((position: { x: number; y: number } | null) => {
        const now = Date.now();
        if (now - lastCursorUpdateRef.current < throttleRef.current) return;
        lastCursorUpdateRef.current = now;
        modulesRef.current?.yjsProvider.updateAwareness({ cursor: position });
    }, []);

    // ─── Manual connect/disconnect ────────────────────────────
    const disconnect = useCallback(() => {
        const provider = modulesRef.current?.yjsProvider.getYProvider();
        if (provider) provider.disconnect();
    }, []);

    const reconnect = useCallback(() => {
        const provider = modulesRef.current?.yjsProvider.getYProvider();
        if (provider) provider.connect();
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
