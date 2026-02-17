import React, { useRef, useMemo, useCallback } from 'react';
import { Line, Group, Shape } from 'react-konva';
import type Konva from 'konva';
import type { ArrowElement, CanvasElement } from '@/types';
import { getStrokeDash, snapToGrid, computePointsBounds } from '@/utils/geometry';
import { SELECTION_SHADOW } from '@/constants';
import { drawArrowhead, arrowheadSize, flatToPoints } from '@/utils/arrowheads';
import { computeCurveControlPoint, curveArrowPrev, CURVE_RATIO } from '@/utils/curve';
import { createRNG, drawRoughPolyline, drawRoughCurve, getRoughPasses } from '@/utils/roughness';
import { computeElbowPoints, simplifyElbowPath } from '@/utils/elbow';
import { useElbowShapeFingerprint } from '@/hooks/useElbowShapeFingerprint';
import { useElbowWorker } from '@/hooks/useElbowWorker';

interface Props {
    element: ArrowElement;
    isSelected: boolean;
    isEditing?: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<ArrowElement>) => void;
    onDragMove?: (id: string, updates: Partial<ArrowElement>) => void;
    onDoubleClick?: (id: string) => void;
    gridSnap?: number;
    /** All elements — needed for elbow routing to resolve shape bboxes */
    allElements?: CanvasElement[];
}

/** Resolve legacy startArrow/endArrow booleans to Arrowhead | null */
function resolveArrowheads(el: ArrowElement): { start: ArrowElement['startArrowhead']; end: ArrowElement['endArrowhead'] } {
    let start = el.startArrowhead ?? null;
    let end = el.endArrowhead ?? null;
    // Backward compat: legacy boolean fields
    if (start === null && el.startArrow) start = 'arrow';
    if (end === null && el.endArrow) end = 'arrow';
    return { start, end };
}

