/**
 * Lightweight hand-drawn / rough rendering utilities for Konva shapes.
 *
 * Produces a hand-drawn appearance via configurable "Sloppiness"
 * setting and rough.js — bézier curves with jittered control points and
 * angle-aware corner rounding.
 *
 * Sloppiness presets:
 *   0 — Architect  (clean, precise lines — no rough effect)
 *   1 — Artist     (subtle hand-drawn feel, single stroke pass)
 *   2 — Cartoonist (heavy wobble, double stroke pass)
 *
 * Key improvements over v1:
 *   • xorshift seeded PRNG returning [-1,1] with direct string seed
 *   • strokeWidth-proportional offset/roundness for consistent look
 *   • Angle-aware corner rounding via quadratic bézier (reduces at obtuse angles)
 *   • Segment-length clamping to prevent visual artifacts on short edges
 *   • Per-pass seeding for more organic overlapping strokes
 *   • Cubic bézier ellipse arcs for smoother curves
 */

// ─── Seeded PRNG (xorshift) ──────────────────────────────────

/**
 * Simple hash to convert any string (element ID) to a numeric seed.
 * Uses FNV-1a–style hash.
 */
export function hashString(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
}

/**
 * Seeded PRNG using xorshift algorithm.
 * Accepts a string seed directly and returns values in [-1, 1].
 *
 * Based on a standard xorshift PRNG implementation.
 */
