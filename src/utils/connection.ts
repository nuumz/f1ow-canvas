/**
 * connection.ts — Connection point geometry, snap detection, and binding utilities.
 *
 * Uses a "fixedPoint" model: each binding stores a normalized [0-1, 0-1]
 * coordinate on the target shape's bounding box, enabling continuous
 * (not discrete) attachment positions.
 *
 * Supports shape rotation via local↔world coordinate transforms.
 *
 * ┌────────────── Shape Bounding Box ────────────────┐
 * │           [0.5, 0] top center                    │
 * │                    ●                             │
 * │  [0, 0.5] ●      center       ● [1, 0.5]       │
 * │                    ●                             │
 * │           [0.5, 1] bottom center                 │
 * └──────────────────────────────────────────────────┘
 */

import type {
    CanvasElement,
    Point,
    ConnectionAnchor,
    Binding,
    SnapTarget,
    ArrowElement,
    LineElement,
    TextElement,
    BoundElement,
} from '@/types';
import { getElbowPreferredDirection } from '@/utils/elbow';
import type { Direction } from '@/utils/elbow';
import { computeCurveControlPoint, quadBezierAt, CURVE_RATIO } from '@/utils/curve';

// ─── Shape types that can be connected ────────────────────────
const CONNECTABLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'image']);

/** Whether an element can be a connection target */
export function isConnectable(el: CanvasElement): boolean {
    return CONNECTABLE_TYPES.has(el.type);
}

// ─── Rotation helpers ─────────────────────────────────────────

/** Rotation in radians from a shape's `rotation` (degrees) */
function toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
}

/** Rotate a point around origin by angle (radians) */
function rotatePoint(px: number, py: number, angle: number): Point {
    if (angle === 0) return { x: px, y: py };
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { x: px * cos - py * sin, y: px * sin + py * cos };
}

/** Transform a world-space point into a shape's local coordinate system (unrotated, origin = shape center) */
function worldToLocal(el: CanvasElement, wp: Point): Point {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const dx = wp.x - cx;
    const dy = wp.y - cy;
    const angle = toRad(el.rotation || 0);
    if (angle === 0) return { x: dx, y: dy };
    return rotatePoint(dx, dy, -angle);
}

/** Transform a local-space point (relative to shape center) back to world space */
function localToWorld(el: CanvasElement, lp: Point): Point {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const angle = toRad(el.rotation || 0);
    const rotated = rotatePoint(lp.x, lp.y, angle);
    return { x: cx + rotated.x, y: cy + rotated.y };
}

// ─── Connection points for a shape (legacy / convenience) ─────

/** Get the 5 named anchor positions for a bounding-box shape */
export function getConnectionPoints(el: CanvasElement): Record<ConnectionAnchor, Point> {
    const { x, y, width: w, height: h } = el;
    const cx = x + w / 2;
    const cy = y + h / 2;
    return {
        top: { x: cx, y },
        bottom: { x: cx, y: y + h },
        left: { x, y: cy },
        right: { x: x + w, y: cy },
        center: { x: cx, y: cy },
    };
}

/**
 * @deprecated Use fixedPoint-based getEdgePointFromFixedPoint() instead.
 */
export function getAnchorPosition(el: CanvasElement, anchor: ConnectionAnchor): Point {
    return getConnectionPoints(el)[anchor];
}

// ─── Dynamic gap computation ──────────────────────────────────

/** Base offset for bound arrows (px) */
const BOUND_ARROW_OFFSET = 4;

/**
 * Compute the appropriate gap between a connector and a shape edge,
 * based on both the connector's stroke width and a base offset.
 * This provides a small gap between the arrow tip and the shape edge.
 */
export function computeBindingGap(connectorStrokeWidth: number): number {
    return BOUND_ARROW_OFFSET + connectorStrokeWidth / 2;
}

// ─── FixedPoint helpers ───────────────────────────────────────

/**
 * Compute a fixedPoint [0-1, 0-1] ratio from a world-space point
 * relative to a shape's bounding box, accounting for rotation.
 */
export function computeFixedPoint(el: CanvasElement, worldPt: Point): [number, number] {
    const w = el.width || 1;
    const h = el.height || 1;
    // Transform into local space (rotation-unaware bounding box)
    const local = worldToLocal(el, worldPt);
    // local is relative to center, convert to [0,1] range
    const fx = Math.max(0, Math.min(1, (local.x + w / 2) / w));
    const fy = Math.max(0, Math.min(1, (local.y + h / 2) / h));
    return [fx, fy];
}

