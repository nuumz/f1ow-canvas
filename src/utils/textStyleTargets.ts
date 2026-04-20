import type { CanvasElement } from '@/types';

/**
 * Resolve text element ids that should receive font style updates.
 * Includes directly selected text elements and bound text from selected containers.
 */
export function collectTextStyleTargetIds(selectedIds: string[], elements: CanvasElement[]): string[] {
    const textIds = new Set<string>();

    selectedIds.forEach((id) => {
        const el = elements.find((e) => e.id === id);
        if (!el) return;

        if (el.type === 'text') {
            textIds.add(el.id);
            return;
        }

        el.boundElements?.forEach((be) => {
            if (be.type === 'text') textIds.add(be.id);
        });
    });

    return Array.from(textIds);
}
