/**
 * useElbowWorker.ts — React hook for off-main-thread elbow routing.
 *
 * Provides the same result signature as the synchronous `computeElbowPoints`,
 * but runs the A* computation in a Web Worker when the canvas is large.
 *
 * Behavior:
 * 1. On mount / element change: sends element snapshot to Worker
 * 2. When routing params change: requests async route computation
 * 3. Exposes Worker results only when they match the current route params
 * 4. Falls back to synchronous computation for small canvases or while a fresh Worker result is pending
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
import type { RouteParams, ElbowWorkerManager } from '@/utils/elbowWorkerManager';
import { computeElbowPoints, simplifyElbowPath } from '@/utils/elbow';
import { useWorkerConfig } from '@/contexts/WorkerConfigContext';

interface AsyncRouteResult {
    key: string;
    points: number[];
}

function serializeBinding(binding: Binding | null): string {
    if (!binding) return '';
    return [
        binding.elementId,
        binding.anchor ?? '',
        binding.portId ?? '',
        binding.snapMode ?? '',
        binding.elementVersion,
        binding.isPrecise ? 1 : 0,
        binding.gap,
        binding.fixedPoint[0],
        binding.fixedPoint[1],
    ].join(':');
}

function buildRouteKey(
    params: {
        startWorld: Point;
        endWorld: Point;
        startBinding: Binding | null;
        endBinding: Binding | null;
        minStubLength?: number;
    },
    fingerprint: string,
): string {
    return [
        params.startWorld.x,
        params.startWorld.y,
        params.endWorld.x,
        params.endWorld.y,
        params.minStubLength ?? '',
        fingerprint,
        serializeBinding(params.startBinding),
        serializeBinding(params.endBinding),
    ].join('|');
}

/**
 * Hook that computes elbow route points, offloading to a Web Worker
 * when beneficial.
 *
 * @param isElbow - whether elbow routing is active (skip if false)
 * @param params - routing parameters (start/end points, bindings)
 * @param allElements - all canvas elements (for obstacle detection)
 * @param fingerprint - stable spatial fingerprint (for dependency tracking)
 * @returns `points`: flat number[] of route points (relative to startWorld),
 *          null until a result for the current params is available;
 *          `isWorkerActive`: whether routing is being handled off-thread /
 *          asynchronously, so callers can skip the synchronous A* fallback.
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
): { points: number[] | null; isWorkerActive: boolean } {
    const workerConfigCtx = useWorkerConfig();
    const workerConfig = workerConfigCtx?.elbowWorkerConfig;
    // Prefer THIS FlowCanvas instance's manager (from context) so routing uses
    // only its own obstacles. Fall back to the module-level singleton when no
    // provider is mounted (e.g. shapes rendered outside a FlowCanvas).
    const mgr: ElbowWorkerManager = useMemo(
        () => workerConfigCtx?.elbowWorkerManager ?? getElbowWorkerManager(workerConfig),
        [workerConfigCtx?.elbowWorkerManager, workerConfig],
    );
    const [asyncResult, setAsyncResult] = useState<AsyncRouteResult | null>(null);
    const [isWorkerActive, setIsWorkerActive] = useState<boolean>(
        () => mgr.isWorkerActive,
    );
    const elementsRef = useRef<CanvasElement[]>(allElements);
    // Monotonically increasing request counter to discard stale Worker results
    const requestEpochRef = useRef(0);
    const routeKey = useMemo(
        () => buildRouteKey(params, fingerprint),
        [
            params.startWorld.x,
            params.startWorld.y,
            params.endWorld.x,
            params.endWorld.y,
            params.startBinding,
            params.endBinding,
            params.minStubLength,
            fingerprint,
        ],
    );

    elementsRef.current = allElements;

    // Keep Worker's element snapshot in sync
    useEffect(() => {
        mgr.updateElements(allElements);
    }, [fingerprint, mgr]); // eslint-disable-line react-hooks/exhaustive-deps

    // Cleanup Worker on unmount
    useEffect(() => {
        return () => {
            // Don't dispose on every shape unmount — sibling shapes share this
            // instance's manager. Disposal happens once at the FlowCanvas level
            // (the owning instance disposes its own manager in its cleanup).
        };
    }, []);

    // Compute route (async when Worker available, sync otherwise)
    useEffect(() => {
        if (!isElbow) {
            setAsyncResult(null);
            return;
        }

        let cancelled = false;
        const epoch = ++requestEpochRef.current;
        const requestKey = routeKey;

        // Surface the current worker-active state so consumers can skip the
        // synchronous A* fallback while the Worker (or async path) is handling
        // the route. Functional update bails out when unchanged.
        setIsWorkerActive(prev => (prev === mgr.isWorkerActive ? prev : mgr.isWorkerActive));

        const routeParams: RouteParams = {
            startWorld: params.startWorld,
            endWorld: params.endWorld,
            startBinding: params.startBinding,
            endBinding: params.endBinding,
            minStubLength: params.minStubLength,
        };

        if (mgr.isWorkerActive) {
            // Async path: request from Worker
            mgr.computeRoute(routeParams)
                .then(points => {
                    // Drop stale results — a newer request has been issued
                    if (!cancelled && requestEpochRef.current === epoch) {
                        setAsyncResult({ key: requestKey, points });
                    }
                })
                .catch(() => {
                    // Worker errored or was disposed → its pending promises
                    // reject. Fall back to a synchronous compute for this
                    // request, honoring the same stale-result guard so a late
                    // fallback never overwrites a newer request's result.
                    if (cancelled || requestEpochRef.current !== epoch) return;
                    const raw = computeElbowPoints(
                        params.startWorld,
                        params.endWorld,
                        params.startBinding,
                        params.endBinding,
                        elementsRef.current,
                        params.minStubLength,
                    );
                    setAsyncResult({ key: requestKey, points: simplifyElbowPath(raw) });
                    // The Worker is no longer usable; reflect that so future
                    // renders use the synchronous fallback path.
                    setIsWorkerActive(mgr.isWorkerActive);
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
            setAsyncResult({ key: requestKey, points: simplified });
        }

        return () => { cancelled = true; };
    }, [
        isElbow,
        params.startWorld.x, params.startWorld.y,
        params.endWorld.x, params.endWorld.y,
        params.startBinding, params.endBinding,
        params.minStubLength,
        fingerprint,
        routeKey,
        mgr,
    ]);

    const points = asyncResult?.key === routeKey ? asyncResult.points : null;
    return { points, isWorkerActive };
}

/**
 * Cleanup function to dispose the Worker.
 * Call from FlowCanvas's cleanup effect.
 */
export { disposeElbowWorkerManager } from '@/utils/elbowWorkerManager';
