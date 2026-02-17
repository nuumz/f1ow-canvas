/**
 * elbow.ts — Non-uniform grid A* orthogonal connector routing
 *
 * Uses a direction-aware A* search on a non-uniform grid to find optimal
 * orthogonal routes between two connection points while avoiding shape
 * bounding boxes. The algorithm:
 *
 * 1. Inflates shape bounding boxes by a clearance margin
 * 2. Creates rulers from shape edges (±padding), shape centers,
 *    connection points, antenna points, and midlines between shapes
 * 3. Generates a non-uniform grid of waypoints at ruler intersections
 *    (Cartesian product of vertical × horizontal rulers)
 * 4. Filters out waypoints inside inflated shape bounding boxes
 * 5. Builds a graph connecting each node to its nearest existing
 *    neighbor in each cardinal direction (with obstacle checks)
 * 6. Runs direction-aware A* search with:
 *    - States: (point, incoming_direction) — 4 states per grid point
 *    - g(n): manhattan distance + BEND_PENALTY × bends (bend-count-primary)
 *    - h(n): manhattan distance to destination (admissible heuristic)
 *    - U-turn prevention via heavy backward-movement penalty
 *    - Binary min-heap for O(log n) open-set operations
 * 7. Tries multiple obstacle inflation configs (standard + relaxed),
 *    picks the route with fewest bends / shortest length
 * 8. Simplifies the result by removing collinear intermediate points
 *
 * The output is a flat `number[]` array compatible with the existing
 * `points` field on `ArrowElement` and `LineElement`, where coordinates
 * are **relative to the element origin** (the start point).
 *
 * Based on the elbow arrow routing algorithm described by Márk Tolmács (2025):
 * https://plus.excalidraw.com/blog/building-elbow-arrows-part-two
 *
 * And the orthogonal connector routing approach by jose-mdz:
 * https://medium.com/swlh/routing-orthogonal-diagram-connectors-in-javascript-191dc2c5ff70
 */
import type { Point, Binding, CanvasElement } from '@/types';

// ─── Types ────────────────────────────────────────────────────

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Internal rect using left/top/width/height (grid algorithm convention) */
interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Shape bounding box using x/y/width/height (canvas element convention) */
interface BBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

// ─── Constants ────────────────────────────────────────────────

/**
 * Clearance around shapes for obstacle inflation (px).
 * Determines how much space the router keeps between the path
 * and shape bounding boxes. Kept small to allow routing in
 * tight configurations.
 */
const SHAPE_MARGIN = 20;

/**
 * Minimum inflation on the EXIT face of a shape (px).
 *
 * The exit face is the face where the connector stub exits the shape.
 * We keep a REDUCED (but non-zero) inflation on this face to prevent
 * the A* router from placing the horizontal/vertical routing segment
 * right along the shape's edge — which looks visually wrong.
 *
 * If set to 0 (old behavior), grid spots exist AT the shape's exit
 * edge, allowing routes to run along the shape surface.
 *
 * Value should be smaller than SHAPE_MARGIN to keep tight spaces
 * passable, but large enough to provide visual clearance on the
 * exit face. The antenna stub (MIN_STUB_LENGTH) must be > this
 * value so the antenna point lands outside the inflated area.
 */
const EXIT_FACE_MARGIN = 25;

/**
 * Minimum length of the stub (antenna) segment at each end (px).
 * This is the segment between the shape edge and the first/last
 * waypoint. Must be long enough for:
 * - Arrowheads to render fully without overflowing into the bend
 * - The final segment to be visually distinct (not just a dot)
 * - Sufficient visual clearance from the shape (pushes horizontal
 *   routing segments away from shapes)
 *
 * Separate from SHAPE_MARGIN because obstacle inflation and
 * antenna length serve different purposes:
 * - SHAPE_MARGIN: how far to keep the route FROM shapes (small = flexible routing)
 * - MIN_STUB_LENGTH: how long the end-segments must be (large = clean arrowheads)
 *
 * Must be > EXIT_FACE_MARGIN so the antenna point is outside the
 * partially-inflated exit face.
 */
const MIN_STUB_LENGTH = 36;

/** Margin beyond the union of shapes to provide routing space (px) */
const BOUNDS_MARGIN = 40;

/**
 * Fixed cost per direction change (bend) in the A* search.
 *
 * This is the key parameter for route aesthetics. The value
 * should be large enough to discourage unnecessary bends,
 * but not so large that the algorithm takes huge detours
 * to avoid a single turn.
 *
 * Unlike the old quadratic penalty `(weight+1)²` which scaled
 * with segment length (making long-segment turns prohibitively
 * expensive and short-segment turns nearly free), a fixed
 * penalty treats all bends equally — producing consistently
 * clean paths.
 */
const BEND_PENALTY = 10_000;

// ─── Direction helpers ────────────────────────────────────────

/** Direction unit vector */
function dirVec(dir: Direction): Point {
    switch (dir) {
        case 'up':    return { x: 0, y: -1 };
        case 'down':  return { x: 0, y: 1 };
        case 'left':  return { x: -1, y: 0 };
        case 'right': return { x: 1, y: 0 };
    }
}

/** Whether direction is along the vertical axis (up/down) */
function isVerticalDir(dir: Direction): boolean {
    return dir === 'up' || dir === 'down';
}

// ─── Direction detection (public API) ─────────────────────────

/**
 * Determine the preferred exit direction for elbow routing from a
 * center (imprecise) binding.
 *
 * Unlike `directionFromShapeToPoint` which picks the face that
 * geometrically faces the target (optimal for straight lines), this
 * function prefers VERTICAL exits (up/down) for diagonal configurations.
 *
 * Rationale: For orthogonal/elbow routing, vertical exits produce
 * clean C-shaped or S-shaped paths that route ABOVE or BELOW shapes.
 * Horizontal exits (from side faces) create paths that run BETWEEN
 * shapes at their vertical center — visually too close to objects and
 * often requiring more bends.
 *
 * Only uses horizontal exits when the target is strongly horizontally
 * aligned (>3× horizontal dominance after normalizing by shape size).
 *
 * This function should be used by BOTH:
 * - The binding system (connection.ts) to compute edge points for
 *   elbow connectors with center bindings
 * - The routing system (computeElbowPoints) to determine exit direction
 *
 * For PRECISE bindings, always use directionFromFixedPoint instead.
 */