export function createRNG(seed: string | number): () => number {
    const seedStr = typeof seed === 'number' ? String(seed) : seed;
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;

    function next() {
        const t = x ^ (x << 11);
        x = y;
        y = z;
        z = w;
        w ^= ((w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
        return (w / 0x100000000) * 2;
    }

    // Warm up the generator with the seed
    for (let k = 0; k < seedStr.length + 64; k++) {
        x ^= seedStr.charCodeAt(k) | 0;
        next();
    }

    return next;
}

// ─── Rough rendering context type ─────────────────────────────

/**
 * Minimal subset of Canvas 2D / Konva.Context used by rough helpers.
 * Both `CanvasRenderingContext2D` and Konva's `Context` satisfy this.
 */
export interface RoughCtx {
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    bezierCurveTo(
        cp1x: number,
        cp1y: number,
        cp2x: number,
        cp2y: number,
        x: number,
        y: number,
    ): void;
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
    closePath(): void;
}

// ─── Roughness parameters (strokeWidth-proportional) ──────────

/**
 * Compute the random displacement offset for rough rendering.
 *
 * Modeled after rough.js behaviour:
 *   - Architect (0): 0 — no displacement at all
 *   - Artist    (1): moderate hand-drawn wobble (visible but clean)
 *   - Cartoonist(2): heavy sketch style
 *
 * The offset is a minimum-floor + strokeWidth-proportional component
 * so that thin strokes still show a noticeable effect.
 */
function computeOffset(roughness: number, strokeWidth: number): number {
    if (roughness === 0) return 0;
    // Visible wobble but not enough to deform corners/shape
    const minOffset = roughness === 1 ? 0.8 : 1.5;
    const swComponent = strokeWidth * (roughness === 1 ? 0.4 : 0.8);
    return Math.max(minOffset, swComponent);
}

/**
 * Compute the corner roundness for rough polygons.
 *
 * Larger values produce more rounded, organic-looking corners.
 *   - Artist: subtle corner softening
 *   - Cartoonist: very rounded, sketch-like corners
 */
function computeRoundness(roughness: number, strokeWidth: number): number {
    if (roughness === 0) return 0;
    const base = roughness === 1 ? 1.2 : 2.0;
    return Math.max(strokeWidth * base, roughness === 1 ? 1.5 : 3);
}

// ─── Math helpers ─────────────────────────────────────────────

/** Euclidean distance between two points. */
function dist(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate angle between two vectors (0 to π).
 * Returns 0 when vectors are parallel; π when anti-parallel.
 */
function angleBetween(
    ax: number, ay: number,
    bx: number, by: number,
): number {
    const dot = ax * bx + ay * by;
    const magA = Math.sqrt(ax * ax + ay * ay);
    const magB = Math.sqrt(bx * bx + by * by);
    if (magA < 1e-6 || magB < 1e-6) return 0;
    return Math.acos(Math.max(-1, Math.min(1, dot / (magA * magB))));
}

// ─── Core line drawing ────────────────────────────────────────

/**
 * Draw a single rough line segment from (x1,y1) to (x2,y2).
 *
 * Uses a cubic bézier with jittered control points placed at ~1/3 and ~2/3
 * along the line, displaced perpendicular to the line direction.
 *
 * Offset is now proportional to strokeWidth for consistent appearance.
 *
 * @param move  If true, issues a `moveTo` at the start; if false,
 *              continues from the current path position.
 */
function roughLineSegment(
    ctx: RoughCtx,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    offset: number,
    rng: () => number,
    move: boolean = true,
): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < 0.5) {
        if (move) ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        return;
    }

    // Perpendicular unit vector
    const px = -dy / len;
    const py = dx / len;

    // Clamp offset to a fraction of segment length (prevent artifacts on short segments)
    const clampedOff = Math.min(offset, len * 0.25);

    // Endpoint displacement: very small so corners keep their shape
    const endJitter = clampedOff * 0.15;
    const sx = x1 + rng() * endJitter;
    const sy = y1 + rng() * endJitter;
    const ex = x2 + rng() * endJitter;
    const ey = y2 + rng() * endJitter;

    // Two control points with perpendicular offset (rng returns [-1,1])
    // Mid-segment wobble is the main visual effect
    const cp1x = sx + dx * 0.33 + px * rng() * clampedOff;
    const cp1y = sy + dy * 0.33 + py * rng() * clampedOff;
    const cp2x = sx + dx * 0.67 + px * rng() * clampedOff;
    const cp2y = sy + dy * 0.67 + py * rng() * clampedOff;

    if (move) ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
}

// ─── Polygon (closed shape) helpers ───────────────────────────

/**
 * Draw rough polygon with angle-aware corner rounding.
 *
 * Each corner is rendered as a quadratic bézier curve:
 * - Each corner is rendered as a quadratic bézier curve
 * - Roundness reduces to 0 as the angle approaches 180° (straight through)
 * - Offset is clamped per-segment to prevent overlap on short edges
 *
 * @param ctx        Canvas/Konva context
 * @param vertices   Polygon vertices
 * @param offset     Random displacement amount (strokeWidth-proportional)
 * @param roundness  Corner rounding amount (strokeWidth-proportional)
 * @param rng        Seeded PRNG returning [-1, 1]
 */
function roughPolygonWithCorners(
    ctx: RoughCtx,
    vertices: [number, number][],
    offset: number,
    roundness: number,
    rng: () => number,
): void {
    const n = vertices.length;
    if (n < 3) return;

    // Precompute edge vectors and lengths
    const edgeLens: number[] = [];
    for (let i = 0; i < n; i++) {
        const [ax, ay] = vertices[i];
        const [bx, by] = vertices[(i + 1) % n];
        edgeLens.push(dist(ax, ay, bx, by));
    }

    // Build corners with angle-aware rounding
    for (let i = 0; i < n; i++) {
        const prev = vertices[(i - 1 + n) % n];
        const curr = vertices[i];
        const next = vertices[(i + 1) % n];

        const prevLen = edgeLens[(i - 1 + n) % n]; // edge from prev→curr
        const nextLen = edgeLens[i];                // edge from curr→next

        // Tangent vectors (prev→curr and curr→next)
        const prevDx = curr[0] - prev[0];
        const prevDy = curr[1] - prev[1];
        const nextDx = next[0] - curr[0];
        const nextDy = next[1] - curr[1];

        // Angle between incoming and outgoing edges
        const angle = angleBetween(-prevDx, -prevDy, nextDx, nextDy);

        // Roundness reduces as angle approaches π (straight line — no corner)
        const angleRatio = 1 - angle / Math.PI;
        let r = roundness * angleRatio;

        // Clamp roundness to half the shortest adjacent edge
        const shortestEdge = Math.min(prevLen, nextLen);
        r = Math.min(r, shortestEdge * 0.4);
        r = Math.max(r, 0);

        // Points where the corner curve begins and ends
        // (pulled back from the vertex along each edge)
        const pullbackPrev = prevLen > 1e-6 ? r / prevLen : 0;
        const pullbackNext = nextLen > 1e-6 ? r / nextLen : 0;

        const cornerStartX = curr[0] - prevDx * pullbackPrev;
        const cornerStartY = curr[1] - prevDy * pullbackPrev;
        const cornerEndX = curr[0] + nextDx * pullbackNext;
        const cornerEndY = curr[1] + nextDy * pullbackNext;

        // Apply random offset to each point (perpendicular to edge + rng)
        const offCSx = cornerStartX + rng() * offset;
        const offCSy = cornerStartY + rng() * offset;
        const offCEx = cornerEndX + rng() * offset;
        const offCEy = cornerEndY + rng() * offset;

        // The corner control point is the original vertex, jittered
        const cpX = curr[0] + rng() * offset;
        const cpY = curr[1] + rng() * offset;

        if (i === 0) {
            ctx.moveTo(offCSx, offCSy);
        } else {
            // Line from previous corner's end to this corner's start
            ctx.lineTo(offCSx, offCSy);
        }

        // Quadratic bézier through the corner
        if (r > 0.5) {
            ctx.quadraticCurveTo(cpX, cpY, offCEx, offCEy);
        } else {
            ctx.lineTo(offCEx, offCEy);
        }
    }

    // Close back to start
    ctx.closePath();
}

/**
 * Draw rough line segments forming a closed polygon (simple mode).
 * Each edge is drawn as a separate sub-path (with moveTo), which mimics
 * the rough.js style where each edge is an independent stroke.
 */
function roughPolygonStrokes(
    ctx: RoughCtx,
    vertices: [number, number][],
    offset: number,
    rng: () => number,
): void {
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
        const [ax, ay] = vertices[i];
        const [bx, by] = vertices[(i + 1) % n];
        roughLineSegment(ctx, ax, ay, bx, by, offset, rng, true);
    }
}

