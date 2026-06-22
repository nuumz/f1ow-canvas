/**
 * collaboration/syncBridgeCodec.ts — Serialization / translation layer between
 * `CanvasElement` and Yjs shared types for genuine op-based CRDT collaboration.
 *
 * This is the SHARED codec used by the live engine (`CollaborationManager` ⇒
 * `CanvasSyncEngine`) and by the deprecated legacy bridges (`syncBridge.ts`,
 * `syncWorker.worker.ts`). It is the single source of truth for the on-wire
 * Yjs shape of an element.
 *
 * ─── CRDT representation ──────────────────────────────────────────────────
 * Each element is a `Y.Map<unknown>` stored under the top-level
 * `Y.Map<Y.Map>` ("elements"), keyed by element id. Within an element map:
 *
 *   • Scalar LWW fields (plain values) — `x`, `y`, `width`, `height`,
 *     `rotation`, `isLocked`, `isVisible`, `sortOrder`, `version`, and the
 *     flattened `style.*` fields. Yjs `Y.Map` is per-key last-writer-wins and
 *     conflict-free for scalars, so concurrent edits to *different* fields of
 *     the same element MERGE instead of clobbering.
 *
 *   • Mergeable collections use granular Yjs types so concurrent edits CONVERGE:
 *       - `points: number[]`  → `Y.Array<number>`  (line / arrow / freedraw)
 *       - `text` (TextElement) → `Y.Text`          (collaborative text editing)
 *
 *   • Coarse structures kept as LWW JSON-string values (deliberate choice —
 *     field-level merge is rarely meaningful for these and they are small):
 *       `boundElements`, `ports`, `groupIds`, `lineStyle`, `startBinding`,
 *       `endBinding`, `crop`.
 *
 * ─── Op translation ──────────────────────────────────────────────────────
 * `applyOperationToYjs()` maps a `CanvasOperation` (produced by
 * `utils/crdtPrep.detectOperations`) onto a *granular* Yjs mutation:
 *   move      → relative delta on the `x`/`y` scalars
 *   resize    → absolute `width`/`height` (+ optional `x`/`y`)
 *   rotate    → absolute `rotation`
 *   style     → per-field `style.*` set
 *   reorder   → `sortOrder` set
 *   updatePoints → `Y.Array` prefix/suffix reconcile (splice only the diff)
 *   setText   → `Y.Text` prefix/suffix reconcile (delta insert/delete)
 *   add       → create element `Y.Map` (clears any tombstone — resurrect)
 *   delete    → explicit tombstone + remove (NEVER delete-by-absence)
 *   batch     → recurse (caller wraps everything in one `doc.transact`)
 *
 * ─── Deletes / tombstones ────────────────────────────────────────────────
 * Deletes are tracked in a sibling top-level `Y.Map<number>` ("tombstones",
 * id → deletedAt). An element is *visible* iff it exists in the elements map
 * AND is not tombstoned. This gives delete-wins semantics for a concurrent
 * delete+edit of the SAME element, while an explicit re-`add` (e.g. undo of a
 * delete) clears the tombstone deterministically (Yjs key-LWW) to resurrect it.
 * Crucially, a delete only ever removes the id the user actually deleted, so a
 * concurrently-created remote element is never destroyed.
 */
import * as Y from 'yjs';
import type { CanvasElement, CanvasOperation } from '@/types';

// ─── Field definitions ───────────────────────────────────────

/** Base fields serialized for every element (scalar LWW) */
export const SYNC_FIELDS = [
    'id', 'type', 'x', 'y', 'width', 'height', 'rotation',
    'isLocked', 'isVisible', 'sortOrder', 'version',
] as const;

/** Style sub-fields (flattened to `style.fieldName` for granular per-field LWW) */
export const STYLE_FIELDS = [
    'strokeColor', 'fillColor', 'strokeWidth', 'opacity',
    'strokeStyle', 'roughness', 'fontSize', 'fontFamily', 'freehandStyle',
] as const;

/**
 * Scalar/JSON fields that are NOT covered by a `CanvasOperation` and therefore
 * must be reconciled directly against the element `Y.Map` after the ops are
 * applied. (Geometry, style, points, text and sortOrder are op-driven.)
 */
const RESIDUAL_BASE_FIELDS = ['isLocked', 'isVisible', 'version'] as const;