export function getElbowPreferredDirection(
    shape: { x: number; y: number; width: number; height: number },
    targetPoint: Point,
): Direction {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const dx = targetPoint.x - cx;
    const dy = targetPoint.y - cy;
    const hw = (shape.width || 1) / 2;
    const hh = (shape.height || 1) / 2;
    const normDx = Math.abs(dx) / hw;
    const normDy = Math.abs(dy) / hh;

    // Strongly horizontal: shapes are side-by-side → use side face
    if (normDx > normDy * 3) {
        return dx >= 0 ? 'right' : 'left';
    }
    // Strongly vertical: shapes are stacked → use top/bottom face
    if (normDy > normDx * 3) {
        return dy >= 0 ? 'down' : 'up';
    }
    // Diagonal: prefer vertical exit for cleaner elbow aesthetics
    return dy >= 0 ? 'down' : 'up';
}

/**
 * Determine the exit/entry direction from a binding's fixedPoint.
 * fixedPoint is [fx, fy] in [0-1, 0-1] on the target shape's bbox.
 *
 *   [0.5, 0]   → top    → exit upward
 *   [0.5, 1]   → bottom → exit downward
 *   [0,  0.5]  → left   → exit leftward
 *   [1,  0.5]  → right  → exit rightward
 *
 * For corners and arbitrary positions, pick the nearest edge.
 */
export function directionFromFixedPoint(fp: [number, number]): Direction {
    const [fx, fy] = fp;
    const dTop = fy;
    const dBottom = 1 - fy;
    const dLeft = fx;
    const dRight = 1 - fx;
    const min = Math.min(dTop, dBottom, dLeft, dRight);
    if (min === dTop) return 'up';
    if (min === dBottom) return 'down';
    if (min === dLeft) return 'left';
    return 'right';
}

/**
 * Determine direction from relative position of two points
 * (used when there's no binding / fixedPoint).
 * Picks the dominant axis between start and end.
 */
export function directionFromPoints(from: Point, to: Point): Direction {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? 'right' : 'left';
    }
    return dy >= 0 ? 'down' : 'up';
}

/**
 * Determine the best exit direction from a shape toward a target point.
 * Normalizes by half-dimensions so the correct face is chosen regardless
 * of aspect ratio.
 */
export function directionFromShapeToPoint(shape: BBox, targetPoint: Point): Direction {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const dx = targetPoint.x - cx;
    const dy = targetPoint.y - cy;
    const hw = shape.width / 2 || 1;
    const hh = shape.height / 2 || 1;
    const normDx = dx / hw;
    const normDy = dy / hh;
    if (Math.abs(normDx) >= Math.abs(normDy)) {
        return dx >= 0 ? 'right' : 'left';
    }
    return dy >= 0 ? 'down' : 'up';
}

/**
 * Determine exit direction by finding which face of a shape's bounding box
 * an edge point is closest to. Most accurate method — uses the ACTUAL
 * computed edge point from the binding system.
 */
export function directionFromEdgePoint(shape: BBox, edgePoint: Point): Direction {
    const dTop = Math.abs(edgePoint.y - shape.y);
    const dBottom = Math.abs(edgePoint.y - (shape.y + shape.height));
    const dLeft = Math.abs(edgePoint.x - shape.x);
    const dRight = Math.abs(edgePoint.x - (shape.x + shape.width));
    const min = Math.min(dTop, dBottom, dLeft, dRight);
    if (min === dTop) return 'up';
    if (min === dBottom) return 'down';
    if (min === dLeft) return 'left';
    return 'right';
}

// ─── Rect utilities ───────────────────────────────────────────

function rectRight(r: Rect): number { return r.left + r.width; }
function rectBottom(r: Rect): number { return r.top + r.height; }

function rectContains(r: Rect, p: Point): boolean {
    // Strict inequality: points on the boundary are NOT "inside".
    // This keeps spots along inflated-shape edges available for routing.
    return p.x > r.left && p.x < rectRight(r) &&
           p.y > r.top  && p.y < rectBottom(r);
}

function rectInflate(r: Rect, h: number, v: number): Rect {
    return {
        left: r.left - h,
        top: r.top - v,
        width: r.width + h * 2,
        height: r.height + v * 2,
    };
}

/**
 * Inflate a rect on all sides, with REDUCED inflation on the specified
 * exit/entry face. This provides clearance on all faces while still
 * allowing the connector stub to exit through the face.
 *
 * Previously this used 0 inflation on the exit face, which allowed
 * the router to place segments right along the shape's edge. Now we
 * use EXIT_FACE_MARGIN (smaller than full margin) to maintain minimum
 * clearance on the exit face without blocking tight corridors.
 */
function inflateExcludingFace(r: Rect, margin: number, face: Direction): Rect {
    const exitM = Math.min(margin, EXIT_FACE_MARGIN);
    const l = face === 'left' ? exitM : margin;
    const ri = face === 'right' ? exitM : margin;
    const t = face === 'up' ? exitM : margin;
    const b = face === 'down' ? exitM : margin;
    return {
        left: r.left - l,
        top: r.top - t,
        width: r.width + l + ri,
        height: r.height + t + b,
    };
}

/**
 * Inflate a rect on all sides, with REDUCED inflation on the specified
 * faces. Extended version of inflateExcludingFace that accepts multiple
 * faces — used for relaxed obstacle configurations to create L-shaped
 * corridors around shapes.
 */
function inflateExcludingFaces(r: Rect, margin: number, faces: Direction[]): Rect {
    const faceSet = new Set(faces);
    const exitM = Math.min(margin, EXIT_FACE_MARGIN);
    const l = faceSet.has('left') ? exitM : margin;
    const ri = faceSet.has('right') ? exitM : margin;
    const t = faceSet.has('up') ? exitM : margin;
    const b = faceSet.has('down') ? exitM : margin;
    return {
        left: r.left - l,
        top: r.top - t,
        width: r.width + l + ri,
        height: r.height + t + b,
    };
}

function rectIntersects(a: Rect, b: Rect): boolean {
    return (b.left < rectRight(a)) && (a.left < rectRight(b)) &&
           (b.top < rectBottom(a)) && (a.top < rectBottom(b));
}

