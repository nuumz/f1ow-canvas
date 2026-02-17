import React, { useEffect, useCallback } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useLinearEditStore } from '@/store/useLinearEditStore';
import type { ToolType, LineElement, ArrowElement } from '@/types';
import { generateId } from '@/utils/id';
import { setClipboard, getClipboard } from '@/utils/clipboard';
import { cloneAndRemapElements, gatherElementsForCopy } from '@/utils/clone';
import { GRID_SIZE } from '@/constants';

/**
 * Keyboard shortcuts handler — canvas-standard hotkeys
 * @param enabled - Whether shortcuts are active (false = hooks still called, events ignored)
 * @param containerRef - Optional ref to canvas container (needed for zoomToFit/zoomToSelection)
 */
export function useKeyboardShortcuts(
    enabled: boolean = true,
    containerRef?: React.RefObject<HTMLDivElement | null>,
) {
    // Granular selectors — actions are stable references, data triggers re-hook only when changed
    const setActiveTool = useCanvasStore((s) => s.setActiveTool);
    const undo = useCanvasStore((s) => s.undo);
    const redo = useCanvasStore((s) => s.redo);
    const selectedIds = useCanvasStore((s) => s.selectedIds);
    const elements = useCanvasStore((s) => s.elements);
    const deleteElements = useCanvasStore((s) => s.deleteElements);
    const duplicateElements = useCanvasStore((s) => s.duplicateElements);
    const bringToFront = useCanvasStore((s) => s.bringToFront);
    const sendToBack = useCanvasStore((s) => s.sendToBack);
    const bringForward = useCanvasStore((s) => s.bringForward);
    const sendBackward = useCanvasStore((s) => s.sendBackward);
    const toggleGrid = useCanvasStore((s) => s.toggleGrid);
    const showGrid = useCanvasStore((s) => s.showGrid);
    const zoomIn = useCanvasStore((s) => s.zoomIn);
    const zoomOut = useCanvasStore((s) => s.zoomOut);
    const resetZoom = useCanvasStore((s) => s.resetZoom);
    const zoomToFit = useCanvasStore((s) => s.zoomToFit);
    const zoomToSelection = useCanvasStore((s) => s.zoomToSelection);
    const clearSelection = useCanvasStore((s) => s.clearSelection);
    const updateElement = useCanvasStore((s) => s.updateElement);
    const addElement = useCanvasStore((s) => s.addElement);
    const setSelectedIds = useCanvasStore((s) => s.setSelectedIds);
    const pushHistory = useCanvasStore((s) => s.pushHistory);

    const linearEdit = useLinearEditStore();

    // ─── Copy selected elements ──────────────────────────────
    const copyElements = useCallback(() => {
        if (selectedIds.length === 0) return;
        setClipboard(gatherElementsForCopy(selectedIds, elements));
    }, [selectedIds, elements]);

    // ─── Paste from shared clipboard ─────────────────────────
    const pasteElements = useCallback(() => {
        const clip = getClipboard();
        if (clip.length === 0) return;
        const PASTE_OFFSET = 20;
        const { clones, selectedCloneIds } = cloneAndRemapElements(clip, clip, PASTE_OFFSET);
        clones.forEach((el) => addElement(el));
        setSelectedIds(selectedCloneIds.length > 0 ? selectedCloneIds : clones.map((c) => c.id));
        pushHistory();
        // Shift clipboard for cascading paste
        setClipboard(
            clip.map((el) => ({ ...el, x: el.x + PASTE_OFFSET, y: el.y + PASTE_OFFSET })),
        );
    }, [addElement, setSelectedIds, pushHistory]);

    // ─── Nudge selected elements by arrow keys ───────────────
    const nudge = useCallback(
        (dx: number, dy: number) => {
            if (selectedIds.length === 0) return;
            selectedIds.forEach((id) => {
                const el = elements.find((e) => e.id === id);
                if (el && !el.isLocked) {
                    updateElement(id, { x: el.x + dx, y: el.y + dy });
                }
            });
            pushHistory();
        },
        [selectedIds, elements, updateElement, pushHistory],
    );

    useEffect(() => {
        if (!enabled) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Skip if typing in an input/textarea
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            const isCmd = e.metaKey || e.ctrlKey;

            // ─── Tool Shortcuts ──────────────────────────────────
            if (!isCmd && !e.shiftKey) {
                const toolMap: Record<string, ToolType> = {
                    v: 'select',
                    h: 'hand',
                    r: 'rectangle',
                    o: 'ellipse',
                    d: 'diamond',
                    l: 'line',
                    a: 'arrow',
                    p: 'freedraw',
                    t: 'text',
                    i: 'image',
                    e: 'eraser',
                };
                const tool = toolMap[e.key.toLowerCase()];
                if (tool) {
                    e.preventDefault();
                    setActiveTool(tool);
                    return;
                }
            }

            // ─── Undo/Redo ───────────────────────────────────────
            if (isCmd && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
                return;
            }
            if (isCmd && e.key === 'z' && e.shiftKey) {
                e.preventDefault();
                redo();
                return;
            }
            if (isCmd && e.key === 'y') {
                e.preventDefault();
                redo();
                return;
            }

            // ─── Delete ───────────────────────────────────────────
            if ((e.key === 'Delete' || e.key === 'Backspace') && !isCmd) {
                // Linear edit mode: delete selected points
                if (linearEdit.isEditing && linearEdit.selectedPointIndices.length > 0) {
                    e.preventDefault();
                    const { elements, updateElement, pushHistory } = useCanvasStore.getState();
                    const el = elements.find((e) => e.id === linearEdit.elementId) as LineElement | ArrowElement | undefined;
                    if (el) {
                        const pointCount = el.points.length / 2;
                        // Must keep at least 2 points
                        const indicesToDelete = new Set(linearEdit.selectedPointIndices);
                        const remaining = pointCount - indicesToDelete.size;
                        if (remaining >= 2) {
                            const newPoints: number[] = [];
                            for (let i = 0; i < pointCount; i++) {
                                if (!indicesToDelete.has(i)) {
                                    newPoints.push(el.points[i * 2], el.points[i * 2 + 1]);
                                }
                            }
                            // Normalize: first point at [0,0]
                            const p0x = newPoints[0];
                            const p0y = newPoints[1];
                            const normalizedPoints: number[] = [];
                            for (let i = 0; i < newPoints.length; i += 2) {
                                normalizedPoints.push(newPoints[i] - p0x, newPoints[i + 1] - p0y);
                            }
                            // Compute bounding box from normalized points
                            let minX = 0, maxX = 0, minY = 0, maxY = 0;
                            for (let i = 0; i < normalizedPoints.length; i += 2) {
                                minX = Math.min(minX, normalizedPoints[i]);
                                maxX = Math.max(maxX, normalizedPoints[i]);
                                minY = Math.min(minY, normalizedPoints[i + 1]);
                                maxY = Math.max(maxY, normalizedPoints[i + 1]);
                            }
                            // Clear deleted endpoint bindings in same update
                            const pointUpdates: Partial<LineElement | ArrowElement> = {
                                x: el.x + p0x,
                                y: el.y + p0y,
                                points: normalizedPoints,
                                width: maxX - minX,
                                height: maxY - minY,
                            };
                            if (indicesToDelete.has(0)) {
                                pointUpdates.startBinding = null;
                            }
                            if (indicesToDelete.has(pointCount - 1)) {
                                pointUpdates.endBinding = null;
                            }
                            updateElement(el.id, pointUpdates);
                            pushHistory();
                            linearEdit.setSelectedPoints([]);
                        }
                    }
                    return;
                }

                if (selectedIds.length > 0) {
                    e.preventDefault();
                    // Skip locked elements — only delete unlocked
                    const unlocked = selectedIds.filter((sid) => {
                        const el = elements.find((e) => e.id === sid);
                        return el && !el.isLocked;
                    });
                    if (unlocked.length > 0) deleteElements(unlocked);
                }
                return;
            }

            // ─── Duplicate ────────────────────────────────────────
            if (isCmd && e.key === 'd') {
                e.preventDefault();
                if (selectedIds.length > 0) {
                    duplicateElements(selectedIds);
                }
                return;
            }

            // ─── Layer Order ──────────────────────────────────────
            if (e.key === ']' && isCmd && e.shiftKey) {
                e.preventDefault();
                bringToFront(selectedIds);
                return;
            }
            if (e.key === '[' && isCmd && e.shiftKey) {
                e.preventDefault();
                sendToBack(selectedIds);
                return;
            }
            if (e.key === ']' && isCmd && !e.shiftKey) {
                e.preventDefault();
                bringForward(selectedIds);
                return;
            }
            if (e.key === '[' && isCmd && !e.shiftKey) {
                e.preventDefault();
                sendBackward(selectedIds);
                return;
            }

            // ─── Grid Toggle ─────────────────────────────────────
            if (e.key === 'g' && !isCmd) {
                e.preventDefault();
                toggleGrid();
                return;
            }

            // ─── Zoom ─────────────────────────────────────────────
            if (isCmd && (e.key === '=' || e.key === '+')) {
                e.preventDefault();
                zoomIn();
                return;
            }
            if (isCmd && e.key === '-') {
                e.preventDefault();
                zoomOut();
                return;
            }
            if (isCmd && e.key === '0') {
                e.preventDefault();
                resetZoom();
                return;
            }

            // ─── Zoom to Fit / Zoom to Selection ─────────────────
            if (isCmd && e.shiftKey && e.key === '1') {
                e.preventDefault();
                if (containerRef?.current) {
                    const rect = containerRef.current.getBoundingClientRect();
                    zoomToFit(rect.width, rect.height, undefined, { animate: true });
                }
                return;
            }
            if (isCmd && e.shiftKey && e.key === '2') {
                e.preventDefault();
                if (containerRef?.current) {
                    const rect = containerRef.current.getBoundingClientRect();
                    zoomToSelection(rect.width, rect.height, { animate: true });
                }
                return;
            }

            // ─── Arrow Key Nudge ──────────────────────────────────
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isCmd) {
                if (selectedIds.length > 0 && !linearEdit.isEditing) {
                    e.preventDefault();
                    const baseStep = showGrid ? GRID_SIZE : 1;
                    const step = e.shiftKey ? baseStep * 10 : baseStep;
                    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                    nudge(dx, dy);
                    return;
                }
            }

            // ─── Copy / Paste / Cut ──────────────────────────────
            if (isCmd && e.key === 'c') {
                if (selectedIds.length > 0) {
                    e.preventDefault();
                    copyElements();
                }
                return;
            }
            // Cmd+V is handled by the 'paste' event listener in FlowCanvas
            // (supports both image-from-clipboard and element paste).
            // Do NOT preventDefault here — the browser must fire the paste event.
            if (isCmd && e.key === 'v') {
                return;
            }
            if (isCmd && e.key === 'x') {
                if (selectedIds.length > 0) {
                    e.preventDefault();
                    copyElements();
                    deleteElements(selectedIds);
                }
                return;
            }

            // ─── Group / Ungroup ──────────────────────────────────
            if (isCmd && e.key === 'g' && !e.shiftKey) {
                e.preventDefault();
                if (selectedIds.length >= 2) {
                    const { groupElements } = useCanvasStore.getState();
                    groupElements(selectedIds);
                }
                return;
            }
            if (isCmd && e.key === 'g' && e.shiftKey) {
                e.preventDefault();
                if (selectedIds.length > 0) {
                    const { ungroupElements } = useCanvasStore.getState();
                    ungroupElements(selectedIds);
                }
                return;
            }

            // ─── Lock / Unlock Toggle ─────────────────────────────
            if (isCmd && e.shiftKey && e.key === 'l') {
                e.preventDefault();
                if (selectedIds.length > 0) {
                    const { toggleLockElements } = useCanvasStore.getState();
                    toggleLockElements(selectedIds);
                }
                return;
            }

            // ─── Escape ───────────────────────────────────────────
            if (e.key === 'Escape') {
                e.preventDefault();
                // Exit linear edit mode first, then clear selection
                if (linearEdit.isEditing) {
                    linearEdit.exitEditMode();
                    return;
                }
                clearSelection();
                setActiveTool('select');
                return;
            }

            // ─── Select All ───────────────────────────────────────
            if (isCmd && e.key === 'a') {
                e.preventDefault();
                const { elements, setSelectedIds } = useCanvasStore.getState();
                setSelectedIds(elements.map((el) => el.id));
                return;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        enabled,
        setActiveTool,
        undo,
        redo,
        selectedIds,
        elements,
        deleteElements,
        duplicateElements,
        bringToFront,
        sendToBack,
        bringForward,
        sendBackward,
        toggleGrid,
        showGrid,
        zoomIn,
        zoomOut,
        resetZoom,
        zoomToFit,
        zoomToSelection,
        containerRef,
        clearSelection,
        linearEdit,
        nudge,
        copyElements,
        pasteElements,
    ]);
}
