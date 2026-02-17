/**
 * exportWorkerManager.ts — Manager for the background SVG export Worker.
 *
 * Provides a simple async API for generating SVG strings off the main
 * thread. Falls back to synchronous export if Workers are unavailable
 * or if the element count is below the threshold.
 *
 * Usage:
 * ```ts
 * const manager = getExportWorkerManager();
 * const svg = await manager.exportSVG(elements);
 * ```
 */
import type { CanvasElement } from '@/types';
import { exportToSVG } from '@/utils/export';
import { generateId } from '@/utils/id';

// ─── Types ────────────────────────────────────────────────────

interface PendingRequest {
    resolve: (svg: string) => void;
    reject: (error: Error) => void;
}

// ─── Worker Manager ───────────────────────────────────────────

/**
 * Below this element count, sync export is fast enough (<50ms).
 * Use the Worker only for larger exports to avoid serialization overhead.
 */
const WORKER_THRESHOLD = 200;

/** Timeout for Worker response (ms). Falls back to sync on timeout. */
const WORKER_TIMEOUT = 10_000;

export class ExportWorkerManager {
    private _worker: Worker | null = null;
    private _pending: Map<string, PendingRequest> = new Map();
    private _workerSupported = true;

    // ─── Lazy Worker initialization ───────────────────────────

    private _getWorker(): Worker | null {
        if (!this._workerSupported) return null;
        if (this._worker) return this._worker;

        try {
            this._worker = new Worker(
                new URL('../workers/exportWorker.ts', import.meta.url),
                { type: 'module' },
            );
            this._worker.onmessage = this._onMessage;
            this._worker.onerror = (err) => {
                console.warn('[ExportWorkerManager] Worker error, falling back to sync:', err.message);
                this._workerSupported = false;
                this._rejectAll(new Error('Export Worker failed'));
                this._worker?.terminate();
                this._worker = null;
            };
            return this._worker;
        } catch {
            this._workerSupported = false;
            return null;
        }
    }

    // ─── Message handler ──────────────────────────────────────

    private _onMessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || !msg.requestId) return;

        const pending = this._pending.get(msg.requestId);
        if (!pending) return;
        this._pending.delete(msg.requestId);

        if (msg.type === 'svgResult') {
            pending.resolve(msg.svg);
        } else if (msg.type === 'error') {
            pending.reject(new Error(msg.message));
        }
    };

    private _rejectAll(error: Error): void {
        for (const [, req] of this._pending) {
            req.reject(error);
        }
        this._pending.clear();
    }

    // ─── Public API ───────────────────────────────────────────

    /**
     * Export elements to SVG string.
     * Uses Worker for large sets, sync for small sets.
     */
    async exportSVG(elements: CanvasElement[]): Promise<string> {
        // Small set — sync is faster (avoids serialization overhead)
        if (elements.length <= WORKER_THRESHOLD) {
            return exportToSVG(elements);
        }

        const worker = this._getWorker();
        if (!worker) {
            // Worker unavailable — sync fallback
            return exportToSVG(elements);
        }

        const requestId = generateId();

        return new Promise<string>((resolve, reject) => {
            this._pending.set(requestId, { resolve, reject });

            // Timeout: fall back to sync if Worker doesn't respond
            const timer = setTimeout(() => {
                if (this._pending.has(requestId)) {
                    this._pending.delete(requestId);
                    console.warn('[ExportWorkerManager] Timeout, falling back to sync export');
                    try {
                        resolve(exportToSVG(elements));
                    } catch (err) {
                        reject(err);
                    }
                }
            }, WORKER_TIMEOUT);

            // Override resolve/reject to clear the timer
            const origResolve = resolve;
            const origReject = reject;
            const wrappedPending = this._pending.get(requestId);
            if (wrappedPending) {
                wrappedPending.resolve = (svg: string) => {
                    clearTimeout(timer);
                    origResolve(svg);
                };
                wrappedPending.reject = (err: Error) => {
                    clearTimeout(timer);
                    origReject(err);
                };
            }

            worker.postMessage({
                type: 'exportSVG',
                requestId,
                elements,
            });
        });
    }

    /**
     * Export elements to SVG and download as file.
     * Uses Worker for SVG generation, then triggers browser download.
     */
    async downloadSVG(elements: CanvasElement[], filename = 'canvas.svg'): Promise<void> {
        const svg = await this.exportSVG(elements);
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /** Terminate the Worker and clean up */
    dispose(): void {
        this._rejectAll(new Error('ExportWorkerManager disposed'));
        this._worker?.terminate();
        this._worker = null;
    }
}

// ─── Singleton ────────────────────────────────────────────────

let _instance: ExportWorkerManager | null = null;

/** Get or create the shared ExportWorkerManager singleton */
export function getExportWorkerManager(): ExportWorkerManager {
    if (!_instance) {
        _instance = new ExportWorkerManager();
    }
    return _instance;
}

/** Dispose the shared ExportWorkerManager singleton */
export function disposeExportWorkerManager(): void {
    _instance?.dispose();
    _instance = null;
}
