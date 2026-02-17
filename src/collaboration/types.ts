/**
 * collaboration/types.ts — Types for the CRDT collaboration layer.
 *
 * Defines the interfaces used by the Yjs ↔ Zustand sync bridge,
 * awareness (cursor/selection sharing), and provider configuration.
 */

/** User/client identity for collaboration */
export interface CollaborationUser {
    /** Unique client ID (persisted across sessions) */
    id: string;
    /** Display name */
    name: string;
    /** Cursor/highlight color (CSS color string) */
    color: string;
    /** Optional avatar URL */
    avatar?: string;
}

/** Remote user's awareness state (cursor + selection) */
export interface AwarenessState {
    user: CollaborationUser;
    /** World-space cursor position (null = cursor outside canvas) */
    cursor: { x: number; y: number } | null;
    /** IDs of elements selected by this user */
    selectedIds: string[];
    /** Tool the user is currently using */
    activeTool?: string;
    /** Viewport for follow-mode */
    viewport?: { x: number; y: number; scale: number };
}

/** Configuration for the collaboration provider */
export interface CollaborationConfig {
    /** WebSocket server URL (e.g., "wss://yjs.example.com") */
    serverUrl: string;
    /** Room name — users in the same room collaborate on the same doc */
    roomName: string;
    /** Local user identity */
    user: CollaborationUser;
    /**
     * Optional authentication token sent to the server.
     * Passed as a query parameter or in the WebSocket handshake.
     */
    authToken?: string;
    /**
     * Debounce interval (ms) for syncing local changes to Yjs.
     * Lower = more responsive but more network traffic.
     * @default 50
     */
    syncDebounceMs?: number;
    /**
     * Throttle interval (ms) for awareness updates (cursor, selection).
     * @default 100
     */
    awarenessThrottleMs?: number;
}

/** Collaboration connection status */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Collaboration event types */
export type CollaborationEvent =
    | { type: 'connected' }
    | { type: 'disconnected' }
    | { type: 'error'; error: Error }
    | { type: 'peer-joined'; user: CollaborationUser }
    | { type: 'peer-left'; user: CollaborationUser }
    | { type: 'synced' };