/**
 * Convert a fixedPoint ratio back to a world-space target point,
 * then compute the edge intersection from center to that target.
 */
export function getEdgePointFromFixedPoint(
    el: CanvasElement,
    fixedPoint: [number, number],
    gap = 0,
): Point {
    // fixedPoint is in local space of the shape's bbox
    const localTargetX = (fixedPoint[0] - 0.5) * el.width;
    const localTargetY = (fixedPoint[1] - 0.5) * el.height;

    // Center fixedPoint [0.5, 0.5]: no meaningful direction for edge computation.
    // Return the element's center — callers (e.g. getAnchorDir) use this as a
    // direction anchor, and center-toward-center produces correct edge points
    // on the OTHER shape.
    if (localTargetX === 0 && localTargetY === 0) {
        return localToWorld(el, { x: 0, y: 0 });
    }

    // Convert local target to world space
    const worldTarget = localToWorld(el, { x: localTargetX, y: localTargetY });
    return getEdgePoint(el, worldTarget, gap);
}

// ─── Edge-point on shape perimeter ────────────────────────────

/**
 * Given a shape and an external world-space point, compute the point on
 * the shape's perimeter closest to `toward`.
 *
 * Handles shape rotation: transforms `toward` into the shape's local
 * coordinate system, computes the local edge intersection, then
 * transforms back to world space.
 */
export function getEdgePoint(el: CanvasElement, toward: Point, gap = 0): Point {
    // Work in local (unrotated) coordinates relative to shape center
    const local = worldToLocal(el, toward);
    const lx = local.x;
    const ly = local.y;

    if (lx === 0 && ly === 0) {
        // toward IS the center — fallback to top edge
        return localToWorld(el, { x: 0, y: -(el.height / 2 + gap) });
    }

    let edgeLocal: Point;

    switch (el.type) {
        case 'ellipse': {
            const a = el.width / 2;
            const b = el.height / 2;
            const angle = Math.atan2(ly, lx);
            edgeLocal = {
                x: (a + gap) * Math.cos(angle),
                y: (b + gap) * Math.sin(angle),
            };
            break;
        }

        case 'diamond': {
            const hw = el.width / 2;
            const hh = el.height / 2;
            const angle = Math.atan2(ly, lx);
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            const absCos = Math.abs(cosA);
            const absSin = Math.abs(sinA);
            const t = 1 / (absCos / hw + absSin / hh);
            const ex = t * cosA;
            const ey = t * sinA;

            if (gap === 0) {
                edgeLocal = { x: ex, y: ey };
            } else {
                // Compute outward normal of the diamond edge that was hit.
                // Diamond edges have normals: (1/hw, 1/hh), (−1/hw, 1/hh),
                // (−1/hw, −1/hh), (1/hw, −1/hh) — pick based on quadrant.
                const nx = (cosA >= 0 ? 1 : -1) / hw;
                const ny = (sinA >= 0 ? 1 : -1) / hh;
                const nLen = Math.sqrt(nx * nx + ny * ny);
                edgeLocal = {
                    x: ex + (nx / nLen) * gap,
                    y: ey + (ny / nLen) * gap,
                };
            }
            break;
        }

        default: {
            // Rectangle (and text, image which are rectangular)
            const hw = el.width / 2;
            const hh = el.height / 2;
            const angle = Math.atan2(ly, lx);
            const absTanAngle = Math.abs(Math.tan(angle));

            let ex: number, ey: number;
            if (absTanAngle <= hh / hw) {
                // Ray hits a vertical edge (left or right)
                ex = lx > 0 ? hw : -hw;
                ey = ex * Math.tan(angle);
            } else {
                // Ray hits a horizontal edge (top or bottom)
                ey = ly > 0 ? hh : -hh;
                ex = ey / Math.tan(angle);
            }

            if (gap === 0) {
                edgeLocal = { x: ex, y: ey };
            } else {
                // Push outward along the edge normal (perpendicular to edge),
                // not radially — gives uniform gap regardless of angle.
                if (absTanAngle <= hh / hw) {
                    // Hit vertical edge → normal is horizontal
                    edgeLocal = { x: ex + (lx > 0 ? gap : -gap), y: ey };
                } else {
                    // Hit horizontal edge → normal is vertical
                    edgeLocal = { x: ex, y: ey + (ly > 0 ? gap : -gap) };
                }
            }
            break;
        }
    }

    // Transform back to world space
    return localToWorld(el, edgeLocal);
}

