/**
 * LinearTool.ts
 * Handles line and arrow creation with snap-to-shape binding.
 * Supports start/end binding, angle constraint (Shift), and grid snapping.
 */
import type { ToolHandler, ToolContext } from './BaseTool';
import type Konva from 'konva';
import type { Point, LineElement, ArrowElement, Binding, CanvasElement } from '@/types';
import { generateId } from '@/utils/id';
import { constrainLineAngle } from '@/utils/geometry';
import {
    findNearestSnapTarget,
    getEdgePoint,
    recomputeBoundPoints,
    syncBoundElements,
    computeBindingGap,
    getEdgePointFromFixedPoint,
} from '@/utils/connection';
import { useCanvasStore } from '@/store/useCanvasStore';

/**
 * Module-level variable to track the last raw cursor position during drawing.
 * onMouseUp does not receive `pos` — it reads the endpoint from the element state,
 * which has already been snapped to the shape edge by onMouseMove.
 * This variable preserves the actual cursor position so onMouseUp can use it
 * for correct edge vs center zone detection.
 */
let _lastRawEndPos: Point | null = null;

/**
 * Track the previous snap's isPrecise state for hysteresis.
 * Prevents edge/center mode flickering at the boundary during drawing.
 */
let _lastSnapIsPrecise: boolean | undefined = undefined;

