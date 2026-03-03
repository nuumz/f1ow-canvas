/**
 * labelMetrics.ts
 *
 * Single source of truth for connector label sizing — shared by both
 * the Konva display path (TextShape render) and the DOM textarea editor.
 *
 * By measuring text with the same Canvas 2D API that Konva uses internally,
 * both modes produce identical dimensions → no visual "jump" between
 * display and editing.
 *
 * @see docs/CONNECTOR_LABEL_DESIGN.md
 */

// ── Constants ─────────────────────────────────────────────────
/** Horizontal padding inside the pill background (px, canvas-space) */
export const LABEL_PADDING_H = 8;
/** Vertical padding inside the pill background (px, canvas-space) */
export const LABEL_PADDING_V = 4;
/** Corner radius of the pill background (px, canvas-space) */
export const LABEL_CORNER = 4;
/** Line-height multiplier — must match Konva <Text lineHeight> */
export const LABEL_LINE_HEIGHT = 1.18;
/** Minimum text content width to avoid zero-width pill */
export const LABEL_MIN_WIDTH = 10;

// ── Shared canvas for text measurement ────────────────────────
// Reuse a single off-screen canvas to avoid GC pressure.
let _measureCanvas: HTMLCanvasElement | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
    if (!_measureCanvas) {
        _measureCanvas = document.createElement('canvas');
    }
    return _measureCanvas.getContext('2d')!;
}

/**
 * Measure text width/height using Canvas 2D — the same engine Konva uses.
 *
 * This function is the **single measurement source** for connector labels.
 * Both the Konva `<Text>` node and the DOM `<textarea>` editor derive
 * their dimensions from these numbers.
 *
 * @param text       - The label string (single-line; newlines ignored)
 * @param fontSize   - Font size in canvas-space pixels
 * @param fontFamily - CSS font-family string
 * @returns `{ width, height }` in canvas-space pixels (not screen pixels)
 */
export function measureLabelText(
    text: string,
    fontSize: number,
    fontFamily: string,
): { width: number; height: number } {
    const ctx = getMeasureCtx();
    ctx.font = `${fontSize}px ${fontFamily}`;
    const metrics = ctx.measureText(text || ' ');
    return {
        width: Math.ceil(metrics.width),
        height: Math.ceil(fontSize * LABEL_LINE_HEIGHT),
    };
}

/**
 * Compute the CSS half-leading offset for a given font.
 *
 * Konva renders text with `textBaseline='top'` — the glyph top aligns
 * with the node's y position (no leading above).
 * CSS distributes leading equally above and below the content area
 * within each line box.  The half-leading is the space ABOVE the glyphs
 * that CSS adds but Konva does not.
 *
 * To align a DOM textarea's visible text with Konva's rendered text,
 * shift the textarea UP by this amount (in canvas-space pixels).
 *
 * Uses `fontBoundingBoxAscent/Descent` for accurate per-font measurement
 * with a safe fallback for older browsers.
 *
 * @param fontSize   - Font size in canvas-space pixels
 * @param fontFamily - CSS font-family string
 * @param lineHeight - Line-height multiplier (default: LABEL_LINE_HEIGHT)
 * @returns Half-leading in canvas-space pixels (≥ 0)
 */
export function computeHalfLeading(
    fontSize: number,
    fontFamily: string,
    lineHeight: number = LABEL_LINE_HEIGHT,
): number {
    const ctx = getMeasureCtx();
    ctx.font = `${fontSize}px ${fontFamily}`;
    const m = ctx.measureText('Mg');

    // fontBoundingBox* gives the font's actual content-area height,
    // which varies by typeface (e.g. Arial ≈ 1.15em, Segoe UI ≈ 1.12em).
    let contentAreaHeight: number;
    if (m.fontBoundingBoxAscent !== undefined && m.fontBoundingBoxDescent !== undefined) {
        contentAreaHeight = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    } else {
        // Fallback: assume content area ≈ 1.15× fontSize (common for sans-serif)
        contentAreaHeight = fontSize * 1.15;
    }

    return Math.max(0, (lineHeight * fontSize - contentAreaHeight) / 2);
}

/**
 * Compute the full pill (background rect) dimensions for a connector label.
 *
 * @param textWidth  - Measured text content width (from `measureLabelText`)
 * @param textHeight - Measured text content height (from `measureLabelText`)
 * @returns `{ width, height }` of the pill in canvas-space pixels
 */
export function computePillSize(
    textWidth: number,
    textHeight: number,
): { width: number; height: number } {
    return {
        width: Math.max(LABEL_MIN_WIDTH, textWidth) + LABEL_PADDING_H * 2,
        height: textHeight + LABEL_PADDING_V * 2,
    };
}