// ─── Public shape renderers ───────────────────────────────────

/**
 * Number of stroke passes for a given roughness level.
 *   - Architect (0): 1 pass (clean)
 *   - Artist    (1): 1 pass (single hand-drawn stroke)
 *   - Cartoonist(2): 2 passes (overlapping sketchy strokes)
 */
export function getRoughPasses(roughness: number): number {
    return roughness >= 2 ? 2 : 1;
}

/**
 * Draw a rough rectangle stroke (no fill).
 *
 * Uses angle-aware corner rounding for a natural hand-drawn look.
 * Offset and roundness scale proportionally with strokeWidth.
 */
export function drawRoughRectStrokes(
    ctx: RoughCtx,
    x: number,
    y: number,
    w: number,
    h: number,
    roughness: number,
    rng: () => number,
    passes: number = 1,
    strokeWidth: number = 2,
): void {
    const offset = computeOffset(roughness, strokeWidth);
    const roundness = computeRoundness(roughness, strokeWidth);

    const verts: [number, number][] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
    ];
    for (let p = 0; p < passes; p++) {
        ctx.beginPath();
        roughPolygonWithCorners(ctx, verts, offset, roundness, rng);
    }
}

/**
 * Draw a rough ellipse stroke path using cubic bézier arcs.
 *
 * Uses 4 cubic bézier curves (one per quadrant) with radial jitter,
 * producing smoother, more natural curves than the v1 quadratic approach.
 *
 * Builds the path into the context; caller is responsible for `ctx.strokeShape()`.
 */
export function drawRoughEllipseStrokes(
    ctx: RoughCtx,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    roughness: number,
    rng: () => number,
    passes: number = 1,
    strokeWidth: number = 2,
): void {
    const offset = computeOffset(roughness, strokeWidth);

    // Number of sample points — adaptive to ellipse size for quality
    const perimeter = Math.PI * 2 * Math.sqrt((rx * rx + ry * ry) / 2);
    const numPts = Math.max(16, Math.min(64, Math.floor(perimeter * 0.08)));
    const step = (Math.PI * 2) / numPts;

    // κ (kappa) for cubic bézier circle approximation
    // For a full circle: κ ≈ 0.5522847498. For sub-arcs, scale by angular span.
    const kappa = (4 / 3) * Math.tan(step / 4);

    for (let p = 0; p < passes; p++) {
        // Generate jittered points on the ellipse perimeter
        const pts: { x: number; y: number; angle: number }[] = [];
        for (let i = 0; i <= numPts; i++) {
            const angle = i * step;
            const radialOff = rng() * offset * 1.8;
            pts.push({
                x: cx + (rx + radialOff) * Math.cos(angle),
                y: cy + (ry + radialOff) * Math.sin(angle),
                angle,
            });
        }

        // Draw cubic bézier curves between consecutive points
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < numPts; i++) {
            const p0 = pts[i];
            const p1 = pts[i + 1];

            // Tangent direction at each point (perpendicular to radial)
            const cos0 = Math.cos(p0.angle);
            const sin0 = Math.sin(p0.angle);
            const cos1 = Math.cos(p1.angle);
            const sin1 = Math.sin(p1.angle);

            // Tangent vectors (rotated 90° from radial) scaled by kappa
            const tx0 = -sin0;
            const ty0 = cos0;
            const tx1 = -sin1;
            const ty1 = cos1;

            const r0 = rx + rng() * offset;
            const r1 = ry + rng() * offset;

            // Cubic control points with jitter proportional to roughness
            const cp1x = p0.x + tx0 * rx * kappa + rng() * offset * 0.8;
            const cp1y = p0.y + ty0 * ry * kappa + rng() * offset * 0.8;
            const cp2x = p1.x - tx1 * rx * kappa + rng() * offset * 0.8;
            const cp2y = p1.y - ty1 * ry * kappa + rng() * offset * 0.8;

            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p1.x, p1.y);
        }
    }
}