function rectUnion(a: Rect, b: Rect): Rect {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(rectRight(a), rectRight(b));
    const bottom = Math.max(rectBottom(a), rectBottom(b));
    return { left, top, width: right - left, height: bottom - top };
}

function bboxToRect(b: BBox): Rect {
    return { left: b.x, top: b.y, width: b.width, height: b.height };
}

/**
 * Compute the axis-aligned bounding box (AABB) for a shape,
 * accounting for rotation. Unrotated shapes return their raw bbox.
 * Rotated shapes return the enclosing AABB of the rotated rectangle.
 *
 * This ensures obstacle inflation works correctly for rotated shapes —
 * the inflated area fully contains the rotated shape rather than just
 * the unrotated bbox (which would leave corners exposed).
 */
function getShapeBBox(el: CanvasElement): BBox {
    const rotation = el.rotation || 0;
    if (rotation === 0) {
        return { x: el.x, y: el.y, width: el.width, height: el.height };
    }

    // Compute the 4 corners of the rotated rectangle
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const hw = el.width / 2;
    const hh = el.height / 2;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Corners relative to center, then rotated
    const corners = [
        { x: -hw, y: -hh },
        { x:  hw, y: -hh },
        { x:  hw, y:  hh },
        { x: -hw, y:  hh },
    ].map(c => ({
        x: cx + c.x * cos - c.y * sin,
        y: cy + c.x * sin + c.y * cos,
    }));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of corners) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x > maxX) maxX = c.x;
        if (c.y > maxY) maxY = c.y;
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ─── Orthogonal grid graph ────────────────────────────────────

/** Movement direction on the grid */
type MoveDir = 'left' | 'right' | 'up' | 'down';

function oppositeDir(d: MoveDir): MoveDir {
    switch (d) {
        case 'left': return 'right';
        case 'right': return 'left';
        case 'up': return 'down';
        case 'down': return 'up';
    }
}

/** Determine the cardinal direction of travel between two points */
function getMoveDir(from: Point, to: Point): MoveDir | null {
    if (to.x < from.x) return 'left';
    if (to.x > from.x) return 'right';
    if (to.y < from.y) return 'up';
    if (to.y > from.y) return 'down';
    return null;
}

/** Whether two directions are on different axes (= a bend/turn) */
function isBend(a: MoveDir | null, b: MoveDir | null): boolean {
    if (a === null || b === null) return false;
    const axisA = a === 'left' || a === 'right' ? 'h' : 'v';
    const axisB = b === 'left' || b === 'right' ? 'h' : 'v';
    return axisA !== axisB;
}

class PathNode {
    adjacent = new Map<PathNode, number>();
    constructor(public readonly pt: Point) {}
}

/**
 * Weighted graph of waypoints.
 * Nodes are indexed by their (x, y) coordinates as strings.
 * Search is performed externally by `astarSearch()`.
 */
class PathGraph {
    private idx: Record<string, Record<string, PathNode>> = {};

    add(p: Point): void {
        const xs = String(p.x), ys = String(p.y);
        if (!(xs in this.idx)) this.idx[xs] = {};
        if (!(ys in this.idx[xs])) this.idx[xs][ys] = new PathNode(p);
    }

    get(p: Point): PathNode | null {
        const xs = String(p.x), ys = String(p.y);
        return this.idx[xs]?.[ys] ?? null;
    }

    has(p: Point): boolean {
        return this.get(p) !== null;
    }

    /** Create a bidirectional edge between two points */
    connect(a: Point, b: Point): void {
        const na = this.get(a), nb = this.get(b);
        if (!na || !nb) return;
        const d = Math.abs(b.x - a.x) + Math.abs(b.y - a.y); // manhattan
        na.adjacent.set(nb, d);
        nb.adjacent.set(na, d);
    }
}

// ─── Binary min-heap for A* open set ──────────────────────────

interface HeapEntry<T> { item: T; priority: number }

class MinHeap<T> {
    private data: HeapEntry<T>[] = [];
    get size() { return this.data.length; }

    push(item: T, priority: number): void {
        this.data.push({ item, priority });
        this.bubbleUp(this.data.length - 1);
    }

    pop(): T | undefined {
        if (this.data.length === 0) return undefined;
        const top = this.data[0];
        const end = this.data.pop()!;
        if (this.data.length > 0) {
            this.data[0] = end;
            this.sinkDown(0);
        }
        return top.item;
    }

    private bubbleUp(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent].priority <= this.data[i].priority) break;
            [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
            i = parent;
        }
    }

    private sinkDown(i: number): void {
        const len = this.data.length;
        while (true) {
            let s = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < len && this.data[l].priority < this.data[s].priority) s = l;
            if (r < len && this.data[r].priority < this.data[s].priority) s = r;
            if (s === i) break;
            [this.data[s], this.data[i]] = [this.data[i], this.data[s]];
            i = s;
        }
    }
}

// ─── Direction-aware A* search ────────────────────────────────

/**
 * Direction-aware A* search on the orthogonal grid graph.
 *
 * Based on the elbow arrow routing algorithm (Márk Tolmács, 2025) and the
 * academic work by Wybrow, Marriott & Stuckey ("Orthogonal Connector Routing",
 * GD 2009). Key design decisions:
 *
 * 1. **Direction-aware states**: Each search state is `(point, direction)`.
 *    Four distinct states exist per grid point (one per incoming direction).
 *    This correctly models direction-change costs AND enables U-turn
 *    prevention: arriving at the same point from different directions can
 *    lead to different optimal continuations.
 *
 * 2. **Bend-count-primary cost**: With BEND_PENALTY set to 10,000 (far
 *    exceeding typical path lengths of 100–2000px), bend count is
 *    effectively the primary sorting criterion. Distance only breaks
 *    ties between equal-bend paths. This follows the recommended approach
 *    where g(n) is primarily bend count.
 *
 * 3. **U-turn prevention**: Moving backward (opposite of incoming direction)
 *    is heavily penalized (3× BEND_PENALTY), preventing spike-like patterns
 *    where the path doubles back on itself. This is not outright prohibited
 *    so that the algorithm can still find paths when doubling back is the
 *    only option.
 *
 * 4. **Manhattan heuristic** `h(n)`: Admissible for orthogonal grids,
 *    guaranteeing A* optimality while dramatically reducing explored nodes.
 *
 * 5. **Binary min-heap**: O(log n) open-set operations instead of O(n)
 *    linear scan.
 *
 * @returns Array of Points from origin to destination, or null if no path.
 */