// ─── Serialization (CanvasElement → Y.Map) ────────────────────

/**
 * Convert a CanvasElement into a (fresh, detached) element Y.Map.
 * Flattens style fields to `style.fieldName`, stores `points` as `Y.Array`
 * and text as `Y.Text` for granular convergence. Coarse structures are stored
 * as LWW JSON strings.
 *
 * The Y.Array / Y.Text children are populated while still detached; they
 * integrate together with `yMap` when the caller attaches it to the document.
 */
export function elementToYMap(el: CanvasElement, yMap: Y.Map<unknown>): void {
    const elRecord = el as unknown as Record<string, unknown>;
    for (const field of SYNC_FIELDS) {
        const value = elRecord[field];
        if (value !== undefined) {
            yMap.set(field, value);
        }
    }

    // Style — flatten for per-field LWW
    if (el.style) {
        for (const sf of STYLE_FIELDS) {
            yMap.set(`style.${sf}`, el.style[sf]);
        }
    }

    // Coarse LWW JSON structures
    yMap.set('boundElements', el.boundElements ? JSON.stringify(el.boundElements) : null);
    if (el.ports) yMap.set('ports', JSON.stringify(el.ports));
    if ('lineStyle' in el && (el as { lineStyle?: unknown }).lineStyle) {
        yMap.set('lineStyle', JSON.stringify((el as { lineStyle?: unknown }).lineStyle));
    }
    if (el.groupIds) yMap.set('groupIds', JSON.stringify(el.groupIds));

    // Type-specific fields
    switch (el.type) {
        case 'rectangle':
            yMap.set('cornerRadius', el.cornerRadius);
            break;
        case 'line':
        case 'arrow':
            yMap.set('points', makeYArray(el.points));
            yMap.set('lineType', el.lineType);
            if (el.curvature !== undefined) yMap.set('curvature', el.curvature);
            yMap.set('startBinding', el.startBinding ? JSON.stringify(el.startBinding) : null);
            yMap.set('endBinding', el.endBinding ? JSON.stringify(el.endBinding) : null);
            if (el.type === 'arrow') {
                yMap.set('startArrowhead', el.startArrowhead);
                yMap.set('endArrowhead', el.endArrowhead);
            }
            break;
        case 'freedraw':
            yMap.set('points', makeYArray(el.points));
            break;
        case 'text':
            yMap.set('text', makeYText(el.text));
            yMap.set('containerId', el.containerId);
            yMap.set('textAlign', el.textAlign);
            yMap.set('verticalAlign', el.verticalAlign);
            break;
        case 'image':
            yMap.set('src', el.src);
            yMap.set('naturalWidth', el.naturalWidth);
            yMap.set('naturalHeight', el.naturalHeight);
            yMap.set('scaleMode', el.scaleMode);
            yMap.set('crop', el.crop ? JSON.stringify(el.crop) : null);
            yMap.set('cornerRadius', el.cornerRadius);
            yMap.set('alt', el.alt);
            break;
    }
}

// ─── Deserialization (Y.Map → CanvasElement) ──────────────────

/**
 * Reconstruct a CanvasElement from an element Y.Map.
 * Inverse of {@link elementToYMap}. Reads `points` from a `Y.Array` (or a
 * legacy JSON string) and `text` from a `Y.Text` (or a legacy string), so
 * documents written by the older blob-based bridge still deserialize.
 */