export const linearTool: ToolHandler = {
    name: 'line', // also handles 'arrow'

    onMouseDown(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        ctx.setIsDrawing(true);
        const sp = ctx.snapPos(pos);
        ctx.setDrawStart(sp);
        ctx.clearSelection();

        const id = generateId();
        ctx.currentElementIdRef.current = id;

        // Snap start to nearby shape anchor
        const gap = computeBindingGap(ctx.currentStyle.strokeWidth ?? 2);
        const snap = findNearestSnapTarget(pos, ctx.elements, 24, undefined, undefined, undefined, gap);
        let startPt = pos;
        let startBind: Binding | null = null;

        // Reset hysteresis state for new drawing
        _lastSnapIsPrecise = undefined;

        if (snap) {
            startPt = snap.position;
            startBind = { elementId: snap.elementId, fixedPoint: snap.fixedPoint, gap, isPrecise: snap.isPrecise };
        } else {
            startPt = sp;
        }

        ctx.startBindingRef.current = startBind;

        // Pause history so addElement does NOT push an intermediate snapshot
        // with points:[0,0,0,0]. A single clean entry is pushed in onMouseUp.
        useCanvasStore.getState().pauseHistory();

        const base = {
            id,
            x: startPt.x,
            y: startPt.y,
            width: 0,
            height: 0,
            rotation: 0,
            style: { ...ctx.currentStyle },
            isLocked: false,
            isVisible: true,
            boundElements: null,
            points: [0, 0, 0, 0],
            startBinding: startBind,
            endBinding: null,
        };

        // Read current defaults from store
        const { currentLineType, currentStartArrowhead, currentEndArrowhead } = useCanvasStore.getState();

        const el: CanvasElement = ctx.activeTool === 'arrow'
            ? { ...base, type: 'arrow', startArrowhead: currentStartArrowhead, endArrowhead: currentEndArrowhead, lineType: currentLineType } as ArrowElement
            : { ...base, type: 'line', lineType: currentLineType } as LineElement;

        ctx.addElement(el);
        ctx.onElementCreate?.(el);
    },

    onMouseMove(_e: Konva.KonvaEventObject<MouseEvent | TouchEvent>, pos: Point, ctx: ToolContext) {
        // Show snap preview when hovering (before drawing)
        if (!ctx.isDrawing) {
            const hoverGap = computeBindingGap(ctx.currentStyle.strokeWidth ?? 2);
            const snap = findNearestSnapTarget(pos, ctx.elements, 24, undefined, undefined, undefined, hoverGap);
            ctx.setSnapTarget(snap);
            return;
        }

        if (!ctx.currentElementIdRef.current) return;

        const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as LineElement | ArrowElement | undefined;
        if (!el) return;

        // Save the raw cursor position BEFORE snapping.
        // onMouseUp will use this to correctly detect edge vs center zone.
        _lastRawEndPos = pos;

        // Snap detection for end point
        const excludeIds = new Set([el.id]);
        if (el.startBinding) excludeIds.add(el.startBinding.elementId);
        const endGap = computeBindingGap(el.style.strokeWidth ?? 2);
        const snap = findNearestSnapTarget(
            pos, ctx.elements, 24, excludeIds,
            { x: el.x, y: el.y },
            undefined, endGap,
            _lastSnapIsPrecise,
        );
        ctx.setSnapTarget(snap);
        _lastSnapIsPrecise = snap?.isPrecise;

        // Apply Shift-constrained angle when no binding snap
        let endPt = snap ? snap.position : ctx.snapPos(pos);
        if (!snap && ctx.shiftKeyRef.current) {
            endPt = constrainLineAngle({ x: el.x, y: el.y }, endPt);
        }

        // Build a temporary endBinding for accurate elbow preview.
        // Without this, elbow routing can't determine the correct entry
        // direction during drawing, causing the preview path to differ
        // from the final path.
        const previewEndBinding: Binding | null = snap
            ? { elementId: snap.elementId, fixedPoint: snap.fixedPoint, gap: endGap, isPrecise: snap.isPrecise }
            : null;

        const dx = endPt.x - el.x;
        const dy = endPt.y - el.y;

        // If start is bound, recompute start edge point toward end
        if (el.startBinding) {
            const startEl = ctx.elements.find((e) => e.id === el.startBinding!.elementId);
            if (startEl) {
                let startEdgePt: Point;
                if (el.startBinding.isPrecise) {
                    startEdgePt = getEdgePointFromFixedPoint(startEl, el.startBinding.fixedPoint, el.startBinding.gap);
                } else {
                    startEdgePt = getEdgePoint(startEl, endPt, el.startBinding.gap);
                }
                const newDx = endPt.x - startEdgePt.x;
                const newDy = endPt.y - startEdgePt.y;
                ctx.updateElement(el.id, {
                    x: startEdgePt.x,
                    y: startEdgePt.y,
                    points: [0, 0, newDx, newDy],
                    width: Math.abs(newDx),
                    height: Math.abs(newDy),
                    endBinding: previewEndBinding,
                });
                return;
            }
        }

        ctx.updateElement(el.id, {
            points: [0, 0, dx, dy],
            width: Math.abs(dx),
            height: Math.abs(dy),
            endBinding: previewEndBinding,
        });
    },

    onMouseUp(ctx: ToolContext) {
        if (!ctx.currentElementIdRef.current) return;

        const el = ctx.elements.find((e) => e.id === ctx.currentElementIdRef.current) as LineElement | ArrowElement | undefined;
        if (el) {
            const pts = el.points;
            const segLen = Math.sqrt(
                (pts[pts.length - 2] - pts[0]) ** 2 +
                (pts[pts.length - 1] - pts[1]) ** 2,
            );

            // Delete degenerate (zero-length) lines
            if (segLen < 2) {
                // Resume before deleteElements (its internal pushHistory will find
                // no diff since the element was added while history was paused).
                useCanvasStore.getState().resumeHistory();
                ctx.deleteElements([ctx.currentElementIdRef.current]);
                ctx.currentElementIdRef.current = null;
                ctx.startBindingRef.current = null;
                ctx.setSnapTarget(null);
                _lastRawEndPos = null;
                _lastSnapIsPrecise = undefined;
            } else {
                // Use the raw cursor position for snap detection, NOT the already-snapped
                // endpoint from the element state. The element endpoint was snapped to the
                // shape edge in onMouseMove, which would always resolve to edge binding.
                // Using the raw position allows center detection when the cursor is deep
                // inside a shape.
                const rawEndPos = _lastRawEndPos ?? {
                    x: el.x + pts[pts.length - 2],
                    y: el.y + pts[pts.length - 1],
                };
                const excludeIds = new Set([el.id]);
                if (el.startBinding) excludeIds.add(el.startBinding.elementId);
                const endGapFinal = computeBindingGap(el.style.strokeWidth ?? 2);
                const endSnap = findNearestSnapTarget(rawEndPos, ctx.elements, 24, excludeIds, undefined, undefined, endGapFinal, _lastSnapIsPrecise);

                const endGap = computeBindingGap(el.style.strokeWidth ?? 2);
                const endBind: Binding | null = endSnap
                    ? { elementId: endSnap.elementId, fixedPoint: endSnap.fixedPoint, gap: endGap, isPrecise: endSnap.isPrecise }
                    : null;
                const startBind = el.startBinding ?? ctx.startBindingRef.current;
                const finalEndBind =
                    endBind && startBind && endBind.elementId === startBind.elementId
                        ? null
                        : endBind;

                const finalPts = [...pts];
                if (endSnap) {
                    finalPts[finalPts.length - 2] = endSnap.position.x - el.x;
                    finalPts[finalPts.length - 1] = endSnap.position.y - el.y;
                }

                const updates: Partial<LineElement | ArrowElement> = {
                    points: finalPts,
                    width: Math.abs(finalPts[finalPts.length - 2] - finalPts[0]),
                    height: Math.abs(finalPts[finalPts.length - 1] - finalPts[1]),
                    startBinding: startBind,
                    endBinding: finalEndBind,
                };

                const tempEl = { ...el, ...updates } as LineElement | ArrowElement;
                const recomputed = recomputeBoundPoints(tempEl, ctx.elements);
                if (recomputed) Object.assign(updates, recomputed);

                ctx.updateElement(el.id, updates);

                // Sync bidirectional boundElements on target shapes
                const connType = el.type as 'arrow' | 'line';
                const fresh1 = useCanvasStore.getState().elements;
                syncBoundElements(el.id, connType, null, startBind, fresh1, ctx.updateElement);
                const fresh2 = useCanvasStore.getState().elements;
                syncBoundElements(el.id, connType, null, finalEndBind, fresh2, ctx.updateElement);

                ctx.startBindingRef.current = null;
                ctx.setSnapTarget(null);

                ctx.setSelectedIds([ctx.currentElementIdRef.current!]);
                // Resume history then push one single atomic entry for the whole draw.
                useCanvasStore.getState().resumeHistory();
                ctx.pushHistory();
            }
        }

        _lastRawEndPos = null;
        _lastSnapIsPrecise = undefined;
        // Safety: ensure history is never left paused (e.g. if el was not found).
        useCanvasStore.getState().resumeHistory();
        ctx.setIsDrawing(false);
        ctx.setDrawStart(null);
        ctx.currentElementIdRef.current = null;
        ctx.setActiveTool('select');
    },

    getCursor() {
        return 'crosshair';
    },
};