/**
 * Draw a rough diamond (rhombus) stroke with corner rounding.
 */
export function drawRoughDiamondStrokes(
    ctx: RoughCtx,
    w: number,
    h: number,
    roughness: number,
    rng: () => number,
    passes: number = 1,
    strokeWidth: number = 2,
): void {
    const offset = computeOffset(roughness, strokeWidth);
    const roundness = computeRoundness(roughness, strokeWidth);

    const verts: [number, number][] = [
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
    ];
    for (let p = 0; p < passes; p++) {
        ctx.beginPath();
        roughPolygonWithCorners(ctx, verts, offset, roundness, rng);
    }
}

/**
 * Generate rough polyline points for Line/Arrow shapes.
 *
 * Returns a new flat array `[x0, y0, x1, y1, …]` with intermediate points
 * jittered. First and last points are kept untouched (they may be bound).
 */
export function roughPolylinePoints(
    points: number[],
    roughness: number,
    rng: () => number,
    strokeWidth: number = 2,
): number[] {
    if (roughness === 0 || points.length <= 4) return points;

    const offset = computeOffset(roughness, strokeWidth);
    const result: number[] = [];

    for (let i = 0; i < points.length; i += 2) {
        const x = points[i];
        const y = points[i + 1];
        // Keep start & end anchors untouched
        if (i === 0 || i >= points.length - 2) {
            result.push(x, y);
        } else {
            result.push(
                x + rng() * offset * 1.8,
                y + rng() * offset * 1.8,
            );
        }
    }
    return result;
}

/**
 * Draw a rough straight-line segment for Line/Arrow shapes.
 *
 * Instead of connecting points with a plain `<Line>`, this draws each segment
 * as a rough bézier, giving a hand-drawn look.
 *
 * @param ctx     Konva / Canvas 2D context
 * @param points  Flat point array `[x0, y0, x1, y1, …]`
 */
export function drawRoughPolyline(
    ctx: RoughCtx,
    points: number[],
    roughness: number,
    rng: () => number,
    passes: number = 1,
    strokeWidth: number = 2,
): void {
    if (points.length < 4) return;

    const offset = computeOffset(roughness, strokeWidth);

    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < points.length - 2; i += 2) {
            roughLineSegment(
                ctx,
                points[i],
                points[i + 1],
                points[i + 2],
                points[i + 3],
                offset,
                rng,
                true,
            );
        }
    }
}

/**
 * Draw a rough curved (quadratic bézier) line between two points with a
 * control point. Adds wobble to the curve path.
 *
 * Offset scales with strokeWidth for consistent appearance.
 */
export function drawRoughCurve(
    ctx: RoughCtx,
    start: { x: number; y: number },
    cp: { x: number; y: number },
    end: { x: number; y: number },
    roughness: number,
    rng: () => number,
    passes: number = 1,
    strokeWidth: number = 2,
): void {
    const offset = computeOffset(roughness, strokeWidth);
    const jitter = offset * 2;

    for (let p = 0; p < passes; p++) {
        const sx = start.x + rng() * offset * 0.6;
        const sy = start.y + rng() * offset * 0.6;
        const ex = end.x + rng() * offset * 0.6;
        const ey = end.y + rng() * offset * 0.6;
        const cpx = cp.x + rng() * jitter;
        const cpy = cp.y + rng() * jitter;

        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(cpx, cpy, ex, ey);
    }
}
