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
    /**
     * Yjs awareness clientID — unique per browser tab/connection.
     * Surfaced for stable React keys so the same user in two tabs does not
     * collide on `user.id`. Set when peers are assembled in useCollaboration.
     */
    clientID?: number;
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
    /**
     * Acknowledge and enable EXPERIMENTAL live document sync.
     *
     * ⚠️ Live collaboration currently has a KNOWN DATA-LOSS bug: a remote edit
     * that arrives within the local sync debounce window can drop a peer's
     * concurrent change and leave the two clients' documents permanently
     * divergent (see `syncEngine._applyRemote`). Until this is fixed, live
     * collaboration is DISABLED unless you set this to `true` to opt in at your
     * own risk (e.g. for testing). Awareness/cursors are gated together with it.
     *
     * @default false
     */
    experimental?: boolean;
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
