import React, { useEffect, useCallback } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useLinearEditStore } from '@/store/useLinearEditStore';
import type { ToolType, LineElement, ArrowElement } from '@/types';
import { setClipboard } from '@/utils/clipboard';
import { gatherElementsForCopy } from '@/utils/clone';
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
    // ─── Copy selected elements (lazy state read) ────────────
    const copyElements = useCallback(() => {
        const { selectedIds, elements } = useCanvasStore.getState();
        if (selectedIds.length === 0) return;
        setClipboard(gatherElementsForCopy(selectedIds, elements));
    }, []);

    // ─── Nudge selected elements by arrow keys (lazy state read) ─
    const nudge = useCallback(
        (dx: number, dy: number) => {
            const { selectedIds, elements, updateElement, pushHistory } = useCanvasStore.getState();
            if (selectedIds.length === 0) return;
            selectedIds.forEach((id) => {
                const el = elements.find((e) => e.id === id);
                if (el && !el.isLocked) {
                    updateElement(id, { x: el.x + dx, y: el.y + dy });
                }
            });
            pushHistory();
        },
        [],
    );

    useEffect(() => {
        if (!enabled) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Skip if typing in an input/textarea
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            const isCmd = e.metaKey || e.ctrlKey;

            // Lazy state reads — avoids re-attaching this listener on every
            // elements/selectedIds change. Actions are stable Zustand refs.
            const store = useCanvasStore.getState();
            const linearEdit = useLinearEditStore.getState();

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
                    store.setActiveTool(tool);
                    return;
                }
            }

            // ─── Undo/Redo ───────────────────────────────────────
            if (isCmd && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                store.undo();
                return;
            }
            if (isCmd && e.key === 'z' && e.shiftKey) {
                e.preventDefault();
                store.redo();
                return;
            }
            if (isCmd && e.key === 'y') {
                e.preventDefault();
                store.redo();
                return;
            }

            // ─── Delete ───────────────────────────────────────────
            if ((e.key === 'Delete' || e.key === 'Backspace') && !isCmd) {
                // Linear edit mode: delete selected points
                if (linearEdit.isEditing && linearEdit.selectedPointIndices.length > 0) {
                    e.preventDefault();
                    const el = store.elements.find((e) => e.id === linearEdit.elementId) as LineElement | ArrowElement | undefined;
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
                            store.updateElement(el.id, pointUpdates);
                            store.pushHistory();
                            linearEdit.setSelectedPoints([]);
                        }
                    }
                    return;
                }

                if (store.selectedIds.length > 0) {
                    e.preventDefault();
                    // Skip locked elements — only delete unlocked
                    const unlocked = store.selectedIds.filter((sid) => {
                        const el = store.elements.find((e) => e.id === sid);
                        return el && !el.isLocked;
                    });
                    if (unlocked.length > 0) store.deleteElements(unlocked);
                }
                return;
            }

            // ─── Duplicate ────────────────────────────────────────
            if (isCmd && e.key === 'd') {
                e.preventDefault();
                if (store.selectedIds.length > 0) {
                    store.duplicateElements(store.selectedIds);
                }
                return;
            }

            // ─── Layer Order ──────────────────────────────────────
            if (e.key === ']' && isCmd && e.shiftKey) {
                e.preventDefault();
                store.bringToFront(store.selectedIds);
                return;
            }
            if (e.key === '[' && isCmd && e.shiftKey) {
                e.preventDefault();
                store.sendToBack(store.selectedIds);
                return;
            }
            if (e.key === ']' && isCmd && !e.shiftKey) {
                e.preventDefault();
                store.bringForward(store.selectedIds);
                return;
            }
            if (e.key === '[' && isCmd && !e.shiftKey) {
                e.preventDefault();
                store.sendBackward(store.selectedIds);
                return;
            }

            // ─── Grid Toggle ─────────────────────────────────────
            if (e.key === 'g' && !isCmd) {
                e.preventDefault();
                store.toggleGrid();
                return;
            }

            // ─── Zoom ─────────────────────────────────────────────
            if (isCmd && (e.key === '=' || e.key === '+')) {
                e.preventDefault();
                store.zoomIn();
                return;
            }
            if (isCmd && e.key === '-') {
                e.preventDefault();
                store.zoomOut();
                return;
            }
            if (isCmd && e.key === '0') {
                e.preventDefault();
                store.resetZoom();
                return;
            }

            // ─── Zoom to Fit / Zoom to Selection ─────────────────
            if (isCmd && e.shiftKey && e.key === '1') {
                e.preventDefault();
                if (containerRef?.current) {
                    const rect = containerRef.current.getBoundingClientRect();
                    store.zoomToFit(rect.width, rect.height, undefined, { animate: true });
                }
                return;
            }
            if (isCmd && e.shiftKey && e.key === '2') {
                e.preventDefault();
                if (containerRef?.current) {
                    const rect = containerRef.current.getBoundingClientRect();
                    store.zoomToSelection(rect.width, rect.height, { animate: true });
                }
                return;
            }

            // ─── Arrow Key Nudge ──────────────────────────────────
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isCmd) {
                if (store.selectedIds.length > 0 && !linearEdit.isEditing) {
                    e.preventDefault();
                    const baseStep = store.showGrid ? GRID_SIZE : 1;
                    const step = e.shiftKey ? baseStep * 10 : baseStep;
                    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                    nudge(dx, dy);
                    return;
                }
            }

            // ─── Copy / Paste / Cut ──────────────────────────────
            if (isCmd && e.key === 'c') {
                if (store.selectedIds.length > 0) {
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
                if (store.selectedIds.length > 0) {
                    e.preventDefault();
                    copyElements();
                    store.deleteElements(store.selectedIds);
                }
                return;
            }

            // ─── Group / Ungroup ──────────────────────────────────
            if (isCmd && e.key === 'g' && !e.shiftKey) {
                e.preventDefault();
                if (store.selectedIds.length >= 2) {
                    store.groupElements(store.selectedIds);
                }
                return;
            }
            if (isCmd && e.key === 'g' && e.shiftKey) {
                e.preventDefault();
                if (store.selectedIds.length > 0) {
                    store.ungroupElements(store.selectedIds);
                }
                return;
            }

            // ─── Lock / Unlock Toggle ─────────────────────────────
            if (isCmd && e.shiftKey && e.key === 'l') {
                e.preventDefault();
                if (store.selectedIds.length > 0) {
                    store.toggleLockElements(store.selectedIds);
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
                store.clearSelection();
                store.setActiveTool('select');
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
    }, [enabled, containerRef, nudge, copyElements]);
}
