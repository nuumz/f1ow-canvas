/**
 * elbowWorker.ts — Web Worker for off-main-thread elbow connector routing.
 *
 * Runs the expensive A* grid-search algorithm in a background thread so
 * the main thread stays at 60fps during intensive drag operations that
 * trigger many simultaneous route recomputations.
 *
 * Communication protocol:
 *   Main → Worker:
 *     { type: 'updateElements', elements: SerializedElement[] }
 *     { type: 'computeRoute', requestId, params: RouteParams }
 *   Worker → Main:
 *     { type: 'routeResult', requestId, points: number[] }
 *
 * Uses Vite's native Worker module support — imported with:
 *   new Worker(new URL('./elbowWorker.ts', import.meta.url), { type: 'module' })
 */

// NOTE: We import the full elbow module here.  Vite bundles it into the
// Worker chunk automatically.  The `@/` path alias is resolved by Vite.
import { computeElbowPoints, simplifyElbowPath } from '@/utils/elbow';
import type { CanvasElement, Binding, Point } from '@/types';

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
    // Minimal fields needed for obstacle detection — style, text, etc. are omitted.
    // We reconstruct a "pseudo-CanvasElement" from these fields.
}

interface RouteParams {
    startWorld: Point;
    endWorld: Point;
    startBinding: Binding | null;
    endBinding: Binding | null;
    minStubLength?: number;
}

interface UpdateElementsMessage {
    type: 'updateElements';
    elements: SerializedElement[];
}

interface ComputeRouteMessage {
    type: 'computeRoute';
    requestId: number;
    params: RouteParams;
}

type IncomingMessage = UpdateElementsMessage | ComputeRouteMessage;

// ─── Worker state ─────────────────────────────────────────────

/** Lightweight element proxies used for obstacle detection in routing */
let cachedElements: CanvasElement[] = [];

/**
 * Reconstruct minimal CanvasElement-shaped objects from serialized data.
 * Only the fields used by computeElbowPoints are needed:
 *   id, type, x, y, width, height, rotation, isVisible
 */
function deserializeElements(serialized: SerializedElement[]): CanvasElement[] {
    // Cast is safe because computeElbowPoints only reads spatial fields
    // and checks `type` membership in OBSTACLE_TYPES set.
    return serialized as unknown as CanvasElement[];
}

// ─── Message handler ──────────────────────────────────────────

self.onmessage = (e: MessageEvent<IncomingMessage>) => {
    const msg = e.data;

    if (msg.type === 'updateElements') {
        cachedElements = deserializeElements(msg.elements);
        return;
    }

    if (msg.type === 'computeRoute') {
        const { requestId, params } = msg;
        try {
            const raw = computeElbowPoints(
                params.startWorld,
                params.endWorld,
                params.startBinding,
                params.endBinding,
                cachedElements,
                params.minStubLength,
            );
            const simplified = simplifyElbowPath(raw);
            self.postMessage({ type: 'routeResult', requestId, points: simplified });
        } catch {
            // On error, return a straight line fallback
            self.postMessage({
                type: 'routeResult',
                requestId,
                points: [0, 0, params.endWorld.x - params.startWorld.x, params.endWorld.y - params.startWorld.y],
            });
        }
    }
};
