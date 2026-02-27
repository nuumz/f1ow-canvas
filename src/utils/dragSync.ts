/**
 * Post-drag synchronisation helpers.
 *
 * After one or more elements are moved / resized, connectors and bound
 * text labels must be recomputed.  The identical pattern was duplicated
 * in 3+ places inside FlowCanvas.tsx — this module extracts it into a
 * single, tested utility.
 */
import type {
    CanvasElement,
    LineElement,
    ArrowElement,
    TextElement,
} from '../types';
import {
    findConnectorsForElement,
    recomputeBoundPoints,
    syncConnectorLabels,
} from './connection';

// ─── Constants ──────────────────────────────────────────────────

/** Shared padding between shape containers and their bound text. */
export const BOUND_TEXT_PADDING = 4;

/** Shape types that can contain bound text. */
export const CONTAINER_TYPES: ReadonlySet<string> = new Set([
    'rectangle',
    'ellipse',
    'diamond',
    'image',
]);

// ─── Bound-text position ────────────────────────────────────────

/**
 * Compute the stored position for bound text inside a shape container.
 *
 * @param container  The container shape (needs x, y, width, height)
 * @param text       The text element (needs height, optionally verticalAlign)
 * @returns          `{ x, y, width }` updates to apply on the text element
 */
export function computeBoundTextPosition(
    container: { x: number; y: number; width: number; height: number },
    text: { height: number; verticalAlign?: string },
): { x: number; y: number; width: number } {
    const tw = Math.max(20, container.width - BOUND_TEXT_PADDING * 2);
    let ty: number;
    if (text.verticalAlign === 'top') {
        ty = container.y + BOUND_TEXT_PADDING;
    } else if (text.verticalAlign === 'bottom') {
        ty = container.y + container.height - text.height - BOUND_TEXT_PADDING;
    } else {
        ty = container.y + (container.height - text.height) / 2;
    }
    return { x: container.x + BOUND_TEXT_PADDING, y: ty, width: tw };
}

// ─── Post-drag sync ─────────────────────────────────────────────

export interface DragSyncResult {
    /** Batched updates to apply to the store in a single write. */
    updates: Array<{ id: string; updates: Partial<CanvasElement> }>;
    /** IDs of connectors that were recomputed (for dedup / further processing). */
    processedConnectorIds: Set<string>;
}

/**
 * After one or more elements are moved / resized, recompute:
 *
 * 1. Connector bound-points for all attached connectors
 * 2. Bound text positions for shape containers
 * 3. Connector-label positions (depend on updated connector geometry)
 *
 * Returns all updates as a flat array — the caller is responsible for
 * applying them to the store (single `batchUpdateElements` call).
 *
 * @param movedIds    IDs of elements that were moved / resized
 * @param elements    Current **full** element list (post position-write)
 * @param skipIds     Optional set of IDs to skip (e.g. group-internal
 *                    elements that already moved together)
 */
export function syncAfterDrag(
    movedIds: Iterable<string>,
    elements: CanvasElement[],
    skipIds?: ReadonlySet<string>,
): DragSyncResult {
    // Build O(1) lookup once
    const elMap = new Map<string, CanvasElement>();
    for (const el of elements) elMap.set(el.id, el);

    const updates: DragSyncResult['updates'] = [];
    const processedConnectors = new Set<string>();

    for (const id of movedIds) {
        // ── Connector recomputation (deduplicated) ──────────
        const connectors = findConnectorsForElement(id, elements);
        for (const conn of connectors) {
            if (processedConnectors.has(conn.id)) continue;
            processedConnectors.add(conn.id);
            if (skipIds?.has(conn.id)) continue;
            const freshConn = elMap.get(conn.id) as LineElement | ArrowElement | undefined;
            if (!freshConn) continue;
            const recomputed = recomputeBoundPoints(freshConn, elements);
            if (recomputed) updates.push({ id: freshConn.id, updates: recomputed });
        }

        // ── Bound text sync (shape containers) ─────────────
        const el = elMap.get(id);
        if (el?.boundElements && CONTAINER_TYPES.has(el.type)) {
            for (const be of el.boundElements) {
                if (be.type !== 'text') continue;
                if (skipIds?.has(be.id)) continue;
                const txt = elMap.get(be.id) as TextElement | undefined;
                if (!txt) continue;
                updates.push({ id: be.id, updates: computeBoundTextPosition(el, txt) });
            }
        }
    }

    // ── Connector-label positions ───────────────────────────
    // Labels depend on the recomputed connector geometry, so we build
    // a temporary overlay of the updates on top of the original map.
    if (processedConnectors.size > 0 && updates.length > 0) {
        const tempMap = new Map(elMap);
        for (const u of updates) {
            const existing = tempMap.get(u.id);
            if (existing) {
                tempMap.set(u.id, { ...existing, ...u.updates } as CanvasElement);
            }
        }
        const labelUpdates = syncConnectorLabels(
            processedConnectors,
            tempMap as Map<string, CanvasElement>,
        );
        for (const lu of labelUpdates) {
            updates.push(lu as { id: string; updates: Partial<CanvasElement> });
        }
    }

    return { updates, processedConnectorIds: processedConnectors };
}
