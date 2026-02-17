/**
 * LinearElementHandles.tsx
 *
 * Renders draggable point handles and midpoint handles for a
 * line/arrow element that is in edit mode.  Each point is a
 * Konva Circle the user can drag.  Midpoints (between segments)
 * appear as smaller circles — clicking a midpoint inserts a new
 * point into the element at that position.
 */
import React, { useCallback, useRef } from 'react';
import { Circle, Group } from 'react-konva';
import type Konva from 'konva';
import type { ArrowElement, LineElement, Point, CanvasElement, SnapTarget, Binding } from '@/types';
import { useLinearEditStore } from '@/store/useLinearEditStore';
import { findNearestSnapTarget, computeBindingGap } from '@/utils/connection';
import { computeCurveControlPoint, quadBezierAt, curvatureFromDragPoint, CURVE_RATIO } from '@/utils/curve';
import { computePointsBounds } from '@/utils/geometry';

// ── Visual constants ──────────────────────────────────────────
const POINT_RADIUS = 4;
const MIDPOINT_RADIUS = 3;
const POINT_FILL = '#ffffff';
const POINT_STROKE = '#4f8df7';
const MIDPOINT_FILL = '#4f8df7';
const MIDPOINT_FILL_HOVER = '#2563eb';
const SELECTED_FILL = '#4f8df7';
const CURVE_HANDLE_RADIUS = 5;
const CURVE_HANDLE_FILL = '#ff6b35';
const CURVE_HANDLE_STROKE = '#ffffff';

// ── Helpers ───────────────────────────────────────────────────

/** Extract Point pairs from flat points array */
function getPointPairs(points: number[]): Point[] {
    const result: Point[] = [];
    for (let i = 0; i < points.length; i += 2) {
        result.push({ x: points[i], y: points[i + 1] });
    }
    return result;
}

/** Get midpoint of two points */
function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ── Props ─────────────────────────────────────────────────────
interface Props {
    element: LineElement | ArrowElement;
    /** All elements — needed for snap/binding detection on endpoint drag */
    allElements: CanvasElement[];
    /** Callback to update the element's points, position, bindings */
    onPointsChange: (
        id: string,
        updates: Partial<LineElement | ArrowElement>,
    ) => void;
    /** Callback for lightweight drag-move (no history) */
    onPointDragMove?: (
        id: string,
        updates: Partial<LineElement | ArrowElement>,
    ) => void;
    /** Callback when snap target changes during endpoint drag */
    onSnapTargetChange?: (target: SnapTarget | null) => void;
    /** Accent color */
    color?: string;
}