// ─── Snap detection (shape-aware) ─────────────────────────────

/**
 * How far OUTSIDE a shape's perimeter the edge-snap detection activates (px, canvas space).
 * When the cursor is within this distance from the shape edge (but outside the shape),
 * edge (precise) binding is used.
 */
const EDGE_SNAP_THRESHOLD = 24;

/**
 * Width of the edge-binding band measured INWARD from the shape perimeter (px).
 * When the cursor is inside a shape but within this many pixels from the nearest edge,
 * edge (precise) binding is used — the arrow attaches to that specific edge point.
 * When the cursor is deeper inside (farther than this from any edge), center binding
 * activates — the arrow auto-routes through the shape center.
 *
 * This pixel-based threshold ensures consistent edge/center zones regardless of
 * shape size, unlike a ratio-based approach which makes small shapes nearly
 * impossible to get edge binding on.
 */
const EDGE_INNER_BAND = 20;

/**
 * Hysteresis margin (px) to prevent flickering at the edge/center boundary.
 * Once in center mode, cursor must move this many px CLOSER to the edge
 * (past the effectiveBand) before switching to edge mode, and vice versa.
 * This creates a "dead zone" around the boundary where the mode stays locked.
 */
const HYSTERESIS_MARGIN = 6;

/**
 * Distance from a point INSIDE a shape to its nearest edge (in pixels).
 * Returns 0 when the point is outside or exactly on the edge.
 *
 * Uses shape-specific metrics:
 * - Rectangle: min distance to any of the 4 edges
 * - Ellipse:   radial distance from point to ellipse perimeter
 * - Diamond:   radial distance from point to diamond perimeter
 */
function insideDistToEdge(el: CanvasElement, worldPt: Point): number {
    const local = worldToLocal(el, worldPt);
    const hw = el.width / 2 || 1;
    const hh = el.height / 2 || 1;

    switch (el.type) {
        case 'ellipse': {
            const nx = local.x / hw;
            const ny = local.y / hh;
            const nd = Math.sqrt(nx * nx + ny * ny);
            if (nd >= 1) return 0; // outside or on edge
            // Distance to ellipse perimeter along radial direction
            const angle = Math.atan2(local.y, local.x);
            const edgeX = hw * Math.cos(angle);
            const edgeY = hh * Math.sin(angle);
            return Math.hypot(edgeX - local.x, edgeY - local.y);
        }
        case 'diamond': {
            const d = Math.abs(local.x) / hw + Math.abs(local.y) / hh;
            if (d >= 1) return 0; // outside or on edge
            // Distance to diamond perimeter along radial direction
            const angle = Math.atan2(local.y, local.x);
            const absCos = Math.abs(Math.cos(angle));
            const absSin = Math.abs(Math.sin(angle));
            const t = 1 / (absCos / hw + absSin / hh);
            const edgeX = t * Math.cos(angle);
            const edgeY = t * Math.sin(angle);
            return Math.hypot(edgeX - local.x, edgeY - local.y);
        }
        default: {
            // Rectangle (and text, image): min distance to nearest edge
            const distLeft = hw + local.x;
            const distRight = hw - local.x;
            const distTop = hh + local.y;
            const distBottom = hh - local.y;
            const minDist = Math.min(distLeft, distRight, distTop, distBottom);
            return minDist > 0 ? minDist : 0;
        }
    }
}

/**
 * Distance from a point to a shape, accounting for shape type and rotation.
 * For rectangles: uses rotated bounding box distance.
 * For ellipses: uses elliptical distance.
 * For diamonds: uses diamond-edge distance.
 * Returns 0 when the point is inside the shape.
 */