function astarSearch(
    graph: PathGraph,
    origin: Point,
    destination: Point,
): Point[] | null {
    const srcNode = graph.get(origin);
    const destNode = graph.get(destination);
    if (!srcNode || !destNode) return null;

    // Admissible heuristic: manhattan distance to destination
    const h = (p: Point) =>
        Math.abs(p.x - destination.x) + Math.abs(p.y - destination.y);

    // State key: encodes (x, y, incomingDir) for visited tracking.
    // Four arrivals at the same point from different directions are distinct.
    const skey = (node: PathNode, dir: MoveDir | null): string =>
        `${node.pt.x},${node.pt.y},${dir ?? 'n'}`;

    interface State {
        node: PathNode;
        dir: MoveDir | null;
        g: number;
    }

    // Best g-cost per state & parent pointers for path reconstruction
    const bestG = new Map<string, number>();
    const parentOf = new Map<string, State | null>();

    const open = new MinHeap<State>();
    const startState: State = { node: srcNode, dir: null, g: 0 };
    const startKey = skey(srcNode, null);
    bestG.set(startKey, 0);
    parentOf.set(startKey, null);
    open.push(startState, h(srcNode.pt));

    while (open.size > 0) {
        const cur = open.pop()!;
        const curKey = skey(cur.node, cur.dir);

        // Skip stale entries (a better path to this state was found)
        if (cur.g > (bestG.get(curKey) ?? Infinity)) continue;

        // Reached destination — reconstruct path
        if (cur.node === destNode) {
            const path: Point[] = [];
            let state: State | null | undefined = cur;
            while (state) {
                path.push(state.node.pt);
                const pk = skey(state.node, state.dir);
                state = parentOf.get(pk);
                if (state === null || state === undefined) break;
            }
            if (path[path.length - 1] !== srcNode.pt) {
                path.push(srcNode.pt);
            }
            path.reverse();
            return path;
        }

        // Expand neighbors
        for (const [adj, weight] of cur.node.adjacent) {
            const dir = getMoveDir(cur.node.pt, adj.pt);
            if (dir === null) continue;

            // U-turn prevention: heavily penalize backward movement.
            // This prevents spike-like patterns (directly reversed segments)
            // and avoids U-like arrow configurations around shapes.
            const isBackward = cur.dir !== null && dir === oppositeDir(cur.dir);
            const turning = isBend(cur.dir, dir);
            const penalty = isBackward
                ? BEND_PENALTY * 3   // Very heavy — avoid unless absolutely necessary
                : turning
                    ? BEND_PENALTY
                    : 0;
            const newG = cur.g + weight + penalty;

            const adjKey = skey(adj, dir);
            if (newG < (bestG.get(adjKey) ?? Infinity)) {
                bestG.set(adjKey, newG);
                parentOf.set(adjKey, cur);
                open.push(
                    { node: adj, dir, g: newG },
                    newG + h(adj.pt),
                );
            }
        }
    }

    return null; // no path found
}

// ─── Grid & spot generation ───────────────────────────────────

/** Remove duplicate points */
function deduplicatePoints(points: Point[]): Point[] {
    const map = new Map<number, Set<number>>();
    const result: Point[] = [];
    for (const p of points) {
        let ys = map.get(p.x);
        if (!ys) { ys = new Set(); map.set(p.x, ys); }
        if (!ys.has(p.y)) {
            ys.add(p.y);
            result.push(p);
        }
    }
    return result;
}

/**
 * Generate candidate waypoints from a non-uniform grid.
 *
 * Nodes are placed ONLY at ruler
 * intersections (the Cartesian product of vertical × horizontal ruler
 * values). This creates a sparse, efficient grid where bends can only
 * occur at aesthetically meaningful positions — shape edges (with
 * padding), connection point headings, and halfway between shapes.
 *
 * This replaces the previous 9-point-per-cell approach which generated
 * many redundant intermediate nodes, creating opportunities for short
 * zigzag patterns and unnecessary complexity.
 *
 * See: https://plus.excalidraw.com/blog/building-elbow-arrows-part-two
 * "Non-Uniform Grid" section.
 */
function generateGridSpots(
    verticals: number[],
    horizontals: number[],
    bounds: Rect,
    obstacles: Rect[],
): Point[] {
    const bL = bounds.left, bR = rectRight(bounds), bT = bounds.top, bB = rectBottom(bounds);
    const allXs = [...new Set([bL, ...verticals.filter(v => v >= bL && v <= bR), bR])].sort((a, b) => a - b);
    const allYs = [...new Set([bT, ...horizontals.filter(h => h >= bT && h <= bB), bB])].sort((a, b) => a - b);

    const insideObstacle = (p: Point) => obstacles.some(o => rectContains(o, p));
    const points: Point[] = [];
    for (const y of allYs) {
        for (const x of allXs) {
            const p = { x, y };
            if (!insideObstacle(p)) {
                points.push(p);
            }
        }
    }
    return points;
}

/**
 * Check if a horizontal or vertical line segment crosses through the
 * INTERIOR of any obstacle. Segments touching the obstacle boundary
 * (skirting along an edge) are allowed — only segments that pass
 * through the interior are blocked.
 */
