/**
 * webgl/textureAtlas.ts — Rasterise canvas elements to a WebGL texture atlas.
 *
 * Each element is drawn onto an OffscreenCanvas at a suitable resolution,
 * then packed into a 2D texture atlas. The atlas uses shelf-based packing
 * (simple row packing) which is fast and good enough for varying-sized rects.
 *
 * Atlas size: 4096×4096 (max common WebGL2 texture size on all platforms).
 * When the atlas is full, a new atlas texture is created.
 *
 * Each element gets a UV region `{ u, v, uWidth, vHeight }` describing its
 * position in the atlas, used by the vertex shader.
 */

import type { CanvasElement } from '@/types';

// ─── Types ────────────────────────────────────────────────────

export interface AtlasRegion {
    /** Atlas texture index (for multi-atlas) */
    atlasIndex: number;
    /** UV coordinates (0-1) in the atlas */
    u: number;
    v: number;
    uWidth: number;
    vHeight: number;
    /** Pixel dimensions in the atlas */
    pixelWidth: number;
    pixelHeight: number;
}

export interface AtlasEntry {
    elementId: string;
    region: AtlasRegion;
    /** Generation when element was last rasterised */
    generation: number;
}

// ─── Constants ────────────────────────────────────────────────

/** Maximum atlas texture size (WebGL2 guarantees >= 4096) */
const ATLAS_SIZE = 4096;

/**
 * Max pixel dimension for a single element in the atlas.
 * Very large elements are clamped to this and scaled down.
 */
const MAX_ELEMENT_SIZE = 1024;

/**
 * Minimum pixel dimension for rasterisation.
 * Very small elements get at least this many pixels.
 */
const MIN_ELEMENT_SIZE = 16;

/**
 * Padding between atlas entries to avoid texture bleeding.
 */
const ATLAS_PADDING = 2;

// ─── Shelf Packer ─────────────────────────────────────────────

interface Shelf {
    y: number;
    height: number;
    x: number; // current write cursor
}

/**
 * Manages packing of rectangles into a fixed-size atlas using shelf packing.
 */
class ShelfPacker {
    private _shelves: Shelf[] = [];
    private _atlasWidth: number;
    private _atlasHeight: number;

    constructor(width = ATLAS_SIZE, height = ATLAS_SIZE) {
        this._atlasWidth = width;
        this._atlasHeight = height;
    }

    /**
     * Pack a rectangle of given size. Returns pixel position or null if no room.
     */
    pack(w: number, h: number): { x: number; y: number } | null {
        const pw = w + ATLAS_PADDING;
        const ph = h + ATLAS_PADDING;

        // Try existing shelves
        for (const shelf of this._shelves) {
            if (shelf.height >= ph && shelf.x + pw <= this._atlasWidth) {
                const pos = { x: shelf.x, y: shelf.y };
                shelf.x += pw;
                return pos;
            }
        }

        // Create new shelf
        const shelfY = this._shelves.length > 0
            ? this._shelves[this._shelves.length - 1].y + this._shelves[this._shelves.length - 1].height
            : 0;

        if (shelfY + ph > this._atlasHeight) return null; // atlas full

        const shelf: Shelf = { y: shelfY, height: ph, x: pw };
        this._shelves.push(shelf);
        return { x: 0, y: shelfY };
    }

    /** Reset packer for reuse */
    reset(): void {
        this._shelves = [];
    }
}

// ─── TextureAtlas ─────────────────────────────────────────────

/**
 * Custom draw function for rasterising a single element to a 2D context.
 * The context is pre-translated so the element's top-left is at (0, 0).
 */
export type ElementRasterFn = (
    ctx: OffscreenCanvasRenderingContext2D,
    element: CanvasElement,
    width: number,
    height: number,
) => void;

export class TextureAtlas {
    private _entries = new Map<string, AtlasEntry>();
    private _packer: ShelfPacker;
    private _canvas: OffscreenCanvas;
    private _ctx: OffscreenCanvasRenderingContext2D;
    private _drawFn: ElementRasterFn;
    private _dirty = false;
    private _generation = 0;

    constructor(drawFn?: ElementRasterFn) {
        this._packer = new ShelfPacker(ATLAS_SIZE, ATLAS_SIZE);
        this._canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
        this._ctx = this._canvas.getContext('2d')!;
        this._drawFn = drawFn ?? defaultElementRaster;
    }

