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
import {
    createCollaborationProvider,
    destroyCollaborationProvider,
    updateAwareness,
    getRemoteAwareness,
    getYProvider,
    onStatusChange,
} from './yjsProvider';
import { startSync, stopSync } from './syncBridge';
import { useCanvasStore } from '@/store/useCanvasStore';

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

    // ─── Connection lifecycle ─────────────────────────────────
    useEffect(() => {
        if (!config) {
            destroyCollaborationProvider();
            stopSync();
            setConnectionStatus('disconnected');
            setPeers([]);
            return;
        }

        // Create provider + start sync
        const { provider } = createCollaborationProvider(config);
        startSync(config.syncDebounceMs ?? 50);

        // Listen to status changes
        const unsubStatus = onStatusChange(setConnectionStatus);

        // Listen to awareness changes (peer cursors/selections)
        const awarenessHandler = () => {
            const remote = getRemoteAwareness();
            setPeers(Array.from(remote.values()));
        };
        provider.awareness.on('change', awarenessHandler);

        // Sync local selection → awareness
        const unsubStore = useCanvasStore.subscribe(
            (state, prevState) => {
                if (state.selectedIds !== prevState.selectedIds) {
                    updateAwareness({ selectedIds: state.selectedIds });
                }
                if (state.activeTool !== prevState.activeTool) {
                    updateAwareness({ activeTool: state.activeTool });
                }
            },
        );

        return () => {
            unsubStatus();
            unsubStore();
            provider.awareness.off('change', awarenessHandler);
            stopSync();
            destroyCollaborationProvider();
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
        updateAwareness({ cursor: position });
    }, []);

    // ─── Manual connect/disconnect ────────────────────────────
    const disconnect = useCallback(() => {
        const provider = getYProvider();
        if (provider) {
            provider.disconnect();
        }
    }, []);

    const reconnect = useCallback(() => {
        const provider = getYProvider();
        if (provider) {
            provider.connect();
        }
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
