/**
 * selection.ts — Pure helpers for canvas selection updates.
 *
 * Extracted so additive (Shift/Cmd) toggle logic can be unit-tested
 * without mounting FlowCanvas.
 */
import type { CanvasElement } from '@/types';

/**
 * Resolve the set of element IDs that a click on `clickedId` should target.
 * Grouped elements expand to the outermost group membership.
 */
export function resolveClickTargetIds(
    elements: CanvasElement[],
    clickedId: string,
): string[] {
    const el = elements.find((e) => e.id === clickedId);
    if (!el) return [];

    if (el.groupIds?.length) {
        const outermostGroupId = el.groupIds[el.groupIds.length - 1];
        return elements
            .filter((e) => e.groupIds?.includes(outermostGroupId))
            .map((e) => e.id);
    }
    return [clickedId];
}

/**
 * Compute the next `selectedIds` after clicking an element.
 *
 * When `additive` is true (Shift or Cmd/Ctrl), toggle the target id(s)
 * in/out of the current selection. Otherwise replace the selection.
 */
export function computeNextSelection(
    elements: CanvasElement[],
    currentSelectedIds: string[],
    clickedId: string,
    additive: boolean,
): string[] {
    const targetIds = resolveClickTargetIds(elements, clickedId);
    if (targetIds.length === 0) return currentSelectedIds;

    if (!additive) return targetIds;

    const current = new Set(currentSelectedIds);
    const allSelected = targetIds.every((id) => current.has(id));
    if (allSelected) {
        for (const id of targetIds) current.delete(id);
    } else {
        for (const id of targetIds) current.add(id);
    }
    return Array.from(current);
}