const LinearElementHandles: React.FC<Props> = ({
    element,
    allElements,
    onPointsChange,
    onPointDragMove,
    onSnapTargetChange,
    color = '#4f8df7',
}) => {
    const {
        selectedPointIndices,
        hoveredPointIndex,
        hoveredMidpointIndex,
        setSelectedPoints,
        togglePointSelection,
        setHoveredPoint,
        setHoveredMidpoint,
        setIsDraggingPoint,
    } = useLinearEditStore();

    const { id, x, y, points } = element;
    const pairs = getPointPairs(points);
    const dragStartRef = useRef<{ points: number[]; x: number; y: number } | null>(null);
    // Track the real cursor position (before snap override) so that
    // dragEnd can detect edge vs center zone correctly. Without this,
    // dragEnd reads the Konva node position which was snapped to the
    // shape edge in the last dragMove — making center binding impossible.
    const lastRawCursorRef = useRef<Point | null>(null);
    // Track previous snap isPrecise for hysteresis — prevents flickering
    // between edge/center mode when cursor jitters near the boundary.
    const lastSnapIsPreciseRef = useRef<boolean | undefined>(undefined);

    // Curved/elbow lines: only endpoints are editable — hide intermediate handles
    const isCurved = 'lineType' in element && element.lineType === 'curved';
    const isElbow = 'lineType' in element && element.lineType === 'elbow';
    const endpointsOnly = isCurved || isElbow;

    // ── Is this an endpoint? (index 0 or last) ────────────────
    const isEndpoint = useCallback(
        (idx: number) => idx === 0 || idx === pairs.length - 1,
        [pairs.length],
    );

    // ── Point Drag Start ──────────────────────────────────────
    const handlePointDragStart = useCallback(
        (idx: number) => {
            setIsDraggingPoint(true);
            // Save original state for reference
            dragStartRef.current = { points: [...points], x, y };
            // Reset hysteresis state for new drag
            lastSnapIsPreciseRef.current = undefined;

            // Auto-select the point being dragged
            if (!selectedPointIndices.includes(idx)) {
                setSelectedPoints([idx]);
            }
        },
        [points, x, y, selectedPointIndices, setSelectedPoints, setIsDraggingPoint],
    );

    // ── Point Drag Move ───────────────────────────────────────
    const handlePointDragMove = useCallback(
        (idx: number, e: Konva.KonvaEventObject<DragEvent>) => {
            const node = e.target;
            // node.x()/y() includes Konva's initial drag offset (distance from
            // click point to circle center, up to ~10px).  Fine for general
            // point positioning, but this offset distorts edge/center zone
            // detection — the cursor may be deep in the center zone while
            // node.x() reports a position still in the edge band.
            const nodeWorldX = node.x();
            const nodeWorldY = node.y();

            const newPoints = [...points];
            // Convert world → local (relative to element origin)
            newPoints[idx * 2] = nodeWorldX - x;
            newPoints[idx * 2 + 1] = nodeWorldY - y;

            // Collect preview binding updates for elbow routing accuracy
            const bindingUpdates: Partial<LineElement | ArrowElement> = {};

            // Endpoint binding detection
            if (isEndpoint(idx)) {
                // Use the ACTUAL pointer position from the Stage for snap detection.
                // This eliminates the Konva drag offset and gives accurate
                // edge/center zone detection — critical for small shapes where
                // the center zone may be only ~10-20px wide.
                const stage = node.getStage();
                const stagePointer = stage?.getRelativePointerPosition();
                const cursorX = stagePointer?.x ?? nodeWorldX;
                const cursorY = stagePointer?.y ?? nodeWorldY;

                // Save accurate cursor position for dragEnd snap detection.
                lastRawCursorRef.current = { x: cursorX, y: cursorY };

                const worldPt = { x: cursorX, y: cursorY };
                const excludeIds = new Set([id]);
                // Exclude the element bound on the OTHER end
                const otherBinding = idx === 0 ? element.endBinding : element.startBinding;
                if (otherBinding) excludeIds.add(otherBinding.elementId);

                // Auto-detect edge vs center zone: findNearestSnapTarget
                // automatically determines isPrecise based on cursor proximity
                // to shape edge vs center.
                const dragGap = computeBindingGap(element.style.strokeWidth ?? 2);
                const snap = findNearestSnapTarget(worldPt, allElements, 24, excludeIds, undefined, undefined, dragGap, lastSnapIsPreciseRef.current);
                onSnapTargetChange?.(snap);
                lastSnapIsPreciseRef.current = snap?.isPrecise;

                if (snap) {
                    // snap.position is always a valid edge point in both
                    // edge-mode and center-mode (computed by findNearestSnapTarget).
                    const snapPt = snap.position;
                    newPoints[idx * 2] = snapPt.x - x;
                    newPoints[idx * 2 + 1] = snapPt.y - y;
                    node.x(snapPt.x);
                    node.y(snapPt.y);

                    // Build preview binding so elbow routing can determine the
                    // correct entry/exit direction during drag.  Without this,
                    // the elbow preview path diverges from the final path that
                    // is computed once the binding is committed on drag end.
                    const previewBinding: Binding = {
                        elementId: snap.elementId,
                        fixedPoint: snap.fixedPoint,
                        gap: dragGap,
                        isPrecise: snap.isPrecise,
                    };
                    if (idx === 0) {
                        bindingUpdates.startBinding = previewBinding;
                    } else {
                        bindingUpdates.endBinding = previewBinding;
                    }
                } else {
                    // Cursor moved away from any shape — clear preview binding
                    if (idx === 0) {
                        bindingUpdates.startBinding = null;
                    } else {
                        bindingUpdates.endBinding = null;
                    }
                }
            }

            // Must send x,y along with points so the store stays in sync
            // with the resolved element origin (recomputeBoundPoints may
            // shift x,y for bound connectors).
            // Include bindingUpdates so elbow routing sees the correct
            // entry/exit direction during drag preview.
            onPointDragMove?.(id, { points: newPoints, x, y, ...bindingUpdates });
        },
        [points, x, y, id, element, allElements, isEndpoint, onPointDragMove, onSnapTargetChange],
    );

    // ── Point Drag End ────────────────────────────────────────
    const handlePointDragEnd = useCallback(
        (idx: number, e: Konva.KonvaEventObject<DragEvent>) => {
            setIsDraggingPoint(false);
            const node = e.target;

            // For endpoints: use the saved stage pointer (accurate cursor position)
            // for snap detection, since node.x()/y() at dragEnd is the snapped
            // edge position from the last dragMove.
            // For non-endpoints: use node.x()/y() directly (no snap to worry about).
            let worldX: number;
            let worldY: number;
            if (isEndpoint(idx) && lastRawCursorRef.current) {
                worldX = lastRawCursorRef.current.x;
                worldY = lastRawCursorRef.current.y;
            } else {
                worldX = node.x();
                worldY = node.y();
            }
            lastRawCursorRef.current = null;

            const newPoints = [...points];
            // Convert world → local (relative to element origin)
            newPoints[idx * 2] = worldX - x;
            newPoints[idx * 2 + 1] = worldY - y;

            const updates: Partial<LineElement | ArrowElement> = { points: newPoints };

            // Handle endpoint binding
            if (isEndpoint(idx)) {
                const worldPt = { x: worldX, y: worldY };
                const excludeIds = new Set([id]);
                const otherBinding = idx === 0 ? element.endBinding : element.startBinding;
                if (otherBinding) excludeIds.add(otherBinding.elementId);

                // Auto-detect edge vs center zone: findNearestSnapTarget
                // automatically determines isPrecise based on cursor proximity
                // to shape edge vs center.
                const endGap = computeBindingGap(element.style.strokeWidth ?? 2);
                const snap = findNearestSnapTarget(worldPt, allElements, 24, excludeIds, undefined, undefined, endGap, lastSnapIsPreciseRef.current);
                onSnapTargetChange?.(null);
                lastSnapIsPreciseRef.current = undefined;

                if (snap) {
                    const gap = computeBindingGap(element.style.strokeWidth ?? 2);
                    const binding: Binding = {
                        elementId: snap.elementId,
                        fixedPoint: snap.fixedPoint,
                        gap,
                        isPrecise: snap.isPrecise,
                    };
                    if (idx === 0) {
                        updates.startBinding = binding;
                    } else {
                        updates.endBinding = binding;
                    }

                    // snap.position is a valid edge point for both modes.
                    // recomputeBoundPoints will re-orient center-mode bindings
                    // to face the other endpoint after the binding is committed.
                    newPoints[idx * 2] = snap.position.x - x;
                    newPoints[idx * 2 + 1] = snap.position.y - y;
                    updates.points = newPoints;
                } else {
                    // Dragged away from any shape — unbind
                    if (idx === 0) {
                        updates.startBinding = null;
                    } else {
                        updates.endBinding = null;
                    }
                }
            }

            // Normalize: first point should be [0,0], adjust element position
            const finalPoints = updates.points as number[] ?? newPoints;
            const p0x = finalPoints[0];
            const p0y = finalPoints[1];
            if (p0x !== 0 || p0y !== 0) {
                const normalizedPoints: number[] = [];
                for (let i = 0; i < finalPoints.length; i += 2) {
                    normalizedPoints.push(finalPoints[i] - p0x, finalPoints[i + 1] - p0y);
                }
                updates.x = x + p0x;
                updates.y = y + p0y;
                updates.points = normalizedPoints;
            }

            // Update width/height from points bounding box
            const finalPts = updates.points as number[] ?? finalPoints;
            const bounds = computePointsBounds(finalPts);
            updates.width = bounds.width;
            updates.height = bounds.height;

            onPointsChange(id, updates);
            dragStartRef.current = null;
        },
        [points, x, y, id, pairs, element, allElements, isEndpoint, setIsDraggingPoint, onPointsChange, onSnapTargetChange],
    );

    // ── Point Click (select) ──────────────────────────────────
    const handlePointClick = useCallback(
        (idx: number, e: Konva.KonvaEventObject<MouseEvent>) => {
            e.cancelBubble = true;
            if (e.evt.shiftKey) {
                togglePointSelection(idx);
            } else {
                setSelectedPoints([idx]);
            }
        },
        [setSelectedPoints, togglePointSelection],
    );

    // ── Midpoint Click → insert new point ─────────────────────
    const handleMidpointClick = useCallback(
        (segmentIdx: number, e: Konva.KonvaEventObject<MouseEvent>) => {
            e.cancelBubble = true;

            // Compute the midpoint position
            const a = pairs[segmentIdx];
            const b = pairs[segmentIdx + 1];
            const mid = midpoint(a, b);

            // Insert new point at this position
            const insertIdx = segmentIdx + 1;
            const newPoints: number[] = [];
            for (let i = 0; i < pairs.length; i++) {
                newPoints.push(pairs[i].x, pairs[i].y);
                if (i === segmentIdx) {
                    newPoints.push(mid.x, mid.y);
                }
            }

            // Update width/height
            const bounds = computePointsBounds(newPoints);

            setSelectedPoints([insertIdx]);
            setHoveredMidpoint(null);

            // Update element with new point set (triggers re-render with new vertex)
            onPointsChange(id, {
                points: newPoints,
                width: bounds.width,
                height: bounds.height,
            });
        },
        [id, pairs, setSelectedPoints, setHoveredMidpoint, onPointsChange],
    );

    // ── Render ────────────────────────────────────────────────
    return (
        <Group>
            {/* Midpoint handles (between segments) — click to insert.
                Hidden for curved/elbow lines: only endpoints are relevant. */}
            {!endpointsOnly && pairs.length >= 2 &&
                pairs.slice(0, -1).map((pt, segIdx) => {
                    const next = pairs[segIdx + 1];
                    const mid = midpoint(pt, next);
                    const isHovered = hoveredMidpointIndex === segIdx;
                    return (
                        <Circle
                            key={`mid-${segIdx}`}
                            x={x + mid.x}
                            y={y + mid.y}
                            radius={MIDPOINT_RADIUS}
                            fill={isHovered ? MIDPOINT_FILL_HOVER : MIDPOINT_FILL}
                            opacity={isHovered ? 0.9 : 0.5}
                            stroke="white"
                            strokeWidth={1.5}
                            onMouseEnter={() => setHoveredMidpoint(segIdx)}
                            onMouseLeave={() => setHoveredMidpoint(null)}
                            onClick={(e) => handleMidpointClick(segIdx, e)}
                            onTap={(e) => handleMidpointClick(segIdx, e as unknown as Konva.KonvaEventObject<MouseEvent>)}
                            hitStrokeWidth={10}
                            perfectDrawEnabled={false}
                        />
                    );
                })}

            {/* Point handles — curved/elbow mode shows only endpoints */}
            {pairs.map((pt, idx) => {
                const isEnd = isEndpoint(idx);
                // Curved/elbow lines: skip intermediate point handles
                if (endpointsOnly && !isEnd) return null;

                const isSelected = selectedPointIndices.includes(idx);
                const isHovered = hoveredPointIndex === idx;
                const radius = isEnd ? POINT_RADIUS + 1 : POINT_RADIUS;

                return (
                    <Circle
                        key={`pt-${idx}`}
                        x={x + pt.x}
                        y={y + pt.y}
                        radius={radius}
                        fill={isSelected ? SELECTED_FILL : POINT_FILL}
                        stroke={isHovered || isSelected ? '#2563eb' : color}
                        strokeWidth={isSelected ? 2.5 : 2}
                        draggable
                        onMouseEnter={() => setHoveredPoint(idx)}
                        onMouseLeave={() => setHoveredPoint(-1)}
                        onClick={(e) => handlePointClick(idx, e)}
                        onTap={(e) => handlePointClick(idx, e as unknown as Konva.KonvaEventObject<MouseEvent>)}
                        onDragStart={() => handlePointDragStart(idx)}
                        onDragMove={(e) => handlePointDragMove(idx, e)}
                        onDragEnd={(e) => handlePointDragEnd(idx, e)}
                        hitStrokeWidth={10}
                        perfectDrawEnabled={false}
                    />
                );
            })}

            {/* Curve handle — appears at Bézier midpoint for curved lines.
                Drag to adjust the curvature (bend amount). */}
            {isCurved && pairs.length >= 2 && (() => {
                const localStart = pairs[0];
                const localEnd = pairs[pairs.length - 1];
                const curvature = (element as LineElement | ArrowElement).curvature ?? CURVE_RATIO;
                const cp = computeCurveControlPoint(localStart, localEnd, curvature);
                const curveMid = quadBezierAt(localStart, cp, localEnd, 0.5);

                return (
                    <Circle
                        key="curve-handle"
                        x={x + curveMid.x}
                        y={y + curveMid.y}
                        radius={CURVE_HANDLE_RADIUS}
                        fill={CURVE_HANDLE_FILL}
                        stroke={CURVE_HANDLE_STROKE}
                        strokeWidth={2}
                        draggable
                        onDragStart={() => setIsDraggingPoint(true)}
                        onDragMove={(e) => {
                            const node = e.target;
                            const startWorld = { x: x + localStart.x, y: y + localStart.y };
                            const endWorld = { x: x + localEnd.x, y: y + localEnd.y };
                            const dragWorld = { x: node.x(), y: node.y() };
                            const newCurvature = curvatureFromDragPoint(startWorld, endWorld, dragWorld);
                            // Force-reset node position to the correct B(0.5) for this curvature.
                            // This prevents Konva's internal drag state from fighting with
                            // React's declarative x/y props (which would cause oscillation).
                            const newCp = computeCurveControlPoint(localStart, localEnd, newCurvature);
                            const newMid = quadBezierAt(localStart, newCp, localEnd, 0.5);
                            node.x(x + newMid.x);
                            node.y(y + newMid.y);
                            onPointDragMove?.(id, { curvature: newCurvature } as Partial<LineElement | ArrowElement>);
                        }}
                        onDragEnd={(e) => {
                            setIsDraggingPoint(false);
                            const node = e.target;
                            const startWorld = { x: x + localStart.x, y: y + localStart.y };
                            const endWorld = { x: x + localEnd.x, y: y + localEnd.y };
                            const dragWorld = { x: node.x(), y: node.y() };
                            const newCurvature = curvatureFromDragPoint(startWorld, endWorld, dragWorld);
                            // Force-reset so Konva releases drag at the correct position
                            const newCp = computeCurveControlPoint(localStart, localEnd, newCurvature);
                            const newMid = quadBezierAt(localStart, newCp, localEnd, 0.5);
                            node.x(x + newMid.x);
                            node.y(y + newMid.y);
                            onPointsChange(id, { curvature: newCurvature } as Partial<LineElement | ArrowElement>);
                        }}
                        hitStrokeWidth={12}
                        perfectDrawEnabled={false}
                    />
                );
            })()}
        </Group>
    );
};

export default React.memo(LinearElementHandles);