function segmentCrossesObstacle(
    a: Point,
    b: Point,
    obstacles: Rect[],
): boolean {
    if (a.y === b.y) {
        // Horizontal segment at y
        const y = a.y;
        const x1 = Math.min(a.x, b.x);
        const x2 = Math.max(a.x, b.x);
        for (const obs of obstacles) {
            // y must be strictly inside obstacle's vertical span
            // AND the segment's x-range must overlap the obstacle's x-range
            if (obs.top < y && y < rectBottom(obs) &&
                obs.left < x2 && rectRight(obs) > x1) {
                return true;
            }
        }
    } else if (a.x === b.x) {
        // Vertical segment at x
        const x = a.x;
        const y1 = Math.min(a.y, b.y);
        const y2 = Math.max(a.y, b.y);
        for (const obs of obstacles) {
            // x must be strictly inside obstacle's horizontal span
            // AND the segment's y-range must overlap the obstacle's y-range
            if (obs.left < x && x < rectRight(obs) &&
                obs.top < y2 && rectBottom(obs) > y1) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Build a graph by connecting orthogonally adjacent spots.
 *
 * For each spot, finds the nearest existing neighbor in each cardinal
 * direction (scanning through sorted coordinate arrays). This handles
 * gaps caused by obstacle-filtered nodes: if an intermediate ruler
 * intersection is inside an obstacle, nodes on either side can still
 * connect if the segment between them is clear.
 *
 * Edges that would pass through an obstacle's interior are NOT created,
 * forcing the pathfinder to route around obstacles.
 */
function buildGraph(spots: Point[], obstacles: Rect[]): PathGraph {
    const graph = new PathGraph();
    const xSet = new Set<number>();
    const ySet = new Set<number>();

    for (const p of spots) {
        graph.add(p);
        xSet.add(p.x);
        ySet.add(p.y);
    }

    const hotXs = [...xSet].sort((a, b) => a - b);
    const hotYs = [...ySet].sort((a, b) => a - b);

    for (let i = 0; i < hotYs.length; i++) {
        for (let j = 0; j < hotXs.length; j++) {
            const cur = { x: hotXs[j], y: hotYs[i] };
            if (!graph.has(cur)) continue;

            // Connect to nearest existing left neighbor (scan leftward)
            for (let k = j - 1; k >= 0; k--) {
                const left = { x: hotXs[k], y: hotYs[i] };
                if (graph.has(left)) {
                    if (!segmentCrossesObstacle(left, cur, obstacles)) {
                        graph.connect(left, cur);
                    }
                    break;
                }
            }

            // Connect to nearest existing top neighbor (scan upward)
            for (let k = i - 1; k >= 0; k--) {
                const up = { x: hotXs[j], y: hotYs[k] };
                if (graph.has(up)) {
                    if (!segmentCrossesObstacle(up, cur, obstacles)) {
                        graph.connect(up, cur);
                    }
                    break;
                }
            }
        }
    }

    return graph;
}

// ─── Path simplification ─────────────────────────────────────

/** Remove collinear intermediate points from a Point[] path */
function simplifyPointPath(points: Point[]): Point[] {
    if (points.length <= 2) return points;
    const result: Point[] = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1], cur = points[i], next = points[i + 1];
        const collinearX = prev.x === cur.x && cur.x === next.x;
        const collinearY = prev.y === cur.y && cur.y === next.y;
        if (collinearX || collinearY) continue;
        // Skip zero-length segment
        if (prev.x === cur.x && prev.y === cur.y) continue;
        result.push(cur);
    }
    result.push(points[points.length - 1]);
    return result;
}

// ─── Route scoring & selection ─────────────────────────────────

/** Count the number of bends (direction changes) in a simplified path */
function countBends(path: Point[]): number {
    if (path.length <= 2) return 0;
    let bends = 0;
    for (let i = 1; i < path.length - 1; i++) {
        const prev = path[i - 1], cur = path[i], next = path[i + 1];
        // Collinear points (same x or same y through all three) = no bend
        const sameX = prev.x === cur.x && cur.x === next.x;
        const sameY = prev.y === cur.y && cur.y === next.y;
        if (!sameX && !sameY) bends++;
    }
    return bends;
}

/** Total manhattan length of a path */
function totalPathLength(path: Point[]): number {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
        len += Math.abs(path[i].x - path[i - 1].x)
             + Math.abs(path[i].y - path[i - 1].y);
    }
    return len;
}

/**
 * Pick the best route from multiple candidates.
 * Primary criterion: fewest bends (cleanest path).
 * Secondary criterion: shortest total manhattan length.
 */
function pickBestRoute(candidates: Point[][]): Point[] {
    let best = candidates[0];
    let bestBends = countBends(best);
    let bestLen = totalPathLength(best);
    for (let i = 1; i < candidates.length; i++) {
        const bends = countBends(candidates[i]);
        const len = totalPathLength(candidates[i]);
        if (bends < bestBends || (bends === bestBends && len < bestLen)) {
            best = candidates[i];
            bestBends = bends;
            bestLen = len;
        }
    }
    return best;
}

// ─── Core routing (grid-based) ────────────────────────────────

/**
 * Run grid-based Dijkstra routing with the given obstacles.
 * This is the inner workhorse — `computeElbowRoute` calls it
 * with different obstacle configurations and picks the best result.
 *
 * @returns simplified Point[] path, or null if no path found
 */
function findRouteWithObstacles(
    start: Point,
    end: Point,
    startDir: Direction,
    endDir: Direction,
    obstacles: Rect[],
    margin: number,
): Point[] | null {
    // Global bounds = union of all obstacles + start/end + extra margin
    let bounds: Rect = {
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x) || 1,
        height: Math.abs(end.y - start.y) || 1,
    };
    for (const obs of obstacles) {
        bounds = rectUnion(bounds, obs);
    }
    bounds = rectInflate(bounds, BOUNDS_MARGIN, BOUNDS_MARGIN);

    // ── Rulers ──
    // Following the non-uniform grid approach, rulers are placed at:
    // 1. Shape edges (with padding) — from the inflated obstacle rects
    // 2. Shape centers — creates useful intersections beyond the obstacle
    // 3. Connection point coordinates — start/end positions
    // 4. Antenna point coordinates — offset connection points
    // 5. Midpoint between shapes — balanced turning positions
    const verticals: number[] = [];
    const horizontals: number[] = [];
    for (const obs of obstacles) {
        verticals.push(obs.left, rectRight(obs));
        horizontals.push(obs.top, rectBottom(obs));
        // Shape center rulers — the center itself is inside the obstacle,
        // but the ruler lines extend outside to create useful routing
        // intersections at positions humans would naturally choose.
        verticals.push(obs.left + obs.width / 2);
        horizontals.push(obs.top + obs.height / 2);
    }
    // Both axes at connection points for maximum grid coverage
    verticals.push(start.x, end.x);
    horizontals.push(start.y, end.y);

    // ── Antenna points ──
    const sv = dirVec(startDir);
    const ev = dirVec(endDir);
    let origin: Point = {
        x: start.x + sv.x * margin,
        y: start.y + sv.y * margin,
    };
    let destination: Point = {
        x: end.x + ev.x * margin,
        y: end.y + ev.y * margin,
    };
    origin = clearAntennaPoint(origin, startDir, obstacles);
    destination = clearAntennaPoint(destination, endDir, obstacles);

    verticals.push(origin.x, destination.x);
    horizontals.push(origin.y, destination.y);

    // ── Midpoint rulers for balanced routing between shapes ──
    // Without these, the grid may lack a convenient waypoint at the
    // geometric midpoint, forcing turns at less natural locations.
    verticals.push((start.x + end.x) / 2);
    horizontals.push((start.y + end.y) / 2);

    // ── Grid + graph ──
    const gridSpots = generateGridSpots(verticals, horizontals, bounds, obstacles);
    const allSpots = deduplicatePoints([origin, destination, ...gridSpots]);
    const graph = buildGraph(allSpots, obstacles);

    // ── A* search with direction-aware states ──
    const pathPoints = astarSearch(graph, origin, destination);
    if (pathPoints) {
        const fullPath = [start, ...pathPoints, end];
        return simplifyPointPath(fullPath);
    }
    return null;
}

