import { describe, expect, it } from 'vitest';

import type { CanvasElement, ElementStyle, RectangleElement, TextElement } from '@/types';
import { collectTextStyleTargetIds } from '@/utils/textStyleTargets';

const baseStyle: ElementStyle = {
    strokeColor: '#111111',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    strokeStyle: 'solid',
    roughness: 0,
    fontSize: 20,
    fontFamily: 'system-ui',
};

function makeRectangle(id: string, boundTextIds: string[] = []): RectangleElement {
    return {
        id,
        type: 'rectangle',
        x: 10,
        y: 10,
        width: 120,
        height: 60,
        rotation: 0,
        style: { ...baseStyle },
        isLocked: false,
        isVisible: true,
        boundElements: boundTextIds.map((textId) => ({ id: textId, type: 'text' as const })),
        cornerRadius: 0,
        version: 0,
    };
}

function makeText(id: string, containerId: string | null = null): TextElement {
    return {
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 80,
        height: 24,
        rotation: 0,
        style: { ...baseStyle },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        text: 'hello',
        containerId,
        textAlign: 'center',
        verticalAlign: 'middle',
        version: 0,
    };
}

describe('collectTextStyleTargetIds', () => {
    it('collects bound text when selecting a container shape', () => {
        const elements: CanvasElement[] = [
            makeRectangle('rect-1', ['text-1']),
            makeText('text-1', 'rect-1'),
        ];

        expect(collectTextStyleTargetIds(['rect-1'], elements)).toEqual(['text-1']);
    });

    it('keeps selected text and deduplicates overlaps', () => {
        const elements: CanvasElement[] = [
            makeRectangle('rect-1', ['text-1']),
            makeText('text-1', 'rect-1'),
        ];

        expect(collectTextStyleTargetIds(['rect-1', 'text-1'], elements)).toEqual(['text-1']);
    });

    it('ignores non-text bound elements and unknown ids', () => {
        const elements: CanvasElement[] = [
            {
                ...makeRectangle('rect-1', []),
                boundElements: [
                    { id: 'line-1', type: 'line' },
                    { id: 'arrow-1', type: 'arrow' },
                ],
            },
            makeText('text-1'),
        ];

        expect(collectTextStyleTargetIds(['missing-id', 'rect-1'], elements)).toEqual([]);
    });
});
