/**
 * collaboration/syncWorker.ts — Web Worker for Yjs CRDT synchronization.
 *
 * Offloads the heavy CRDT sync operations (Yjs document management,
 * WebSocket protocol, element serialization/deserialization) from the
 * main render thread to a dedicated Web Worker.
 *
 * Communication protocol:
 * ┌─────────────────┐                    ┌──────────────────┐
 * │   Main Thread   │  ←──postMessage──→ │   Sync Worker    │
 * │                 │                    │                  │
 * │ FlowCanvas.tsx  │  local-update  →   │ Yjs Y.Doc        │
 * │ Zustand Store   │  ← remote-update  │ WebSocket        │
 * │ useCollabHook   │  awareness     ↔  │ Awareness proto  │
 * └─────────────────┘                    └──────────────────┘
 *
 * Message types (Main → Worker):
 *   - connect:        { serverUrl, roomName, user, authToken }
 *   - disconnect:     {}
 *   - local-update:   { elements: CanvasElement[] }
 *   - awareness:      { cursor, selectedIds, activeTool }
 *
 * Message types (Worker → Main):
 *   - connected:      {}
 *   - disconnected:   {}
 *   - status:         { status: ConnectionStatus }
 *   - remote-update:  { elements: CanvasElement[] }
 *   - peers:          { peers: AwarenessState[] }
 *   - error:          { message: string }
 *
 * This file defines the protocol types and a thin main-thread adapter.
 * The actual worker code is in syncWorker.worker.ts.
 */

import type { CanvasElement } from '@/types';
import type { CollaborationConfig, ConnectionStatus, AwarenessState } from './types';
import { createWorker } from '@/utils/workerFactory';

// ─── Protocol Types ───────────────────────────────────────────

/** Messages from main thread to worker */
export type WorkerInMessage =
    | { type: 'connect'; config: CollaborationConfig; syncDebounceMs: number }
    | { type: 'disconnect' }
    | { type: 'local-update'; elements: CanvasElement[] }
    | { type: 'awareness'; cursor: { x: number; y: number } | null; selectedIds?: string[]; activeTool?: string };

/** Messages from worker to main thread */
export type WorkerOutMessage =
    | { type: 'status'; status: ConnectionStatus }
    | { type: 'remote-update'; elements: CanvasElement[] }
    | { type: 'peers'; peers: AwarenessState[] }
    | { type: 'error'; message: string };

// ─── Main-Thread Adapter ──────────────────────────────────────

export interface SyncWorkerCallbacks {
    onStatus: (status: ConnectionStatus) => void;
    onRemoteUpdate: (elements: CanvasElement[]) => void;
    onPeers: (peers: AwarenessState[]) => void;
    onError: (message: string) => void;
}

/**
 * Thin wrapper around the raw Web Worker, providing a typed API.
 *
 * Usage:
 * ```ts
 * const adapter = new SyncWorkerAdapter(callbacks);
 * adapter.connect(config, 50);
 * // ... later
 * adapter.sendLocalUpdate(elements);
 * adapter.sendAwareness({ cursor: { x: 10, y: 20 } });
 * adapter.disconnect();
 * adapter.dispose();
 * ```
 */
export class SyncWorkerAdapter {
    private _worker: Worker | null = null;
    private _callbacks: SyncWorkerCallbacks;

    constructor(callbacks: SyncWorkerCallbacks) {
        this._callbacks = callbacks;
    }

    /**
     * Initialize and connect the sync worker.
     * Uses Vite's `?worker` import syntax for bundling.
     */
    connect(config: CollaborationConfig, syncDebounceMs: number): void {
        this.dispose();

        // Create worker using factory (handles Vite inline, data: URL, etc.)
        this._worker = createWorker(
            () => new URL('./syncWorker.worker.ts', import.meta.url),
        );

        if (!this._worker) {
            console.warn('[SyncWorkerBridge] Worker creation failed, collaboration disabled');
            this._callbacks.onStatus('disconnected');
            return;
        }

        this._worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
            const msg = e.data;
            switch (msg.type) {
                case 'status':
                    this._callbacks.onStatus(msg.status);
                    break;
                case 'remote-update':
                    this._callbacks.onRemoteUpdate(msg.elements);
                    break;
                case 'peers':
                    this._callbacks.onPeers(msg.peers);
                    break;
                case 'error':
                    this._callbacks.onError(msg.message);
                    break;
            }
        };

        this._worker.onerror = (err) => {
            this._callbacks.onError(`Worker error: ${err.message}`);
        };

        this._post({ type: 'connect', config, syncDebounceMs });
    }

    disconnect(): void {
        this._post({ type: 'disconnect' });
    }

    sendLocalUpdate(elements: CanvasElement[]): void {
        this._post({ type: 'local-update', elements });
    }

    sendAwareness(update: {
        cursor?: { x: number; y: number } | null;
        selectedIds?: string[];
        activeTool?: string;
    }): void {
        this._post({
            type: 'awareness',
            cursor: update.cursor ?? null,
            selectedIds: update.selectedIds,
            activeTool: update.activeTool,
        });
    }

    dispose(): void {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }

    private _post(msg: WorkerInMessage): void {
        this._worker?.postMessage(msg);
    }
}