/**
 * Compute an orthogonal route between two points using a multi-candidate
 * grid-based shortest-path algorithm.
 *
 * Generates multiple obstacle inflation configurations and routes through
 * each, then picks the route with the fewest bends (and shortest length
 * as tiebreaker). This produces cleaner paths, especially when shapes
 * are positioned diagonally and the standard inflation blocks direct routes.
 *
 * Obstacle configurations:
 *
 * 1. **Standard**: Each shape inflated on all sides except its exit/entry
 *    face. Works well when shapes are aligned horizontally or vertically.
 *
 * 2. **Relaxed**: Additionally excludes the face of each shape that faces
 *    toward the other connection point. This creates L-shaped corridors
 *    around shapes, allowing more direct paths when shapes are diagonal.
 *    For example, if start exits RIGHT and end shape is UP-RIGHT, the
 *    relaxed config also opens the LEFT face of the end shape, enabling
 *    a clean 2-bend path instead of a 4-bend detour.
 *
 * @param start     Start connection point (world coordinates)
 * @param end       End connection point (world coordinates)
 * @param startDir  Exit direction from start shape
 * @param endDir    Exit direction from end shape (face the connector arrives at)
 * @param startBBox Bounding box of start shape (null for unbound endpoints)
 * @param endBBox   Bounding box of end shape (null for unbound endpoints)
 * @returns         Array of Points forming the orthogonal path (world coords)
 */
export function computeElbowRoute(
    start: Point,
    end: Point,
    startDir: Direction,
    endDir: Direction,
    startBBox?: BBox | null,
    endBBox?: BBox | null,
    minStubLength?: number,
    /** Additional obstacles (intermediate shapes) to avoid — already as BBox */
    intermediateObstacles?: BBox[],
): Point[] {
    // Degenerate case: start and end are the same point
    if (start.x === end.x && start.y === end.y) {
        return [start, end];
    }

    // Convert BBoxes to Rects (zero-size for unbound endpoints)
    const shapeA: Rect = startBBox
        ? bboxToRect(startBBox)
        : { left: start.x, top: start.y, width: 0, height: 0 };
    const shapeB: Rect = endBBox
        ? bboxToRect(endBBox)
        : { left: end.x, top: end.y, width: 0, height: 0 };

    // Separate concerns: obstacle inflation uses SHAPE_MARGIN (small,
    // for flexible routing in tight spaces), antenna stub length uses
    // MIN_STUB_LENGTH or minStubLength (large, to accommodate arrowheads
    // and ensure visually distinct end-segments).
    const inflationMargin = SHAPE_MARGIN;
    const antennaMargin = Math.max(MIN_STUB_LENGTH, minStubLength ?? 0);

    // ── Intermediate obstacles ──
    // Inflate all intermediate shapes uniformly on all sides.
    // These are shapes that sit between start and end and must be avoided.
    const intermediateRects: Rect[] = (intermediateObstacles ?? []).map(bbox =>
        rectInflate(bboxToRect(bbox), inflationMargin, inflationMargin),
    );

    // ── Config 1: Standard obstacle inflation ──
    // Each shape inflated on all sides EXCEPT its exit/entry face.
    const inflA_std = startBBox
        ? inflateExcludingFace(shapeA, inflationMargin, startDir)
        : rectInflate(shapeA, inflationMargin, inflationMargin);
    const inflB_std = endBBox
        ? inflateExcludingFace(shapeB, inflationMargin, endDir)
        : rectInflate(shapeB, inflationMargin, inflationMargin);

    // ── Config 2: Relaxed obstacle inflation ──
    // Additionally exclude the face of each shape that faces toward the
    // other connection point. This opens corridors for more direct paths.
    const facesA: Direction[] = [startDir];
    const facesB: Direction[] = [endDir];
    let hasRelaxedConfig = false;

    if (startBBox) {
        const faceTowardEnd = directionFromShapeToPoint(startBBox, end);
        if (faceTowardEnd !== startDir) {
            facesA.push(faceTowardEnd);
            hasRelaxedConfig = true;
        }
    }
    if (endBBox) {
        const faceTowardStart = directionFromShapeToPoint(endBBox, start);
        if (faceTowardStart !== endDir) {
            facesB.push(faceTowardStart);
            hasRelaxedConfig = true;
        }
    }

    const inflA_rlx = startBBox
        ? inflateExcludingFaces(shapeA, inflationMargin, facesA)
        : rectInflate(shapeA, inflationMargin, inflationMargin);
    const inflB_rlx = endBBox
        ? inflateExcludingFaces(shapeB, inflationMargin, facesB)
        : rectInflate(shapeB, inflationMargin, inflationMargin);

    // ── Try all configs and pick best route ──
    const candidates: Point[][] = [];

    const route1 = findRouteWithObstacles(
        start, end, startDir, endDir,
        [inflA_std, inflB_std, ...intermediateRects],
        antennaMargin,
    );
    if (route1) candidates.push(route1);

    if (hasRelaxedConfig) {
        const route2 = findRouteWithObstacles(
            start, end, startDir, endDir,
            [inflA_rlx, inflB_rlx, ...intermediateRects],
            antennaMargin,
        );
        if (route2) candidates.push(route2);
    }

    if (candidates.length > 0) {
        return pickBestRoute(candidates);
    }

    // ── Fallback: try without intermediate obstacles ──
    // When intermediate shapes block ALL paths, retry with only
    // the endpoint shapes. Better to cut through shapes than fail.
    if (intermediateRects.length > 0) {
        const routeFallback = findRouteWithObstacles(
            start, end, startDir, endDir,
            [inflA_std, inflB_std],
            antennaMargin,
        );
        if (routeFallback) return routeFallback;
    }

    // ── Final fallback ──
    return simplifyPointPath(fallbackRoute(start, end, startDir, endDir, antennaMargin));
}