export function yMapToElement(yMap: Y.Map<unknown>): CanvasElement | null {
    const type = yMap.get('type') as string;
    const id = yMap.get('id') as string;
    if (!type || !id) return null;

    // Reconstruct style
    const style: Record<string, unknown> = {};
    for (const sf of STYLE_FIELDS) {
        const val = yMap.get(`style.${sf}`);
        if (val !== undefined) style[sf] = val;
    }

    const base: Record<string, unknown> = {
        id,
        type,
        x: yMap.get('x') ?? 0,
        y: yMap.get('y') ?? 0,
        width: yMap.get('width') ?? 100,
        height: yMap.get('height') ?? 100,
        rotation: yMap.get('rotation') ?? 0,
        isLocked: yMap.get('isLocked') ?? false,
        isVisible: yMap.get('isVisible') ?? true,
        version: yMap.get('version') ?? 0,
        style,
        boundElements: safeParseJSON(yMap.get('boundElements') as string | null) ?? null,
        groupIds: safeParseJSON(yMap.get('groupIds') as string | null) ?? undefined,
        sortOrder: yMap.get('sortOrder') ?? undefined,
        ports: safeParseJSON(yMap.get('ports') as string | null) ?? undefined,
    };

    switch (type) {
        case 'rectangle':
            base.cornerRadius = yMap.get('cornerRadius') ?? 0;
            break;
        case 'line':
        case 'arrow':
            base.points = readPoints(yMap.get('points'), [0, 0, 100, 0]);
            base.lineType = yMap.get('lineType') ?? 'sharp';
            base.curvature = yMap.get('curvature') ?? undefined;
            base.startBinding = safeParseJSON(yMap.get('startBinding') as string | null);
            base.endBinding = safeParseJSON(yMap.get('endBinding') as string | null);
            if (type === 'arrow') {
                base.startArrowhead = yMap.get('startArrowhead') ?? null;
                base.endArrowhead = yMap.get('endArrowhead') ?? 'arrow';
            }
            {
                const ls = safeParseJSON(yMap.get('lineStyle') as string | null);
                if (ls) base.lineStyle = ls;
            }
            break;
        case 'freedraw':
            base.points = readPoints(yMap.get('points'), []);
            break;
        case 'text':
            base.text = readText(yMap.get('text'));
            base.containerId = yMap.get('containerId') ?? null;
            base.textAlign = yMap.get('textAlign') ?? 'center';
            base.verticalAlign = yMap.get('verticalAlign') ?? 'middle';
            break;
        case 'image':
            base.src = yMap.get('src') ?? '';
            base.naturalWidth = yMap.get('naturalWidth') ?? 0;
            base.naturalHeight = yMap.get('naturalHeight') ?? 0;
            base.scaleMode = yMap.get('scaleMode') ?? 'fit';
            base.crop = safeParseJSON(yMap.get('crop') as string | null) ?? null;
            base.cornerRadius = yMap.get('cornerRadius') ?? 0;
            base.alt = yMap.get('alt') ?? '';
            break;
        case 'ellipse':
        case 'diamond':
            // No type-specific fields beyond base
            break;
    }

    return base as unknown as CanvasElement;
}

// ─── Tombstones ───────────────────────────────────────────────

/** Whether `id` has been tombstoned (deleted) in the shared doc. */
export function isTombstoned(tombstones: Y.Map<number>, id: string): boolean {
    return tombstones.has(id);
}

/**
 * Read a live element by id: returns null if missing or tombstoned.
 * The single read path used by the engine for remote → store application.
 */
export function readLiveElement(
    yElements: Y.Map<Y.Map<unknown>>,
    tombstones: Y.Map<number>,
    id: string,
): CanvasElement | null {
    if (tombstones.has(id)) return null;
    const yMap = yElements.get(id);
    if (!yMap) return null;
    return yMapToElement(yMap);
}

/**
 * Collect all live (non-tombstoned) elements, sorted by `sortOrder`.
 * Used for the initial Yjs → store hydration.
 */
export function collectLiveElements(
    yElements: Y.Map<Y.Map<unknown>>,
    tombstones: Y.Map<number>,
): CanvasElement[] {
    const elements: CanvasElement[] = [];
    for (const [id, yMap] of yElements.entries()) {
        if (tombstones.has(id)) continue;
        const el = yMapToElement(yMap);
        if (el) elements.push(el);
    }
    sortBySortOrder(elements);
    return elements;
}

/** Stable sort by fractional `sortOrder` (lexicographic); no-op when absent. */
export function sortBySortOrder(elements: CanvasElement[]): void {
    elements.sort((a, b) => {
        if (a.sortOrder && b.sortOrder) {
            return a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0;
        }
        return 0;
    });
}

// ─── Op → Yjs translation ─────────────────────────────────────

/**
 * Apply a single `CanvasOperation` as a granular Yjs mutation.
 * MUST be called inside a `doc.transact(..., origin)` so a whole batch lands
 * atomically and the engine can ignore its own echo via the origin.
 */
