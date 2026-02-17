/**
 * collaboration/index.ts — Barrel export for the collaboration module.
 *
 * Public API surface for CRDT-based real-time collaboration.
 */

// Types
export type {
    CollaborationUser,
    AwarenessState,
    CollaborationConfig,
    ConnectionStatus,
    CollaborationEvent,
} from './types';

// Provider management (legacy singleton API — for single-instance usage)
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
} from './yjsProvider';

// Sync bridge (legacy singleton API)
export { startSync, stopSync } from './syncBridge';

// Sync codec (shared serialization)
export { elementToYMap, yMapToElement, SYNC_FIELDS, STYLE_FIELDS } from './syncBridgeCodec';

// Instance-based manager (supports multiple FlowCanvas instances)
export { CollaborationManager } from './CollaborationManager';

// Web Worker-based sync adapter (offloads CRDT to worker thread)
export { SyncWorkerAdapter } from './syncWorker';
export type { WorkerInMessage, WorkerOutMessage, SyncWorkerCallbacks } from './syncWorker';

// React hook
export { useCollaboration } from './useCollaboration';

// Overlay component
export { default as CursorOverlay } from './CursorOverlay';
