/**
 * useElbowWorker.ts — React hook for off-main-thread elbow routing.
 *
 * Provides the same result signature as the synchronous `computeElbowPoints`,
 * but runs the A* computation in a Web Worker when the canvas is large.
 *
 * Behavior:
 * 1. On mount / element change: sends element snapshot to Worker
 * 2. When routing params change: requests async route computation
 * 3. Returns cached/previous result until the Worker responds
 * 4. Falls back to synchronous computation for small canvases
 *
 * Usage in ArrowShape/LineShape:
 * ```ts
 * const elbowPoints = useElbowWorker(isElbow, {
 *     startWorld, endWorld, startBinding, endBinding, minStubLength
 * }, allElements, shapeFP);
 * ```
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import type { CanvasElement, Binding, Point } from '@/types';
import { getElbowWorkerManager, disposeElbowWorkerManager } from '@/utils/elbowWorkerManager';
import type { RouteParams } from '@/utils/elbowWorkerManager';
import { computeElbowPoints, simplifyElbowPath } from '@/utils/elbow';
import { useWorkerConfig } from '@/contexts/WorkerConfigContext';

/**
 * Hook that computes elbow route points, offloading to a Web Worker
 * when beneficial.
 *
 * @param isElbow - whether elbow routing is active (skip if false)
 * @param params - routing parameters (start/end points, bindings)
 * @param allElements - all canvas elements (for obstacle detection)
 * @param fingerprint - stable spatial fingerprint (for dependency tracking)
 * @returns flat number[] of elbow route points (relative to startWorld)
 */
export function useElbowWorker(
    isElbow: boolean,
    params: {
        startWorld: Point;
        endWorld: Point;
        startBinding: Binding | null;
        endBinding: Binding | null;
        minStubLength?: number;
    },
    allElements: CanvasElement[],
    fingerprint: string,
): number[] | null {
    const [asyncResult, setAsyncResult] = useState<number[] | null>(null);
    const elementsRef = useRef<CanvasElement[]>(allElements);
    const workerConfigCtx = useWorkerConfig();
    const workerConfig = workerConfigCtx?.elbowWorkerConfig;

    elementsRef.current = allElements;

    // Keep Worker's element snapshot in sync
    useEffect(() => {
        const mgr = getElbowWorkerManager(workerConfig);
        mgr.updateElements(allElements);
    }, [fingerprint, workerConfig]); // eslint-disable-line react-hooks/exhaustive-deps

    // Cleanup Worker on unmount
    useEffect(() => {
        return () => {
            // Don't dispose on every unmount — other shapes may still use it.
            // The manager is a singleton; disposal happens at FlowCanvas level.
        };
    }, []);

    // Compute route (async when Worker available, sync otherwise)
    useEffect(() => {
        if (!isElbow) {
            setAsyncResult(null);
            return;
        }

        const mgr = getElbowWorkerManager(workerConfig);
        let cancelled = false;

        const routeParams: RouteParams = {
            startWorld: params.startWorld,
            endWorld: params.endWorld,
            startBinding: params.startBinding,
            endBinding: params.endBinding,
            minStubLength: params.minStubLength,
        };

        if (mgr.isWorkerActive) {
            // Async path: request from Worker
            mgr.computeRoute(routeParams).then(points => {
                if (!cancelled) {
                    setAsyncResult(points);
                }
            });
        } else {
            // Sync fallback
            const raw = computeElbowPoints(
                params.startWorld,
                params.endWorld,
                params.startBinding,
                params.endBinding,
                elementsRef.current,
                params.minStubLength,
            );
            const simplified = simplifyElbowPath(raw);
            setAsyncResult(simplified);
        }

        return () => { cancelled = true; };
    }, [
        isElbow,
        params.startWorld.x, params.startWorld.y,
        params.endWorld.x, params.endWorld.y,
        params.startBinding, params.endBinding,
        params.minStubLength,
        fingerprint,
    ]);

    return asyncResult;
}

/**
 * Cleanup function to dispose the Worker.
 * Call from FlowCanvas's cleanup effect.
 */
export { disposeElbowWorkerManager } from '@/utils/elbowWorkerManager';
