// ─── f1ow-canvas: Collaboration subpath entry ─────────────────
//
// Importing from `f1ow/collaboration` opts the consumer's bundle into the
// Yjs / y-websocket runtime. The root `f1ow` entry intentionally avoids
// these symbols so apps that do not use real-time collaboration are not
// forced to install the optional peer dependencies.

// Types
export type {
    CollaborationUser,
    AwarenessState,
    CollaborationConfig,
    ConnectionStatus,
    CollaborationEvent,
} from '../collaboration/types';

// Provider management (singleton API)
export {
    createCollaborationProvider,
    destroyCollaborationProvider,
    getYDoc,
    getYProvider,
    getYElements,
    isCollaborationActive,
    onStatusChange,
    updateAwareness,
    getRemoteAwareness,
} from '../collaboration/yjsProvider';

// Sync bridge
export { startSync, stopSync } from '../collaboration/syncBridge';

// Codec (shared serialization for Yjs ↔ CanvasElement)
export { elementToYMap, yMapToElement, SYNC_FIELDS, STYLE_FIELDS } from '../collaboration/syncBridgeCodec';

// Instance-based collaboration manager
export { CollaborationManager } from '../collaboration/CollaborationManager';

// Web Worker-based sync adapter
export { SyncWorkerAdapter } from '../collaboration/syncWorker';
export type { WorkerInMessage, WorkerOutMessage, SyncWorkerCallbacks } from '../collaboration/syncWorker';

// React hook (also re-exported from root for convenience — it lazily loads
// the yjs/y-websocket modules at runtime, so the root-level export does not
// pull `yjs` into the static import graph).
export { useCollaboration } from '../collaboration/useCollaboration';
export type { UseCollaborationReturn } from '../collaboration/useCollaboration';

// Cursor overlay component
export { default as CursorOverlay } from '../collaboration/CursorOverlay';
