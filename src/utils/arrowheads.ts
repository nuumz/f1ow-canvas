/**
 * arrowheads.ts
 *
 * Custom arrowhead rendering for Konva.  Draws arrowheads at the
 * start and/or end of a line using canvas-2d directly via a
 * Konva.Shape sceneFunc.
 *
 * Supported types: arrow, triangle, triangle_outline, circle,
 * circle_outline, diamond, diamond_outline, bar, crowfoot_one,
 * crowfoot_many, crowfoot_one_or_many.
 */
import type { Arrowhead, Point } from '@/types';
import type { Context } from 'konva/lib/Context';

// ── Helpers ───────────────────────────────────────────────────

/** Get unit vector from p1 toward p0 (direction the arrowhead points) */
function direction(p0: Point, p1: Point): Point {
    const dx = p0.x - p1.x;
    const dy = p0.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
}

/** Perpendicular (rotate 90° CCW) */
function perp(d: Point): Point {
    return { x: -d.y, y: d.x };
}

// ── Arrowhead Size ────────────────────────────────────────────

export function arrowheadSize(strokeWidth: number): number {
    return Math.max(10, strokeWidth * 4);
}

// ── Main draw function ────────────────────────────────────────

/**
 * Draw an arrowhead of the given type at `tip`, with the arrow
 * body arriving from direction `from`.
 *
 * @param ctx       Konva canvas context
 * @param type      Arrowhead variant
 * @param tip       Position of the arrowhead tip (world-local coords)
 * @param from      Position the arrow body is coming *from*
 * @param size      Size of the arrowhead (pixel length)
 * @param stroke    Stroke color
 * @param strokeW   Stroke width
 */
