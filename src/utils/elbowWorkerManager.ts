/**
 * elbowWorkerManager.ts — Manager for the elbow routing Web Worker.
 *
 * Provides a clean async API for requesting elbow route computations
 * from a background thread.  Falls back to main-thread synchronous
 * computation when Web Workers are unavailable (SSR, library consumers
 * not using Vite, etc.).
 *
 * Usage:
 * ```ts
 * const mgr = getElbowWorkerManager();
 * mgr.updateElements(elements);           // sync snapshot of obstacles
 * const pts = await mgr.computeRoute(...); // async A* result
 * ```
 */
import type { CanvasElement, Binding, Point } from '@/types';
import { computeElbowPoints, simplifyElbowPath } from '@/utils/elbow';

// ─── Types ────────────────────────────────────────────────────

interface SerializedElement {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    isVisible: boolean;
}

export interface RouteParams {
    startWorld: Point;
    endWorld: Point;
    startBinding: Binding | null;
    endBinding: Binding | null;
    minStubLength?: number;
}

interface PendingRequest {
    resolve: (points: number[]) => void;
    reject: (err: Error) => void;
    timerId?: ReturnType<typeof setTimeout>;
}

// ─── Serialization ────────────────────────────────────────────

/**
 * Extract only the fields the Worker needs for obstacle detection.
 * This keeps the postMessage payload small (~80 bytes/element vs
 * 500+ bytes for the full object with style, boundElements, etc.).
 */
function serializeElements(elements: CanvasElement[]): SerializedElement[] {
    const result: SerializedElement[] = new Array(elements.length);
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        result[i] = {
            id: el.id,
            type: el.type,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            rotation: el.rotation,
            isVisible: el.isVisible,
        };
    }
    return result;
}

// ─── Worker Manager Class ─────────────────────────────────────

/**
 * Threshold: only use the Worker when there are many elements.
 * Below this count, the serialization + postMessage overhead
 * exceeds the benefit of off-thread computation.
 */
const WORKER_THRESHOLD = 50;

export class ElbowWorkerManager {
    private worker: Worker | null = null;
    private requestIdCounter = 0;
    private pending = new Map<number, PendingRequest>();
    private cachedElements: CanvasElement[] = [];
    private workerSupported = true;

    /**
     * Get or lazily create the Worker instance.
     * Returns null if Workers are not supported in the current environment.
     */
    private _getWorker(): Worker | null {
        if (!this.workerSupported) return null;
        if (this.worker) return this.worker;

        try {
            this.worker = new Worker(
                new URL('../workers/elbowWorker.ts', import.meta.url),
                { type: 'module' },
            );
            this.worker.onmessage = this.handleMessage;
            this.worker.onerror = () => {
                this.workerSupported = false;
                this.worker = null;
                for (const [, req] of this.pending) {
                    if (req.timerId !== undefined) clearTimeout(req.timerId);
                    req.reject(new Error('Worker failed'));
                }
                this.pending.clear();
            };
            return this.worker;
        } catch {
            this.workerSupported = false;
            return null;
        }
    }

    private handleMessage = (e: MessageEvent) => {
        const { type, requestId, points } = e.data;
        if (type === 'routeResult') {
            const req = this.pending.get(requestId);
            if (req) {
                this.pending.delete(requestId);
                if (req.timerId !== undefined) clearTimeout(req.timerId);
                req.resolve(points);
            }
        }
    };

    // ─── Public API ───────────────────────────────────────────

    /**
     * Update the Worker's element snapshot for obstacle detection.
     * Call this whenever elements change (position, size, visibility).
     */
    updateElements(elements: CanvasElement[]): void {
        this.cachedElements = elements;
        const worker = this._getWorker();
        if (worker && elements.length >= WORKER_THRESHOLD) {
            worker.postMessage({
                type: 'updateElements',
                elements: serializeElements(elements),
            });
        }
    }

    /**
     * Compute an elbow route asynchronously via the Worker.
     * Falls back to synchronous main-thread computation when:
     * - Worker is not available
     * - Element count is below WORKER_THRESHOLD
     * - Worker is busy and request times out
     */
    async computeRoute(params: RouteParams): Promise<number[]> {
        const worker = this._getWorker();
        // Fast path: small canvas or no Worker — compute synchronously
        if (!worker || this.cachedElements.length < WORKER_THRESHOLD) {
            return this.computeSync(params);
        }

        const requestId = ++this.requestIdCounter;

        return new Promise<number[]>((resolve, reject) => {
            // Timeout: if Worker takes too long, fall back to sync
            const timerId = setTimeout(() => {
                if (this.pending.has(requestId)) {
                    this.pending.delete(requestId);
                    resolve(this.computeSync(params));
                }
            }, 100);

            this.pending.set(requestId, { resolve, reject, timerId });

            worker.postMessage({
                type: 'computeRoute',
                requestId,
                params,
            });
        });
    }

    /**
     * Synchronous fallback computation (original behavior).
     */
    computeSync(params: RouteParams): number[] {
        const raw = computeElbowPoints(
            params.startWorld,
            params.endWorld,
            params.startBinding,
            params.endBinding,
            this.cachedElements,
            params.minStubLength,
        );
        return simplifyElbowPath(raw);
    }

    /**
     * Terminate the Worker and clean up resources.
     */
    dispose(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        for (const [, req] of this.pending) {
            if (req.timerId !== undefined) clearTimeout(req.timerId);
            req.reject(new Error('Worker disposed'));
        }
        this.pending.clear();
    }

    /** Whether the Worker can be used (environment supports it) */
    get isWorkerActive(): boolean {
        return this.workerSupported;
    }
}

// ─── Singleton ────────────────────────────────────────────────

let _instance: ElbowWorkerManager | null = null;

/**
 * Get or create the shared ElbowWorkerManager singleton.
 * The Worker is created lazily on first access.
 */
export function getElbowWorkerManager(): ElbowWorkerManager {
    if (!_instance) {
        _instance = new ElbowWorkerManager();
    }
    return _instance;
}

/**
 * Dispose the shared manager (e.g. when FlowCanvas unmounts).
 */
export function disposeElbowWorkerManager(): void {
    if (_instance) {
        _instance.dispose();
        _instance = null;
    }
}
