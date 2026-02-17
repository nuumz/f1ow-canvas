import type { Point } from '@/types';

/** Snap a value to the nearest grid increment */
export function snapToGrid(value: number, gridSize: number): number {
    return Math.round(value / gridSize) * gridSize;
}

/** Distance between two points */
export function distance(a: Point, b: Point): number {
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

/** Normalize a point pair to top-left + dimensions */
export function normalizeRect(
    start: Point,
    end: Point
): { x: number; y: number; width: number; height: number } {
    return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
    };
}

/** Rotate a point around a center */
export function rotatePoint(point: Point, center: Point, angle: number): Point {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos,
    };
}

/** Check if a point is inside a rectangle */
export function isPointInRect(
    point: Point,
    rect: { x: number; y: number; width: number; height: number }
): boolean {
    return (
        point.x >= rect.x &&
        point.x <= rect.x + rect.width &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.height
    );
}

/** Get diamond polygon points from bounding box */
export function getDiamondPoints(width: number, height: number): number[] {
    return [
        width / 2, 0,         // top
        width, height / 2,     // right
        width / 2, height,     // bottom
        0, height / 2,         // left
    ];
}

/**
 * Normalize a point pair to a **symmetric** (square) bounding box.
 * The larger of |dx| or |dy| is used for both dimensions.
 * Origin stays at the `start` corner and expands toward the `end` direction.
 */
export function normalizeSymmetricRect(
    start: Point,
    end: Point,
): { x: number; y: number; width: number; height: number } {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;

    const ax = signX >= 0 ? start.x : start.x - side;
    const ay = signY >= 0 ? start.y : start.y - side;

    return { x: ax, y: ay, width: side, height: side };
}

/** Angle snap increments (every 45°) */
const SNAP_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315, 360];
const DEG = Math.PI / 180;

/**
 * Constrain an endpoint so the line from `start` → `end` snaps
 * to the nearest 45° increment (0°, 45°, 90°, 135°, …).
 */
export function constrainLineAngle(start: Point, end: Point): Point {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return { ...end };

    // atan2 gives angle from positive-X axis, clockwise in screen coords
    let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angleDeg < 0) angleDeg += 360;

    // Find nearest snap angle
    let closest = SNAP_ANGLES[0];
    let minDiff = 999;
    for (const sa of SNAP_ANGLES) {
        const diff = Math.abs(angleDeg - sa);
        if (diff < minDiff) {
            minDiff = diff;
            closest = sa;
        }
    }
    // Normalize 360 → 0
    if (closest === 360) closest = 0;

    const rad = closest * DEG;
    return {
        x: start.x + len * Math.cos(rad),
        y: start.y + len * Math.sin(rad),
    };
}

/**
 * Compute bounding width/height extents from a flat [x,y,x,y,...] points array.
 * Used by linear element shapes and handles.
 */
export function computePointsBounds(pts: number[]): { width: number; height: number } {
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]);
        maxX = Math.max(maxX, pts[i]);
        minY = Math.min(minY, pts[i + 1]);
        maxY = Math.max(maxY, pts[i + 1]);
    }
    return { width: maxX - minX, height: maxY - minY };
}

/** Convert dash style string to Konva dash array */
export function getStrokeDash(
    style: 'solid' | 'dashed' | 'dotted',
    strokeWidth: number
): number[] {
    switch (style) {
        case 'dashed':
            return [strokeWidth * 4, strokeWidth * 4];
        case 'dotted':
            return [strokeWidth, strokeWidth * 2];
        case 'solid':
        default:
            return [];
    }
}