/**
 * If the antenna point is strictly inside any obstacle, project it
 * along the exit direction until it clears all obstacles.
 * Iterates to handle cascading (clearing one obstacle might push into another).
 */
function clearAntennaPoint(pt: Point, dir: Direction, obstacles: Rect[]): Point {
    let { x, y } = pt;
    for (let pass = 0; pass < obstacles.length; pass++) {
        let allClear = true;
        for (const obs of obstacles) {
            // Strictly inside? (boundary is OK)
            if (x <= obs.left || x >= rectRight(obs) ||
                y <= obs.top  || y >= rectBottom(obs)) {
                continue;
            }
            allClear = false;
            // Push past this obstacle in the exit direction
            switch (dir) {
                case 'left':  x = obs.left - 1; break;
                case 'right': x = rectRight(obs) + 1; break;
                case 'up':    y = obs.top - 1; break;
                case 'down':  y = rectBottom(obs) + 1; break;
            }
        }
        if (allClear) break;
    }
    return { x, y };
}

/**
 * Simple fallback route when the grid-based algorithm can't find a path.
 * Creates a basic orthogonal path with stubs and midpoint turns.
 */
function fallbackRoute(
    start: Point,
    end: Point,
    startDir: Direction,
    endDir: Direction,
    margin: number,
): Point[] {
    const stub = Math.max(margin, SHAPE_MARGIN);
    const sv = dirVec(startDir);
    const ev = dirVec(endDir);
    const s1: Point = { x: start.x + sv.x * stub, y: start.y + sv.y * stub };
    const e1: Point = { x: end.x + ev.x * stub, y: end.y + ev.y * stub };

    if (isVerticalDir(startDir) === isVerticalDir(endDir)) {
        // Same axis: S-bend through midpoint
        if (isVerticalDir(startDir)) {
            const midY = (s1.y + e1.y) / 2;
            return [start, s1, { x: s1.x, y: midY }, { x: e1.x, y: midY }, e1, end];
        } else {
            const midX = (s1.x + e1.x) / 2;
            return [start, s1, { x: midX, y: s1.y }, { x: midX, y: e1.y }, e1, end];
        }
    } else {
        // Perpendicular: L-bend
        if (isVerticalDir(startDir)) {
            return [start, s1, { x: s1.x, y: e1.y }, e1, end];
        } else {
            return [start, s1, { x: e1.x, y: s1.y }, e1, end];
        }
    }
}

// ─── High-level API ───────────────────────────────────────────

/**
 * Compute the full elbow points for an arrow/line element.
 * Takes the element's world-space start and end points, its bindings,
 * and the full element list, and returns a flat `number[]` array of
 * elbow-routed points **relative to the element origin (start point)**.
 *
 * Direction selection strategy:
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │ Binding type     │ Direction method             │ Rationale        │
 * ├──────────────────┼──────────────────────────────┼──────────────────┤
 * │ Center           │ getElbowPreferredDirection    │ Prefers vertical │
 * │ (isPrecise=false │ (shape geometry → target)     │ exits for clean  │
 * │  or fp=[.5,.5])  │                               │ elbow aesthetics │
 * ├──────────────────┼──────────────────────────────┼──────────────────┤
 * │ Precise/Edge     │ directionFromFixedPoint       │ Respect user's   │
 * │ (isPrecise=true, │ (face of fixedPoint)          │ chosen edge face │
 * │  fp≠[.5,.5])     │                               │                  │
 * ├──────────────────┼──────────────────────────────┼──────────────────┤
 * │ No binding       │ directionFromPoints           │ Dominant axis of │
 * │                  │ (start → end delta)           │ the vector       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * IMPORTANT: For precise bindings, we must NOT override the direction
 * with directionFromShapeToPoint — doing so would cause the line to
 * exit from a different face than where the user placed the handle,
 * creating a visual mismatch.
 *
 * This is the main entry point used by shape renderers.
 */
/** Shape types that can act as obstacles for elbow routing */
const OBSTACLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'image']);

// ─── Route Cache ──────────────────────────────────────────────

/**
 * LRU-style route cache to avoid redundant A* computations.
 *
 * Cache key includes: start/end positions, directions, bound shape ids,
 * and a fingerprint of intermediate obstacles. This ensures cache hits
 * only when the routing context is identical.
 *
 * The cache is invalidated naturally when any input changes (shape moves,
 * elements added/removed). Max 256 entries to bound memory usage.
 */
const ROUTE_CACHE_MAX = 256;
const routeCache = new Map<string, number[]>();

function buildCacheKey(
    startWorld: Point,
    endWorld: Point,
    startDir: Direction,
    endDir: Direction,
    startBBox: BBox | null,
    endBBox: BBox | null,
    obstacleFingerprint: string,
    minStubLength?: number,
): string {
    // Round to 0.5px to absorb floating-point jitter during drags
    const r = (v: number) => Math.round(v * 2) / 2;
    return [
        r(startWorld.x), r(startWorld.y),
        r(endWorld.x), r(endWorld.y),
        startDir, endDir,
        startBBox ? `${r(startBBox.x)},${r(startBBox.y)},${r(startBBox.width)},${r(startBBox.height)}` : 'n',
        endBBox ? `${r(endBBox.x)},${r(endBBox.y)},${r(endBBox.width)},${r(endBBox.height)}` : 'n',
        obstacleFingerprint,
        minStubLength ?? 0,
    ].join('|');
}