function distToShape(pos: Point, el: CanvasElement): number {
    // Transform point into shape's local coordinate system
    const local = worldToLocal(el, pos);
    const hw = el.width / 2;
    const hh = el.height / 2;

    switch (el.type) {
        case 'ellipse': {
            // Elliptical distance: if point is inside ellipse, return 0
            const nx = local.x / hw;
            const ny = local.y / hh;
            const d = Math.sqrt(nx * nx + ny * ny);
            if (d <= 1) return 0;
            // Approximate distance to ellipse perimeter
            const angle = Math.atan2(local.y, local.x);
            const edgeX = hw * Math.cos(angle);
            const edgeY = hh * Math.sin(angle);
            return Math.hypot(local.x - edgeX, local.y - edgeY);
        }

        case 'diamond': {
            // Diamond: |x/hw| + |y/hh| <= 1
            const d = Math.abs(local.x) / hw + Math.abs(local.y) / hh;
            if (d <= 1) return 0;
            // Approximate distance to diamond edge
            const angle = Math.atan2(local.y, local.x);
            const absCos = Math.abs(Math.cos(angle));
            const absSin = Math.abs(Math.sin(angle));
            const t = 1 / (absCos / hw + absSin / hh);
            const edgeX = t * Math.cos(angle);
            const edgeY = t * Math.sin(angle);
            return Math.hypot(local.x - edgeX, local.y - edgeY);
        }

        default: {
            // Rectangular (rotated bbox distance in local space)
            const dx = Math.max(-hw - local.x, 0, local.x - hw);
            const dy = Math.max(-hh - local.y, 0, local.y - hh);
            return Math.hypot(dx, dy);
        }
    }
}

/**
 * Find the nearest connectable shape using **shape-aware** hit detection.
 * The shape perimeter (+ padding) acts as a drop zone.
 *
 * Uses two separate distance thresholds for edge vs center binding:
 *
 * 1. **Edge zone** — cursor is OUTSIDE the shape but within
 *    `edgeOuterThreshold` px of the perimeter, OR cursor is INSIDE
 *    the shape but within `EDGE_INNER_BAND` px of the nearest edge.
 *    → Produces precise (edge) binding at the exact cursor position.
 *
 * 2. **Center zone** — cursor is INSIDE the shape and farther than
 *    `EDGE_INNER_BAND` px from any edge.
 *    → Produces center binding (fixedPoint [0.5, 0.5]) for clean
 *      auto-routing.
 *
 * The pixel-based inner band ensures consistent edge/center zones
 * regardless of shape size.
 *
 * @param pos                Current pointer position (canvas coords)
 * @param elements           All elements on canvas
 * @param edgeOuterThreshold How far outside the shape perimeter to detect (px).
 *                           Defaults to `EDGE_SNAP_THRESHOLD`.
 * @param excludeIds         Element IDs to skip (e.g. the connector itself)
 * @param toward             Direction for edge-point calculation; defaults to `pos`
 * @param forcePrecise       Force precise mode (skip auto-detection).
 *                           Use `undefined` for auto-detection (recommended).
 * @param gap                Gap between connector endpoint and shape edge (px).
 *                           Defaults to BOUND_ARROW_OFFSET. Pass `computeBindingGap(strokeWidth)`
 *                           for a preview that matches the final binding gap.
 * @param prevIsPrecise      Previous snap's `isPrecise` value for hysteresis.
 *                           Pass `undefined` for first call (no hysteresis).
 *                           Pass the previous result's `isPrecise` during drag
 *                           to prevent edge/center mode flickering at boundary.
 */