const ArrowShape: React.FC<Props> = ({ element, isSelected, isEditing, isGrouped, onSelect, onChange, onDragMove, onDoubleClick, gridSnap, allElements }) => {
    const { id, x, y, points, rotation, style, startBinding, endBinding, lineType, isLocked } = element;
    const isDraggable = !isLocked && !isGrouped;
    const groupRef = useRef<Konva.Group>(null);
    const roughness = style.roughness;

    const { start: startHead, end: endHead } = resolveArrowheads(element);
    const hasCustomHead = startHead != null || endHead != null;
    const isCurved = lineType === 'curved';
    const isElbow = lineType === 'elbow';
    const size = arrowheadSize(style.strokeWidth);
    const passes = getRoughPasses(roughness);

    // Stable fingerprint of connectable shapes — only changes when
    // shape positions/sizes change, not on every render cycle.
    // elementsRef provides a stable reference for computeElbowPoints.
    const { fingerprint: shapeFP, elementsRef } = useElbowShapeFingerprint(allElements);

    // ── Elbow world-coordinate endpoints ──
    const elbowStartWorld = useMemo(
        () => ({ x: x + points[0], y: y + points[1] }),
        [x, y, points[0], points[1]], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const elbowEndWorld = useMemo(
        () => ({ x: x + points[points.length - 2], y: y + points[points.length - 1] }),
        [x, y, points], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const elbowMinStub = hasCustomHead ? Math.ceil(size * 1.5) : undefined;

    // Async Worker computation (returns null until a result arrives)
    const workerResult = useElbowWorker(
        isElbow,
        { startWorld: elbowStartWorld, endWorld: elbowEndWorld, startBinding, endBinding, minStubLength: elbowMinStub },
        allElements ?? [],
        shapeFP,
    );

    // Sync fallback: used as initial render + when Worker is not available
    const syncElbowPoints = useMemo(() => {
        if (!isElbow) return points;
        const raw = computeElbowPoints(
            elbowStartWorld,
            elbowEndWorld,
            startBinding,
            endBinding,
            elementsRef.current,
            elbowMinStub,
        );
        return simplifyElbowPath(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isElbow, x, y, points, startBinding, endBinding, shapeFP]);

    // For elbow mode: use Worker result if available, otherwise sync
    const elbowPointsRaw = isElbow ? (workerResult ?? syncElbowPoints) : points;
    const elbowPoints = useMemo(() => {
        if (!isElbow) return points;
        const result = [...elbowPointsRaw];
        // Offset by points[0]/[1] (start point position within element)
        const p0x = points[0], p0y = points[1];
        if (p0x !== 0 || p0y !== 0) {
            for (let i = 0; i < result.length; i += 2) {
                result[i] += p0x;
                result[i + 1] += p0y;
            }
        }
        return result;
    }, [isElbow, elbowPointsRaw, points]);

    // For curved mode: compute quadratic bezier from start+end only
    // (skip computation entirely when not curved to avoid wasted work)
    const curveData = useMemo(() => {
        if (!isCurved) return null;
        const start = { x: points[0], y: points[1] };
        const end = { x: points[points.length - 2], y: points[points.length - 1] };
        const cp = computeCurveControlPoint(start, end, element.curvature ?? CURVE_RATIO);
        return { start, end, cp };
    }, [isCurved, points, element.curvature]);

    const handleClick = useCallback(() => onSelect(id), [onSelect, id]);
    const handleDblClick = useCallback(() => onDoubleClick?.(id), [onDoubleClick, id]);
    const handleDragMove = useCallback((e: any) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); e.target.x(nx); e.target.y(ny); }
        onDragMove?.(id, { x: nx, y: ny });
    }, [id, gridSnap, onDragMove]);
    const handleDragEnd = useCallback((e: any) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); }
        onChange(id, { x: nx, y: ny });
    }, [id, gridSnap, onChange]);

    const handleTransformEnd = useCallback((e: Konva.KonvaEventObject<Event>) => {
        const node = e.target;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.setAttrs({ scaleX: 1, scaleY: 1 });
        const newPoints = points.map((v, i) => i % 2 === 0 ? v * scaleX : v * scaleY);
        const bounds = computePointsBounds(newPoints);
        onChange(id, {
            x: node.x(),
            y: node.y(),
            points: newPoints,
            rotation: node.rotation(),
            width: bounds.width,
            height: bounds.height,
        });
    }, [id, points, onChange]);

    // Selection shadow props
    const shadowColor = isSelected ? SELECTION_SHADOW.color : undefined;
    const shadowBlur = isSelected ? SELECTION_SHADOW.blur : 0;
    const shadowOpacity = isSelected ? SELECTION_SHADOW.opacity : 0;
    return (
        <Group
            id={id}
            ref={groupRef}
            x={x}
            y={y}
            rotation={rotation}
            transformsEnabled={rotation ? 'all' : 'position'}
            draggable={isDraggable}
            onClick={handleClick}
            onTap={handleClick}
            onDblClick={handleDblClick}
            onDblTap={handleDblClick}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onTransformEnd={handleTransformEnd}
        >
            {isElbow ? (
                /* Elbow (orthogonal) mode */
                <>
                    <Line
                        points={elbowPoints}
                        stroke="transparent"
                        strokeWidth={Math.max(20, style.strokeWidth + 16)}
                        listening={true}
                        perfectDrawEnabled={false}
                    />
                    <Line
                        points={elbowPoints}
                        stroke={style.strokeColor}
                        strokeWidth={style.strokeWidth}
                        opacity={style.opacity}
                        dash={getStrokeDash(style.strokeStyle, style.strokeWidth)}
                        lineCap="square"
                        lineJoin="miter"
                        shadowColor={shadowColor}
                        shadowBlur={shadowBlur}
                        shadowOpacity={shadowOpacity}
                        listening={false}
                        perfectDrawEnabled={false}
                        shadowForStrokeEnabled={false}
                    />
                    {/* Arrowheads for elbow */}
                    {hasCustomHead && (
                        <Shape
                            sceneFunc={(ctx, shape) => {
                                const pts = flatToPoints(elbowPoints);
                                if (pts.length < 2) return;
                                if (startHead) {
                                    drawArrowhead(ctx, startHead, pts[0], pts[1], size, style.strokeColor, style.strokeWidth);
                                }
                                if (endHead) {
                                    const last = pts[pts.length - 1];
                                    const prev = pts[pts.length - 2];
                                    drawArrowhead(ctx, endHead, last, prev, size, style.strokeColor, style.strokeWidth);
                                }
                                ctx.fillStrokeShape(shape);
                            }}
                            listening={false}
                            opacity={style.opacity}
                        />
                    )}
                </>
            ) : isCurved ? (
                /* Curved mode */
                <>
                    <Shape
                        sceneFunc={(ctx, shape) => {
                            if (!curveData) return;
                            ctx.beginPath();
                            if (roughness > 0) {
                                const rng = createRNG(id);
                                drawRoughCurve(ctx, curveData.start, curveData.cp, curveData.end, roughness, rng, passes, style.strokeWidth);
                            } else {
                                ctx.moveTo(curveData.start.x, curveData.start.y);
                                ctx.quadraticCurveTo(curveData.cp.x, curveData.cp.y, curveData.end.x, curveData.end.y);
                            }
                            ctx.fillStrokeShape(shape);
                        }}
                        stroke={style.strokeColor}
                        strokeWidth={style.strokeWidth}
                        hitStrokeWidth={Math.max(20, style.strokeWidth + 16)}
                        dash={getStrokeDash(style.strokeStyle, style.strokeWidth)}
                        lineCap="round"
                        lineJoin="round"
                        listening={true}
                        opacity={style.opacity}
                        shadowColor={shadowColor}
                        shadowBlur={shadowBlur}
                        shadowOpacity={shadowOpacity}
                        perfectDrawEnabled={false}
                        shadowForStrokeEnabled={false}
                    />
                    {/* Arrowheads — tangent follows bezier curve */}
                    {hasCustomHead && curveData && (
                        <Shape
                            sceneFunc={(ctx) => {
                                if (startHead) {
                                    const prev = curveArrowPrev(curveData.start, curveData.cp, curveData.end, false);
                                    drawArrowhead(ctx as any, startHead, curveData.start, prev, size, style.strokeColor, style.strokeWidth);
                                }
                                if (endHead) {
                                    const prev = curveArrowPrev(curveData.start, curveData.cp, curveData.end, true);
                                    drawArrowhead(ctx as any, endHead, curveData.end, prev, size, style.strokeColor, style.strokeWidth);
                                }
                            }}
                            listening={false}
                            opacity={style.opacity}
                        />
                    )}
                </>
            ) : roughness > 0 ? (
                /* Sharp + rough mode */
                <>
                    <Shape
                        sceneFunc={(ctx, shape) => {
                            const rng = createRNG(id);
                            ctx.beginPath();
                            drawRoughPolyline(ctx, points, roughness, rng, passes, style.strokeWidth);
                            ctx.fillStrokeShape(shape);
                        }}
                        stroke={style.strokeColor}
                        strokeWidth={style.strokeWidth}
                        hitStrokeWidth={Math.max(20, style.strokeWidth + 16)}
                        dash={getStrokeDash(style.strokeStyle, style.strokeWidth)}
                        lineCap="round"
                        lineJoin="round"
                        listening={true}
                        opacity={style.opacity}
                        shadowColor={shadowColor}
                        shadowBlur={shadowBlur}
                        shadowOpacity={shadowOpacity}
                        perfectDrawEnabled={false}
                        shadowForStrokeEnabled={false}
                    />
                    {hasCustomHead && (
                        <Shape
                            sceneFunc={(ctx, shape) => {
                                const pts = flatToPoints(points);
                                if (pts.length < 2) return;
                                if (startHead) {
                                    drawArrowhead(ctx, startHead, pts[0], pts[1], size, style.strokeColor, style.strokeWidth);
                                }
                                if (endHead) {
                                    const last = pts[pts.length - 1];
                                    const prev = pts[pts.length - 2];
                                    drawArrowhead(ctx, endHead, last, prev, size, style.strokeColor, style.strokeWidth);
                                }
                                ctx.fillStrokeShape(shape);
                            }}
                            listening={false}
                            opacity={style.opacity}
                        />
                    )}
                </>
            ) : (
                /* Sharp + clean mode */
                <>
                    <Line
                        points={points}
                        stroke="transparent"
                        strokeWidth={Math.max(20, style.strokeWidth + 16)}
                        listening={true}
                        perfectDrawEnabled={false}
                    />
                    <Line
                        points={points}
                        stroke={style.strokeColor}
                        strokeWidth={style.strokeWidth}
                        opacity={style.opacity}
                        dash={getStrokeDash(style.strokeStyle, style.strokeWidth)}
                        lineCap="round"
                        lineJoin="round"
                        shadowColor={shadowColor}
                        shadowBlur={shadowBlur}
                        shadowOpacity={shadowOpacity}
                        listening={false}
                        perfectDrawEnabled={false}
                        shadowForStrokeEnabled={false}
                    />
                    {/* Custom arrowheads overlay */}
                    {hasCustomHead && (
                        <Shape
                            sceneFunc={(ctx, shape) => {
                                const pts = flatToPoints(points);
                                if (pts.length < 2) return;
                                if (startHead) {
                                    drawArrowhead(ctx, startHead, pts[0], pts[1], size, style.strokeColor, style.strokeWidth);
                                }
                                if (endHead) {
                                    const last = pts[pts.length - 1];
                                    const prev = pts[pts.length - 2];
                                    drawArrowhead(ctx, endHead, last, prev, size, style.strokeColor, style.strokeWidth);
                                }
                                ctx.fillStrokeShape(shape);
                            }}
                            listening={false}
                            opacity={style.opacity}
                        />
                    )}
                </>
            )}
        </Group>
    );
};

export default React.memo(ArrowShape);