export function applyOperationToYjs(
    op: CanvasOperation,
    yElements: Y.Map<Y.Map<unknown>>,
    tombstones: Y.Map<number>,
): void {
    switch (op.type) {
        case 'add': {
            const id = op.element.id;
            // Explicit (re-)add wins over a prior delete → clear the tombstone.
            if (tombstones.has(id)) tombstones.delete(id);
            const existing = yElements.get(id);
            if (existing) {
                // Already present (e.g. resurrection of a still-living map) —
                // refresh fields rather than clobbering the shared sub-types.
                syncResidualFields(op.element, existing);
                return;
            }
            const yMap = new Y.Map<unknown>();
            elementToYMap(op.element, yMap);
            yElements.set(id, yMap);
            return;
        }

        case 'delete': {
            tombstones.set(op.elementId, Date.now());
            yElements.delete(op.elementId);
            return;
        }

        case 'move': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            // Relative delta on the LWW scalars: composes with already-merged
            // remote moves of the SAME element and keeps independent moves of
            // DIFFERENT elements fully conflict-free.
            yMap.set('x', ((yMap.get('x') as number) ?? 0) + op.dx);
            yMap.set('y', ((yMap.get('y') as number) ?? 0) + op.dy);
            return;
        }

        case 'resize': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            yMap.set('width', op.width);
            yMap.set('height', op.height);
            if (op.x !== undefined) yMap.set('x', op.x);
            if (op.y !== undefined) yMap.set('y', op.y);
            return;
        }

        case 'rotate': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            yMap.set('rotation', op.rotation);
            return;
        }

        case 'style': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            for (const [key, value] of Object.entries(op.changes)) {
                yMap.set(`style.${key}`, value);
            }
            return;
        }

        case 'reorder': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            yMap.set('sortOrder', op.sortOrder);
            return;
        }

        case 'updatePoints': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            const yarr = getOrCreateYArray(yMap, 'points', op.points);
            reconcileYArray(yarr, op.points);
            return;
        }

        case 'setText': {
            const yMap = yElements.get(op.elementId);
            if (!yMap) return;
            const ytext = getOrCreateYText(yMap, 'text', op.text);
            reconcileYText(ytext, op.text);
            return;
        }

        case 'batch': {
            for (const sub of op.operations) {
                applyOperationToYjs(sub, yElements, tombstones);
            }
            return;
        }
    }
}

/**
 * Reconcile the LWW fields that no `CanvasOperation` covers
 * (lock/visibility/version, coarse JSON structures and type-specific scalars).
 * Geometry, style, points, text and sortOrder are handled by ops, so they are
 * intentionally skipped here to avoid double-writes.
 */
export function syncResidualFields(el: CanvasElement, yMap: Y.Map<unknown>): void {
    const elRecord = el as unknown as Record<string, unknown>;
    for (const field of RESIDUAL_BASE_FIELDS) {
        const value = elRecord[field];
        if (value !== yMap.get(field)) yMap.set(field, value);
    }

    setIfChanged(yMap, 'boundElements', el.boundElements ? JSON.stringify(el.boundElements) : null);
    setIfChanged(yMap, 'ports', el.ports ? JSON.stringify(el.ports) : null);
    setIfChanged(yMap, 'groupIds', el.groupIds ? JSON.stringify(el.groupIds) : null);

    switch (el.type) {
        case 'rectangle':
            setIfChanged(yMap, 'cornerRadius', el.cornerRadius);
            break;
        case 'line':
        case 'arrow':
            setIfChanged(yMap, 'lineType', el.lineType);
            setIfChanged(yMap, 'curvature', el.curvature);
            setIfChanged(yMap, 'startBinding', el.startBinding ? JSON.stringify(el.startBinding) : null);
            setIfChanged(yMap, 'endBinding', el.endBinding ? JSON.stringify(el.endBinding) : null);
            setIfChanged(yMap, 'lineStyle', el.lineStyle ? JSON.stringify(el.lineStyle) : null);
            if (el.type === 'arrow') {
                setIfChanged(yMap, 'startArrowhead', el.startArrowhead);
                setIfChanged(yMap, 'endArrowhead', el.endArrowhead);
            }
            break;
        case 'text':
            setIfChanged(yMap, 'containerId', el.containerId);
            setIfChanged(yMap, 'textAlign', el.textAlign);
            setIfChanged(yMap, 'verticalAlign', el.verticalAlign);
            break;
        case 'image':
            setIfChanged(yMap, 'src', el.src);
            setIfChanged(yMap, 'naturalWidth', el.naturalWidth);
            setIfChanged(yMap, 'naturalHeight', el.naturalHeight);
            setIfChanged(yMap, 'scaleMode', el.scaleMode);
            setIfChanged(yMap, 'crop', el.crop ? JSON.stringify(el.crop) : null);
            setIfChanged(yMap, 'cornerRadius', el.cornerRadius);
            setIfChanged(yMap, 'alt', el.alt);
            break;
    }
}