export function findNearestSnapTarget(
    pos: Point,
    elements: CanvasElement[],
    edgeOuterThreshold = EDGE_SNAP_THRESHOLD,
    excludeIds: Set<string> = new Set(),
    toward?: Point,
    forcePrecise?: boolean,
    gap = BOUND_ARROW_OFFSET,
    prevIsPrecise?: boolean,
): SnapTarget | null {
    let best: SnapTarget | null = null;
    let bestDist = Infinity;

    for (const el of elements) {
        if (!isConnectable(el) || excludeIds.has(el.id)) continue;

        const d = distToShape(pos, el);
        // Outside the shape: only accept if within the outer edge threshold
        if (d > edgeOuterThreshold) continue;

        const isInside = d === 0;
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        const centerDist = Math.hypot(cx - pos.x, cy - pos.y);

        // Scoring: shapes where cursor is INSIDE get high priority (score < 0)
        // over shapes where cursor is outside (score >= 0).
        // This ensures that when you drop inside a shape, it always wins
        // over a nearby shape whose edge is also within threshold.
        //
        // Among inside candidates: prefer the one whose center is closest
        //   (the shape you are "most inside of").
        // Among outside candidates: prefer closest shape distance, then center.
        const score = isInside
            ? -1e6 + centerDist          // negative → always beats outside
            : d * 1000 + centerDist;     // positive → ranked by distance

        if (score < bestDist) {
            bestDist = score;

            // Auto-detect edge vs center zone based on cursor position.
            // Uses separate pixel-based thresholds for outside vs inside.
            let useEdge: boolean;
            if (forcePrecise !== undefined) {
                useEdge = forcePrecise;
            } else {
                const isInsideShape = d === 0;
                if (isInsideShape) {
                    // Inside the shape: use pixel distance to nearest edge.
                    // If within the effective edge band → edge binding.
                    // Deeper inside → center binding.
                    //
                    // Cap the band to at most 60% of the smallest half-dimension
                    // so that a center zone always exists, even for small shapes.
                    // Without this cap, shapes with min(width,height) <= 2 * EDGE_INNER_BAND
                    // would have NO center zone at all.
                    const minHalfDim = Math.min(el.width, el.height) / 2;
                    const effectiveBand = Math.min(EDGE_INNER_BAND, minHalfDim * 0.6);
                    const edgeDist = insideDistToEdge(el, pos);

                    // Apply hysteresis when previous mode is known.
                    // This creates a dead zone around the boundary to
                    // prevent flickering when cursor jitters near it.
                    if (prevIsPrecise === true) {
                        // Was edge (precise) → require moving deeper inside
                        // to switch to center: use a wider band
                        useEdge = edgeDist <= effectiveBand + HYSTERESIS_MARGIN;
                    } else if (prevIsPrecise === false) {
                        // Was center (imprecise) → require moving closer to
                        // edge to switch back: use a narrower band
                        useEdge = edgeDist <= Math.max(0, effectiveBand - HYSTERESIS_MARGIN);
                    } else {
                        // No previous state → use standard threshold
                        useEdge = edgeDist <= effectiveBand;
                    }
                } else {
                    // Outside shape → always edge binding
                    useEdge = true;
                }
            }

            let fp: [number, number];
            let edgePt: Point;
            if (useEdge) {
                // Edge zone: precise fixedPoint for exact attachment
                fp = computeFixedPoint(el, pos);
                edgePt = getEdgePointFromFixedPoint(el, fp, gap);
            } else {
                // Center zone: connect from center for auto-routing.
                // Compute edge point from CURSOR direction (not other-endpoint)
                // to ensure visual continuity at the edge/center boundary.
                // If cursor is too close to center, fall back to 'toward'
                // (the other endpoint) for a stable direction reference.
                // recomputeBoundPoints will re-orient properly after binding.
                fp = [0.5, 0.5];
                const local = worldToLocal(el, pos);
                const localMag = Math.abs(local.x) + Math.abs(local.y);
                if (localMag < 2) {
                    // Cursor ≈ center — direction unstable, use toward or default
                    edgePt = toward
                        ? getEdgePoint(el, toward, gap)
                        : getEdgePoint(el, { x: cx + el.width, y: cy }, gap);
                } else {
                    edgePt = getEdgePoint(el, pos, gap);
                }
            }

            best = { elementId: el.id, fixedPoint: fp, position: edgePt, isPrecise: useEdge };
        }
    }

    return best;
}

// ─── Binding utils ────────────────────────────────────────────

/** Check if a line/arrow element has any bindings */
export function hasBinding(el: LineElement | ArrowElement): boolean {
    return el.startBinding !== null || el.endBinding !== null;
}

/**
 * Recompute start/end points for a bound line/arrow based on current
 * positions of the connected shapes. Called when a shape is dragged.
 *
 * Supports N-point connectors: only the first and last point pairs are
 * adjusted to follow bindings; intermediate waypoints are preserved.
 *
 * Uses a two-pass approach for double-bound connectors to resolve the
 * edge-point interdependency:
 * 1. First pass: compute rough edge points using shape centers as direction.
 * 2. Second pass: refine using the result from pass 1 as direction.
 *
 * Also respects `isPrecise`: when false, uses center as anchor direction;
 * when true, uses the fixedPoint on the shape's bbox.
 *
 * Returns the updated `x`, `y`, `points` values to merge into the element.
 */
