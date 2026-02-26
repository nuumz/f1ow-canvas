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