export function drawArrowhead(
    ctx: Context,
    type: Arrowhead,
    tip: Point,
    from: Point,
    size: number,
    stroke: string,
    strokeW: number,
): void {
    const dir = direction(tip, from); // points *toward* the tip
    const prp = perp(dir);
    const half = size * 0.45;
    const c = ctx._context; // raw CanvasRenderingContext2D

    c.save();
    c.strokeStyle = stroke;
    c.fillStyle = stroke;
    c.lineWidth = strokeW;
    c.lineJoin = 'round';
    c.lineCap = 'round';

    switch (type) {
        // ─── Standard open arrow ▷ ────────────────────────────
        case 'arrow': {
            const base1 = { x: tip.x - dir.x * size + prp.x * half, y: tip.y - dir.y * size + prp.y * half };
            const base2 = { x: tip.x - dir.x * size - prp.x * half, y: tip.y - dir.y * size - prp.y * half };
            c.beginPath();
            c.moveTo(base1.x, base1.y);
            c.lineTo(tip.x, tip.y);
            c.lineTo(base2.x, base2.y);
            c.stroke();
            break;
        }

        // ─── Solid filled triangle ▶ ──────────────────────────
        case 'triangle': {
            const base1 = { x: tip.x - dir.x * size + prp.x * half, y: tip.y - dir.y * size + prp.y * half };
            const base2 = { x: tip.x - dir.x * size - prp.x * half, y: tip.y - dir.y * size - prp.y * half };
            c.beginPath();
            c.moveTo(tip.x, tip.y);
            c.lineTo(base1.x, base1.y);
            c.lineTo(base2.x, base2.y);
            c.closePath();
            c.fill();
            c.stroke();
            break;
        }

        // ─── Hollow triangle △ ────────────────────────────────
        case 'triangle_outline': {
            const base1 = { x: tip.x - dir.x * size + prp.x * half, y: tip.y - dir.y * size + prp.y * half };
            const base2 = { x: tip.x - dir.x * size - prp.x * half, y: tip.y - dir.y * size - prp.y * half };
            c.fillStyle = '#ffffff';
            c.beginPath();
            c.moveTo(tip.x, tip.y);
            c.lineTo(base1.x, base1.y);
            c.lineTo(base2.x, base2.y);
            c.closePath();
            c.fill();
            c.stroke();
            break;
        }

        // ─── Solid circle ● ──────────────────────────────────
        case 'circle': {
            const r = size * 0.35;
            const cx = tip.x - dir.x * r;
            const cy = tip.y - dir.y * r;
            c.beginPath();
            c.arc(cx, cy, r, 0, Math.PI * 2);
            c.fill();
            c.stroke();
            break;
        }

        // ─── Hollow circle ○ ─────────────────────────────────
        case 'circle_outline': {
            const r = size * 0.35;
            const cx = tip.x - dir.x * r;
            const cy = tip.y - dir.y * r;
            c.fillStyle = '#ffffff';
            c.beginPath();
            c.arc(cx, cy, r, 0, Math.PI * 2);
            c.fill();
            c.stroke();
            break;
        }

        // ─── Solid diamond ◆ ─────────────────────────────────
        case 'diamond': {
            const hw = half * 0.7;
            const hl = size * 0.55;
            const center = { x: tip.x - dir.x * hl, y: tip.y - dir.y * hl };
            c.beginPath();
            c.moveTo(tip.x, tip.y); // top (tip)
            c.lineTo(center.x + prp.x * hw, center.y + prp.y * hw); // right
            c.lineTo(center.x - dir.x * hl, center.y - dir.y * hl); // bottom (tail)
            c.lineTo(center.x - prp.x * hw, center.y - prp.y * hw); // left
            c.closePath();
            c.fill();
            c.stroke();
            break;
        }

        // ─── Hollow diamond ◇ ────────────────────────────────
        case 'diamond_outline': {
            const hw = half * 0.7;
            const hl = size * 0.55;
            const center = { x: tip.x - dir.x * hl, y: tip.y - dir.y * hl };
            c.fillStyle = '#ffffff';
            c.beginPath();
            c.moveTo(tip.x, tip.y);
            c.lineTo(center.x + prp.x * hw, center.y + prp.y * hw);
            c.lineTo(center.x - dir.x * hl, center.y - dir.y * hl);
            c.lineTo(center.x - prp.x * hw, center.y - prp.y * hw);
            c.closePath();
            c.fill();
            c.stroke();
            break;
        }

        // ─── Vertical bar | ──────────────────────────────────
        case 'bar': {
            const barH = half * 1.2;
            c.beginPath();
            c.moveTo(tip.x + prp.x * barH, tip.y + prp.y * barH);
            c.lineTo(tip.x - prp.x * barH, tip.y - prp.y * barH);
            c.stroke();
            break;
        }

        // ─── Crow's foot: one || ─────────────────────────────
        case 'crowfoot_one': {
            const barH = half * 1.0;
            const offset = size * 0.25;
            // First bar at tip
            c.beginPath();
            c.moveTo(tip.x + prp.x * barH, tip.y + prp.y * barH);
            c.lineTo(tip.x - prp.x * barH, tip.y - prp.y * barH);
            c.stroke();
            // Second bar slightly behind
            const b2 = { x: tip.x - dir.x * offset, y: tip.y - dir.y * offset };
            c.beginPath();
            c.moveTo(b2.x + prp.x * barH, b2.y + prp.y * barH);
            c.lineTo(b2.x - prp.x * barH, b2.y - prp.y * barH);
            c.stroke();
            break;
        }

        // ─── Crow's foot: many >| ────────────────────────────
        case 'crowfoot_many': {
            const barH = half * 1.0;
            const footLen = size * 0.6;
            // Bar at tip
            c.beginPath();
            c.moveTo(tip.x + prp.x * barH, tip.y + prp.y * barH);
            c.lineTo(tip.x - prp.x * barH, tip.y - prp.y * barH);
            c.stroke();
            // Fork lines from behind tip to spread
            const forkBase = { x: tip.x - dir.x * footLen, y: tip.y - dir.y * footLen };
            c.beginPath();
            c.moveTo(tip.x + prp.x * barH, tip.y + prp.y * barH);
            c.lineTo(forkBase.x, forkBase.y);
            c.lineTo(tip.x - prp.x * barH, tip.y - prp.y * barH);
            c.stroke();
            break;
        }

        // ─── Crow's foot: one or many >|| ─────────────────────
        case 'crowfoot_one_or_many': {
            const barH = half * 1.0;
            const footLen = size * 0.6;
            const offset = size * 0.25;
            // Two bars at tip
            c.beginPath();
            c.moveTo(tip.x + prp.x * barH, tip.y + prp.y * barH);
            c.lineTo(tip.x - prp.x * barH, tip.y - prp.y * barH);
            c.stroke();
            const b2 = { x: tip.x - dir.x * offset, y: tip.y - dir.y * offset };
            c.beginPath();
            c.moveTo(b2.x + prp.x * barH, b2.y + prp.y * barH);
            c.lineTo(b2.x - prp.x * barH, b2.y - prp.y * barH);
            c.stroke();
            // Fork from behind
            const forkBase = { x: tip.x - dir.x * footLen, y: tip.y - dir.y * footLen };
            c.beginPath();
            c.moveTo(tip.x + prp.x * barH, tip.y + prp.y * barH);
            c.lineTo(forkBase.x, forkBase.y);
            c.lineTo(tip.x - prp.x * barH, tip.y - prp.y * barH);
            c.stroke();
            break;
        }
    }

    c.restore();
}

/**
 * Get pairs of { x, y } from flat points array.
 */
export function flatToPoints(pts: number[]): Point[] {
    const result: Point[] = [];
    for (let i = 0; i < pts.length; i += 2) {
        result.push({ x: pts[i], y: pts[i + 1] });
    }
    return result;
}