// ─── Granular Y.Array / Y.Text reconcilers ────────────────────

/**
 * Splice a `Y.Array<number>` to match `next`, touching only the divergent
 * middle (longest common prefix/suffix preserved). Concurrent edits to
 * non-overlapping ranges (e.g. one user drags the start point, another the
 * end point) target distinct items and therefore converge.
 */
export function reconcileYArray(yarr: Y.Array<number>, next: number[]): void {
    const cur = yarr.toArray();
    if (cur.length === next.length && cur.every((v, i) => v === next[i])) return;

    let prefix = 0;
    const minLen = Math.min(cur.length, next.length);
    while (prefix < minLen && cur[prefix] === next[prefix]) prefix++;

    let suffix = 0;
    while (
        suffix < minLen - prefix &&
        cur[cur.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) suffix++;

    const delCount = cur.length - prefix - suffix;
    const insert = next.slice(prefix, next.length - suffix);
    if (delCount > 0) yarr.delete(prefix, delCount);
    if (insert.length > 0) yarr.insert(prefix, insert);
}

/**
 * Apply the minimal delta to a `Y.Text` so it equals `next` (common
 * prefix/suffix preserved). Edits at different offsets merge as a sequence CRDT.
 */
export function reconcileYText(ytext: Y.Text, next: string): void {
    const cur = ytext.toString();
    if (cur === next) return;

    let prefix = 0;
    const minLen = Math.min(cur.length, next.length);
    while (prefix < minLen && cur[prefix] === next[prefix]) prefix++;

    let suffix = 0;
    while (
        suffix < minLen - prefix &&
        cur[cur.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) suffix++;

    const delCount = cur.length - prefix - suffix;
    const insert = next.slice(prefix, next.length - suffix);
    if (delCount > 0) ytext.delete(prefix, delCount);
    if (insert.length > 0) ytext.insert(prefix, insert);
}

// ─── Internal helpers ─────────────────────────────────────────

function makeYArray(points: number[]): Y.Array<number> {
    const arr = new Y.Array<number>();
    if (points.length) arr.insert(0, points);
    return arr;
}

function makeYText(text: string): Y.Text {
    const yt = new Y.Text();
    if (text) yt.insert(0, text);
    return yt;
}

/** Return the existing `Y.Array` at `key`, else (re)create one from `init`. */
function getOrCreateYArray(yMap: Y.Map<unknown>, key: string, init: number[]): Y.Array<number> {
    const cur = yMap.get(key);
    if (cur instanceof Y.Array) return cur as Y.Array<number>;
    const arr = makeYArray(init);
    yMap.set(key, arr);
    return arr;
}

/** Return the existing `Y.Text` at `key`, else (re)create one from `init`. */
function getOrCreateYText(yMap: Y.Map<unknown>, key: string, init: string): Y.Text {
    const cur = yMap.get(key);
    if (cur instanceof Y.Text) return cur as Y.Text;
    const yt = makeYText(init);
    yMap.set(key, yt);
    return yt;
}

function readPoints(value: unknown, fallback: number[]): number[] {
    if (value instanceof Y.Array) return (value as Y.Array<number>).toArray();
    if (typeof value === 'string') return (safeParseJSON(value) as number[] | null) ?? fallback;
    if (Array.isArray(value)) return value as number[];
    return fallback;
}

function readText(value: unknown): string {
    if (value instanceof Y.Text) return value.toString();
    if (typeof value === 'string') return value;
    return '';
}

function setIfChanged(yMap: Y.Map<unknown>, key: string, value: unknown): void {
    if (value !== yMap.get(key)) yMap.set(key, value);
}

function safeParseJSON(json: string | null | undefined): unknown {
    if (json == null) return null;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}
