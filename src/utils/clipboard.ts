/**
 * clipboard.ts — Shared clipboard for copy/paste across components.
 * Module-level storage so both keyboard shortcuts and context menu
 * reference the same clipboard state.
 *
 * Uses structuredClone for deep-copying to prevent shared reference issues
 * between clipboard data and live canvas elements.
 */
import type { CanvasElement } from '@/types';

let clipboard: CanvasElement[] = [];

export function setClipboard(elements: CanvasElement[]): void {
    // Deep-clone to avoid shared references on nested objects
    // (style, points, boundElements, bindings, groupIds, etc.)
    clipboard = structuredClone(elements);
}

export function getClipboard(): CanvasElement[] {
    // Return a deep copy so callers cannot mutate internal clipboard state
    return structuredClone(clipboard);
}

export function hasClipboardContent(): boolean {
    return clipboard.length > 0;
}