export function recomputeBoundPoints(
    connector: LineElement | ArrowElement,
    allElements: CanvasElement[],
): Partial<LineElement | ArrowElement> | null {
    const { startBinding, endBinding } = connector;
    if (!startBinding && !endBinding) return null;

    const elementMap = new Map(allElements.map(el => [el.id, el]));
    const pts = connector.points;
    const pointCount = pts.length / 2;

    // World-space start & end (initial)
    let startPt: Point = {
        x: connector.x + pts[0],
        y: connector.y + pts[1],
    };
    let endPt: Point = {
        x: connector.x + pts[pts.length - 2],
        y: connector.y + pts[pts.length - 1],
    };

    const startEl = startBinding ? elementMap.get(startBinding.elementId) : undefined;
    const endEl = endBinding ? elementMap.get(endBinding.elementId) : undefined;

    // Helper: get anchor point for a binding (respecting isPrecise)
    const getAnchorDir = (binding: Binding, el: CanvasElement): Point => {
        if (binding.isPrecise) {
            // Use the fixedPoint position as direction anchor
            return getEdgePointFromFixedPoint(el, binding.fixedPoint, 0);
        }
        // Default (imprecise): use shape center
        return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    };

    // Helper: for elbow connectors with center (imprecise) bindings,
    // compute the edge point on the ELBOW-PREFERRED face rather than
    // the geometrically-nearest face. This ensures the edge point and
    // the elbow routing direction are consistent.
    //
    // For vertical-preferred directions (diagonal configs), this places
    // the connection point on the top/bottom face center instead of
    // side faces — producing routing that goes ABOVE/BELOW shapes.
    const isElbow = connector.lineType === 'elbow';

    const getElbowFaceEdgePoint = (
        el: CanvasElement,
        toward: Point,
        gap: number,
    ): Point => {
        const prefDir: Direction = getElbowPreferredDirection(el, toward);
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        // Place target far along the preferred direction so getEdgePoint
        // picks the correct face (center of that face).
        const far = Math.max(el.width, el.height) * 10;
        let target: Point;
        switch (prefDir) {
            case 'up':    target = { x: cx, y: cy - far }; break;
            case 'down':  target = { x: cx, y: cy + far }; break;
            case 'left':  target = { x: cx - far, y: cy }; break;
            case 'right': target = { x: cx + far, y: cy }; break;
        }
        return getEdgePoint(el, target, gap);
    };

    // Select the appropriate edge-point function for non-precise bindings:
    // - Elbow connectors use getElbowFaceEdgePoint (prefers vertical exits)
    // - Other connectors use getEdgePoint (geometrically nearest face)
    const getCenterEdgePoint = isElbow
        ? (el: CanvasElement, _toward: Point, gap: number): Point =>
            getElbowFaceEdgePoint(el, _toward, gap)
        : getEdgePoint;

    // Two-pass computation for better accuracy when both ends are bound
    if (startBinding && startEl && endBinding && endEl) {
        // For isPrecise bindings, the edge point is determined by the
        // fixedPoint — the exact spot the user chose when dragging the
        // endpoint.  Non-precise bindings use center-toward-other-end
        // direction for automatic edge selection.
        // For elbow connectors, non-precise bindings use the ELBOW-preferred
        // direction (getCenterEdgePoint) to ensure the edge point is on the
        // face that produces optimal elbow routing.
        if (startBinding.isPrecise) {
            startPt = getEdgePointFromFixedPoint(startEl, startBinding.fixedPoint, startBinding.gap);
        } else {
            const endAnchor = getAnchorDir(endBinding, endEl);
            startPt = getCenterEdgePoint(startEl, endAnchor, startBinding.gap);
        }
        if (endBinding.isPrecise) {
            endPt = getEdgePointFromFixedPoint(endEl, endBinding.fixedPoint, endBinding.gap);
        } else {
            const startAnchor = getAnchorDir(startBinding, startEl);
            endPt = getCenterEdgePoint(endEl, startAnchor, endBinding.gap);
        }

        // Pass 2: Refine only non-precise bindings using pass-1 results
        if (!startBinding.isPrecise) {
            startPt = getCenterEdgePoint(startEl, endPt, startBinding.gap);
        }
        if (!endBinding.isPrecise) {
            endPt = getCenterEdgePoint(endEl, startPt, endBinding.gap);
        }
    } else {
        // One-sided binding
        if (startBinding && startEl) {
            if (startBinding.isPrecise) {
                startPt = getEdgePointFromFixedPoint(startEl, startBinding.fixedPoint, startBinding.gap);
            } else {
                startPt = getCenterEdgePoint(startEl, endPt, startBinding.gap);
            }
        }
        if (endBinding && endEl) {
            if (endBinding.isPrecise) {
                endPt = getEdgePointFromFixedPoint(endEl, endBinding.fixedPoint, endBinding.gap);
            } else {
                endPt = getCenterEdgePoint(endEl, startPt, endBinding.gap);
            }
        }
    }

    // Build new points array preserving intermediate waypoints
    // Origin = startPt, all points relative to it
    const newPoints: number[] = [0, 0];

    // Intermediate waypoints (indices 1 .. pointCount-2) keep their world positions
    for (let i = 1; i < pointCount - 1; i++) {
        const worldX = connector.x + pts[i * 2];
        const worldY = connector.y + pts[i * 2 + 1];
        newPoints.push(worldX - startPt.x, worldY - startPt.y);
    }

    // End point
    newPoints.push(endPt.x - startPt.x, endPt.y - startPt.y);

    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;

    return {
        x: startPt.x,
        y: startPt.y,
        points: newPoints,
        width: Math.abs(dx),
        height: Math.abs(dy),
    };
}