    /**
     * Ensure an element has an up-to-date atlas entry.
     * Rasterises only if the element is new or its generation is stale.
     */
    addOrUpdate(element: CanvasElement, generation: number): AtlasRegion | null {
        const existing = this._entries.get(element.id);
        if (existing && existing.generation >= generation) {
            return existing.region;
        }

        // Compute pixel dimensions
        const { pw, ph } = elementPixelDims(element);

        // Pack into atlas
        const pos = this._packer.pack(pw, ph);
        if (!pos) return null; // atlas full

        // Rasterise element at the packed position
        this._ctx.save();
        this._ctx.clearRect(pos.x, pos.y, pw, ph);
        this._ctx.translate(pos.x, pos.y);
        // Scale element world size to pixel size
        const scaleX = pw / Math.max(element.width, 1);
        const scaleY = ph / Math.max(element.height, 1);
        this._ctx.scale(scaleX, scaleY);
        this._drawFn(this._ctx, element, element.width, element.height);
        this._ctx.restore();

        const region: AtlasRegion = {
            atlasIndex: 0,
            u: pos.x / ATLAS_SIZE,
            v: pos.y / ATLAS_SIZE,
            uWidth: pw / ATLAS_SIZE,
            vHeight: ph / ATLAS_SIZE,
            pixelWidth: pw,
            pixelHeight: ph,
        };

        this._entries.set(element.id, {
            elementId: element.id,
            region,
            generation,
        });
        this._dirty = true;

        return region;
    }

    /** Get atlas region for an element. */
    getRegion(elementId: string): AtlasRegion | null {
        return this._entries.get(elementId)?.region ?? null;
    }

    /** Remove an element from tracking (does not reclaim atlas space). */
    remove(elementId: string): void {
        this._entries.delete(elementId);
    }

    /** Full rebuild — clears atlas and re-rasterises all provided elements. */
    rebuild(elements: CanvasElement[]): void {
        this._generation++;
        this._packer.reset();
        this._entries.clear();
        this._ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
        for (const el of elements) {
            this.addOrUpdate(el, this._generation);
        }
        this._dirty = true;
    }

    /** Whether the atlas canvas has changed since the last `getCanvas()` call. */
    get isDirty(): boolean {
        return this._dirty;
    }

    /** Get the atlas OffscreenCanvas for uploading to WebGL texture. */
    getCanvas(): OffscreenCanvas {
        this._dirty = false;
        return this._canvas;
    }

    /** Current generation counter. */
    get generation(): number {
        return this._generation;
    }

    /** Number of entries in the atlas. */
    get size(): number {
        return this._entries.size;
    }

    dispose(): void {
        this._entries.clear();
    }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Compute pixel dimensions for an element in the atlas.
 * Clamps to [MIN_ELEMENT_SIZE, MAX_ELEMENT_SIZE].
 */
function elementPixelDims(el: CanvasElement): { pw: number; ph: number } {
    const aspect = Math.max(el.width, 1) / Math.max(el.height, 1);
    let pw: number, ph: number;

    if (el.width >= el.height) {
        pw = Math.min(Math.max(Math.ceil(el.width), MIN_ELEMENT_SIZE), MAX_ELEMENT_SIZE);
        ph = Math.min(Math.max(Math.ceil(pw / aspect), MIN_ELEMENT_SIZE), MAX_ELEMENT_SIZE);
    } else {
        ph = Math.min(Math.max(Math.ceil(el.height), MIN_ELEMENT_SIZE), MAX_ELEMENT_SIZE);
        pw = Math.min(Math.max(Math.ceil(ph * aspect), MIN_ELEMENT_SIZE), MAX_ELEMENT_SIZE);
    }
    return { pw, ph };
}

/**
 * Default element rasterisation function. Simple canvas 2D shapes.
 * For production, consumers should inject a more faithful renderer.
 */
function defaultElementRaster(
    ctx: OffscreenCanvasRenderingContext2D,
    el: CanvasElement,
    w: number,
    h: number,
): void {
    const strokeColor = el.style?.strokeColor ?? '#000000';
    const fillColor = el.style?.fillColor ?? 'transparent';
    const strokeWidth = el.style?.strokeWidth ?? 2;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;
    ctx.lineWidth = strokeWidth;
    ctx.globalAlpha = el.style?.opacity ?? 1;

    switch (el.type) {
        case 'rectangle':
            ctx.beginPath();
            ctx.rect(0, 0, w, h);
            if (fillColor !== 'transparent') ctx.fill();
            ctx.stroke();
            break;

        case 'ellipse':
            ctx.beginPath();
            ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            if (fillColor !== 'transparent') ctx.fill();
            ctx.stroke();
            break;

        case 'diamond': {
            ctx.beginPath();
            ctx.moveTo(w / 2, 0);
            ctx.lineTo(w, h / 2);
            ctx.lineTo(w / 2, h);
            ctx.lineTo(0, h / 2);
            ctx.closePath();
            if (fillColor !== 'transparent') ctx.fill();
            ctx.stroke();
            break;
        }

        case 'text': {
            const textEl = el as unknown as { text: string; style?: { fontSize?: number; fontFamily?: string } };
            ctx.font = `${textEl.style?.fontSize ?? 16}px ${textEl.style?.fontFamily ?? 'sans-serif'}`;
            ctx.fillStyle = strokeColor;
            ctx.fillText(textEl.text, 0, textEl.style?.fontSize ?? 16);
            break;
        }

        default:
            // line, arrow, freedraw, image — draw a simple placeholder
            ctx.strokeStyle = '#aaa';
            ctx.strokeRect(0, 0, w, h);
            break;
    }
}