/** Clear the route cache (call when elements change structurally) */
export function clearElbowRouteCache(): void {
    routeCache.clear();
}

export function computeElbowPoints(
    startWorld: Point,
    endWorld: Point,
    startBinding: Binding | null,
    endBinding: Binding | null,
    allElements: CanvasElement[],
    minStubLength?: number,
): number[] {
    const elementMap = new Map(allElements.map(el => [el.id, el]));

    // Center bindings have fixedPoint [0.5, 0.5] — directionFromFixedPoint
    // is ambiguous there, so fall back to shape-geometry direction detection.
    const isCenterBinding = (b: Binding): boolean =>
        !b.isPrecise ||
        (b.fixedPoint[0] === 0.5 && b.fixedPoint[1] === 0.5);

    // ── Determine exit direction from start ──
    let startDir: Direction;
    if (startBinding) {
        if (isCenterBinding(startBinding)) {
            const startEl = elementMap.get(startBinding.elementId);
            startDir = startEl
                ? getElbowPreferredDirection(startEl, endWorld)
                : directionFromPoints(startWorld, endWorld);
        } else {
            startDir = directionFromFixedPoint(startBinding.fixedPoint);
        }
    } else {
        startDir = directionFromPoints(startWorld, endWorld);
    }

    // ── Determine entry direction into end shape ──
    let endDir: Direction;
    if (endBinding) {
        if (isCenterBinding(endBinding)) {
            const endEl = elementMap.get(endBinding.elementId);
            endDir = endEl
                ? getElbowPreferredDirection(endEl, startWorld)
                : directionFromPoints(endWorld, startWorld);
        } else {
            endDir = directionFromFixedPoint(endBinding.fixedPoint);
        }
    } else {
        endDir = directionFromPoints(endWorld, startWorld);
    }

    // Get shape bounding boxes for endpoint avoidance
    const startBBox = startBinding ? elementMap.get(startBinding.elementId) ?? null : null;
    const endBBox = endBinding ? elementMap.get(endBinding.elementId) ?? null : null;
    const startShapeBBox = startBBox ? getShapeBBox(startBBox) : null;
    const endShapeBBox = endBBox ? getShapeBBox(endBBox) : null;

    // ── Collect intermediate obstacles ──
    // ALL connectable shapes (except the two endpoint shapes) are obstacles.
    // This prevents routes from cutting through shapes that sit between
    // the start and end positions — matching standard canvas editor behavior.
    const startId = startBinding?.elementId;
    const endId = endBinding?.elementId;
    const intermediateObstacles: BBox[] = [];
    // Build fingerprint for cache key (sorted for stability)
    const fpParts: string[] = [];
    const r = (v: number) => Math.round(v * 2) / 2;

    for (const el of allElements) {
        // Skip non-obstacle types (lines, arrows, freedraw)
        if (!OBSTACLE_TYPES.has(el.type)) continue;
        // Skip the two endpoint shapes (they get special inflation)
        if (el.id === startId || el.id === endId) continue;
        // Skip invisible elements
        if (!el.isVisible) continue;

        const bbox = getShapeBBox(el);

        // Only include shapes that are near the routing area.
        // Shapes far away from both start and end cannot affect the route
        // and would only increase grid complexity.
        const routeMinX = Math.min(startWorld.x, endWorld.x) - BOUNDS_MARGIN * 3;
        const routeMaxX = Math.max(startWorld.x, endWorld.x) + BOUNDS_MARGIN * 3;
        const routeMinY = Math.min(startWorld.y, endWorld.y) - BOUNDS_MARGIN * 3;
        const routeMaxY = Math.max(startWorld.y, endWorld.y) + BOUNDS_MARGIN * 3;

        // Check if shape bbox overlaps the expanded route area
        if (bbox.x + bbox.width < routeMinX || bbox.x > routeMaxX ||
            bbox.y + bbox.height < routeMinY || bbox.y > routeMaxY) {
            continue; // Shape is too far away to matter
        }

        intermediateObstacles.push(bbox);
        fpParts.push(`${el.id}:${r(bbox.x)},${r(bbox.y)},${r(bbox.width)},${r(bbox.height)}`);
    }

    // ── Route cache lookup ──
    fpParts.sort(); // Stable fingerprint regardless of element order
    const obstacleFP = fpParts.join(';');
    const cacheKey = buildCacheKey(
        startWorld, endWorld, startDir, endDir,
        startShapeBBox, endShapeBBox, obstacleFP, minStubLength,
    );
    const cached = routeCache.get(cacheKey);
    if (cached) return cached;

    // ── Compute route ──
    const route = computeElbowRoute(
        startWorld,
        endWorld,
        startDir,
        endDir,
        startShapeBBox,
        endShapeBBox,
        minStubLength,
        intermediateObstacles,
    );

    // Convert world points to flat array relative to startWorld
    const flat: number[] = [];
    for (const pt of route) {
        flat.push(pt.x - startWorld.x, pt.y - startWorld.y);
    }

    // ── Store in cache (LRU eviction) ──
    if (routeCache.size >= ROUTE_CACHE_MAX) {
        // Evict oldest entry (first key in insertion order)
        const firstKey = routeCache.keys().next().value;
        if (firstKey !== undefined) routeCache.delete(firstKey);
    }
    routeCache.set(cacheKey, flat);

    return flat;
}

/**
 * Simplify an elbow path (flat number[] format) by removing redundant
 * collinear points and zero-length segments.
 */
export function simplifyElbowPath(points: number[]): number[] {
    if (points.length <= 4) return points;

    const result: number[] = [points[0], points[1]];
    for (let i = 2; i < points.length - 2; i += 2) {
        const prevX = result[result.length - 2];
        const prevY = result[result.length - 1];
        const curX = points[i];
        const curY = points[i + 1];
        const nextX = points[i + 2];
        const nextY = points[i + 3];

        // Skip if collinear (all on same horizontal or vertical line)
        const sameH = prevY === curY && curY === nextY;
        const sameV = prevX === curX && curX === nextX;
        if (sameH || sameV) continue;

        // Skip zero-length segment
        if (prevX === curX && prevY === curY) continue;

        result.push(curX, curY);
    }
    result.push(points[points.length - 2], points[points.length - 1]);
    return result;
}