/**
 * Find all connector (line/arrow) elements that reference `elementId`
 * in their startBinding or endBinding.
 */
export function findConnectorsForElement(
    elementId: string,
    elements: CanvasElement[],
): (LineElement | ArrowElement)[] {
    return elements.filter((el): el is LineElement | ArrowElement => {
        if (el.type !== 'line' && el.type !== 'arrow') return false;
        const c = el as LineElement | ArrowElement;
        return (
            c.startBinding?.elementId === elementId ||
            c.endBinding?.elementId === elementId
        );
    });
}

/**
 * Clear any binding that references a deleted element.
 * Also clears boundElements references on remaining shapes.
 * Returns updated elements array (only changed elements are cloned).
 */
export function clearBindingsForDeletedElements(
    deletedIds: Set<string>,
    elements: CanvasElement[],
): CanvasElement[] {
    return elements.map((el) => {
        let changed = false;

        // Clear boundElements that reference deleted elements
        if (el.boundElements && el.boundElements.length > 0) {
            const filtered = el.boundElements.filter((be) => !deletedIds.has(be.id));
            if (filtered.length !== el.boundElements.length) {
                el = { ...el, boundElements: filtered.length > 0 ? filtered : null } as CanvasElement;
                changed = true;
            }
        }

        // Clear bindings on connectors
        if (el.type !== 'line' && el.type !== 'arrow') return el;
        const c = el as LineElement | ArrowElement;
        let startBinding = c.startBinding;
        let endBinding = c.endBinding;

        if (startBinding && deletedIds.has(startBinding.elementId)) {
            startBinding = null;
            changed = true;
        }
        if (endBinding && deletedIds.has(endBinding.elementId)) {
            endBinding = null;
            changed = true;
        }

        return changed ? { ...el, startBinding, endBinding } as CanvasElement : el;
    });
}

// ─── BoundElements management ─────────────────────────────────

/**
 * Add a bound-element reference to a shape's boundElements array.
 * Returns the updated shape — does NOT mutate in place.
 */
export function addBoundElement(
    shape: CanvasElement,
    ref: BoundElement,
): CanvasElement {
    const existing = shape.boundElements ?? [];
    // Prevent duplicates
    if (existing.some((be) => be.id === ref.id)) return shape;
    return { ...shape, boundElements: [...existing, ref] } as CanvasElement;
}

/**
 * Remove a bound-element reference from a shape's boundElements array.
 * Returns the updated shape — does NOT mutate in place.
 */
export function removeBoundElement(
    shape: CanvasElement,
    refId: string,
): CanvasElement {
    const existing = shape.boundElements;
    if (!existing || existing.length === 0) return shape;
    const filtered = existing.filter((be) => be.id !== refId);
    return {
        ...shape,
        boundElements: filtered.length > 0 ? filtered : null,
    } as CanvasElement;
}

/**
 * Synchronize bidirectional boundElements when a connector's bindings change.
 * Call this after updating a connector's startBinding / endBinding.
 *
 * @param connectorId  The connector (arrow/line) id
 * @param connectorType  'arrow' | 'line'
 * @param oldBinding   Previous binding (or null)
 * @param newBinding   New binding (or null)
 * @param updateElement Callback to persist the shape update
 */
export function syncBoundElements(
    connectorId: string,
    connectorType: 'arrow' | 'line',
    oldBinding: Binding | null,
    newBinding: Binding | null,
    elements: CanvasElement[],
    updateElement: (id: string, updates: Partial<CanvasElement>) => void,
): void {
    // Remove from old target
    if (oldBinding && oldBinding.elementId !== newBinding?.elementId) {
        const oldShape = elements.find((e) => e.id === oldBinding.elementId);
        if (oldShape) {
            const updated = removeBoundElement(oldShape, connectorId);
            if (updated !== oldShape) {
                updateElement(oldShape.id, { boundElements: updated.boundElements });
            }
        }
    }

    // Add to new target
    if (newBinding && newBinding.elementId !== oldBinding?.elementId) {
        const newShape = elements.find((e) => e.id === newBinding.elementId);
        if (newShape) {
            const updated = addBoundElement(newShape, { id: connectorId, type: connectorType });
            if (updated !== newShape) {
                updateElement(newShape.id, { boundElements: updated.boundElements });
            }
        }
    }
}

