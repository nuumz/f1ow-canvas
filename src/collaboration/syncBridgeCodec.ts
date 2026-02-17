/**
 * collaboration/syncBridgeCodec.ts — Serialization/deserialization between
 * CanvasElement and Y.Map for CRDT collaboration.
 *
 * Extracted from syncBridge.ts so both the legacy module-level bridge
 * and the new CollaborationManager class can share the same codec.
 */
import * as Y from 'yjs';
import type { CanvasElement } from '@/types';

// ─── Field definitions ───────────────────────────────────────

/** Base fields serialized for every element */
export const SYNC_FIELDS = [
    'id', 'type', 'x', 'y', 'width', 'height', 'rotation',
    'isLocked', 'isVisible', 'sortOrder',
] as const;

/** Style sub-fields (flattened to `style.fieldName` for granular LWW) */
export const STYLE_FIELDS = [
    'strokeColor', 'fillColor', 'strokeWidth', 'opacity',
    'strokeStyle', 'roughness', 'fontSize', 'fontFamily',
] as const;

// ─── Serialization ────────────────────────────────────────────

/**
 * Convert a CanvasElement to Y.Map entries.
 * Flattens style fields to `style.fieldName` for per-field LWW.
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

    // Bound elements
    if (el.boundElements) {
        yMap.set('boundElements', JSON.stringify(el.boundElements));
    } else {
        yMap.set('boundElements', null);
    }

    // Group IDs
    if (el.groupIds) {
        yMap.set('groupIds', JSON.stringify(el.groupIds));
    }

    // Type-specific fields
    switch (el.type) {
        case 'rectangle':
            yMap.set('cornerRadius', el.cornerRadius);
            break;
        case 'line':
        case 'arrow':
            yMap.set('points', JSON.stringify(el.points));
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
            yMap.set('points', JSON.stringify(el.points));
            break;
        case 'text':
            yMap.set('text', el.text);
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

// ─── Deserialization ──────────────────────────────────────────

/**
 * Reconstruct a CanvasElement from a Y.Map.
 * Inverse of elementToYMap.
 */
export function yMapToElement(yMap: Y.Map<unknown>): CanvasElement | null {
    const type = yMap.get('type') as string;
    const id = yMap.get('id') as string;
    if (!type || !id) return null;

    // Reconstruct style
    const style: Record<string, unknown> = {};
    for (const sf of STYLE_FIELDS) {
        const val = yMap.get(`style.${sf}`);
        if (val !== undefined) {
            style[sf] = val;
        }
    }

    // Base fields
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
        style,
        boundElements: safeParseJSON(yMap.get('boundElements') as string | null) ?? null,
        groupIds: safeParseJSON(yMap.get('groupIds') as string | null) ?? undefined,
        sortOrder: yMap.get('sortOrder') ?? undefined,
    };

    // Type-specific fields
    switch (type) {
        case 'rectangle':
            base.cornerRadius = yMap.get('cornerRadius') ?? 0;
            break;
        case 'line':
        case 'arrow':
            base.points = safeParseJSON(yMap.get('points') as string) ?? [0, 0, 100, 0];
            base.lineType = yMap.get('lineType') ?? 'sharp';
            base.curvature = yMap.get('curvature') ?? undefined;
            base.startBinding = safeParseJSON(yMap.get('startBinding') as string | null);
            base.endBinding = safeParseJSON(yMap.get('endBinding') as string | null);
            if (type === 'arrow') {
                base.startArrowhead = yMap.get('startArrowhead') ?? null;
                base.endArrowhead = yMap.get('endArrowhead') ?? 'arrow';
            }
            break;
        case 'freedraw':
            base.points = safeParseJSON(yMap.get('points') as string) ?? [];
            break;
        case 'text':
            base.text = yMap.get('text') ?? '';
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

// ─── Utility ──────────────────────────────────────────────────

function safeParseJSON(json: string | null | undefined): unknown {
    if (json == null) return null;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}