// ─── Connector Label Position ─────────────────────────────────
/**
 * Compute the midpoint position for a text label on a connector (arrow/line).
 * Uses the connector's current points and lineType (sharp/curved/elbow)
 * to find the visual midpoint, then centers the label around it.
 *
 * @param connector - The connector element (ArrowElement | LineElement)
 * @param textWidth  - Current label text width (px)
 * @param textHeight - Current label text height (px)
 * @returns `{ x, y }` in world coordinates for the text element.
 */
export function computeConnectorLabelPosition(
    connector: LineElement | ArrowElement,
    textWidth: number,
    textHeight: number,
): { x: number; y: number } {
    const pts = connector.points;
    const startPt: Point = { x: pts[0], y: pts[1] };
    const endPt: Point = { x: pts[pts.length - 2], y: pts[pts.length - 1] };

    let midX: number;
    let midY: number;

    if (connector.lineType === 'curved') {
        const curvature = (connector as ArrowElement).curvature ?? CURVE_RATIO;
        const cp = computeCurveControlPoint(startPt, endPt, curvature);
        const mid = quadBezierAt(startPt, cp, endPt, 0.5);
        midX = connector.x + mid.x;
        midY = connector.y + mid.y;
    } else if (connector.lineType === 'elbow' && pts.length >= 4) {
        // Elbow: use geometric midpoint of the full polyline path
        // Walk segments and find the point at half the total length.
        const segCount = pts.length / 2 - 1;
        let totalLen = 0;
        for (let i = 0; i < segCount; i++) {
            const dx = pts[(i + 1) * 2] - pts[i * 2];
            const dy = pts[(i + 1) * 2 + 1] - pts[i * 2 + 1];
            totalLen += Math.sqrt(dx * dx + dy * dy);
        }
        const half = totalLen / 2;
        let walked = 0;
        midX = connector.x + (startPt.x + endPt.x) / 2; // fallback
        midY = connector.y + (startPt.y + endPt.y) / 2;
        for (let i = 0; i < segCount; i++) {
            const ax = pts[i * 2], ay = pts[i * 2 + 1];
            const bx = pts[(i + 1) * 2], by = pts[(i + 1) * 2 + 1];
            const dx = bx - ax, dy = by - ay;
            const segLen = Math.sqrt(dx * dx + dy * dy);
            if (walked + segLen >= half && segLen > 0) {
                const t = (half - walked) / segLen;
                midX = connector.x + ax + dx * t;
                midY = connector.y + ay + dy * t;
                break;
            }
            walked += segLen;
        }
    } else {
        // Sharp (straight segments): simple midpoint of start-end
        midX = connector.x + (startPt.x + endPt.x) / 2;
        midY = connector.y + (startPt.y + endPt.y) / 2;
    }

    return {
        x: midX - textWidth / 2,
        y: midY - textHeight / 2,
    };
}

/**
 * Sync bound text labels for a list of connector elements.
 * Returns an array of text element updates to batch-apply.
 *
 * @param connectorIds - IDs of connectors whose labels need syncing
 * @param elMap        - O(1) element lookup map
 */
export function syncConnectorLabels(
    connectorIds: Iterable<string>,
    elMap: Map<string, CanvasElement>,
): Array<{ id: string; updates: Partial<TextElement> }> {
    const updates: Array<{ id: string; updates: Partial<TextElement> }> = [];

    for (const connId of connectorIds) {
        const conn = elMap.get(connId);
        if (!conn || (conn.type !== 'arrow' && conn.type !== 'line')) continue;
        if (!conn.boundElements) continue;

        const connector = conn as LineElement | ArrowElement;
        for (const be of conn.boundElements) {
            if (be.type !== 'text') continue;
            const txt = elMap.get(be.id) as TextElement | undefined;
            if (!txt) continue;

            const textW = Math.max(10, txt.width || 60);
            const textH = txt.height || 30;
            const pos = computeConnectorLabelPosition(connector, textW, textH);
            updates.push({ id: txt.id, updates: { x: pos.x, y: pos.y } });
        }
    }

    return updates;
}
