import { describe, expect, it } from 'vitest';

import type { CanvasElement, TextElement } from '@/types';
import {
    createBoundTextElement,
    findTopmostTextContainerAtPoint,
    isPointInsideTextContainer,
    orderBoundTextWithContainers,
} from '@/utils/textBinding';

const baseStyle = {
    strokeColor: '#1e1e1e',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    strokeStyle: 'solid' as const,
    roughness: 0,
    fontSize: 20,
    fontFamily: 'system-ui, sans-serif',
};

function makeShape(overrides: Partial<CanvasElement> = {}): CanvasElement {
    return {
        id: 'shape-1',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 120,
        rotation: 0,
        style: { ...baseStyle },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        ...overrides,
    } as CanvasElement;
}

describe('textBinding helpers', () => {
    it('picks the shape whose center is nearest the click in overlaps', () => {
        // Two same-size shapes overlap. A click close to the second shape's
        // center should bind to the second shape, even though the first one
        // is also a match and happens to be earlier in z-order.
        const back = makeShape({ id: 'green', x: 80, y: 50, width: 340, height: 270 });
        const front = makeShape({ id: 'pink', x: 200, y: 130, width: 340, height: 270 });

        // Click near pink's center (overlap region).
        const picked = findTopmostTextContainerAtPoint([back, front], { x: 370, y: 265 });
        expect(picked?.id).toBe('pink');
    });

    it('prefers the smaller container when click is equidistant from centers', () => {
        const big = makeShape({ id: 'big', x: 0, y: 0, width: 400, height: 400 });
        const small = makeShape({ id: 'small', x: 150, y: 150, width: 100, height: 100 });

        expect(findTopmostTextContainerAtPoint([big, small], { x: 200, y: 200 })?.id).toBe('small');
    });

    it('uses real shape geometry for diamond hit testing', () => {
        const diamond = makeShape({ id: 'diamond', type: 'diamond', width: 100, height: 100 });

        expect(isPointInsideTextContainer(diamond as any, { x: 150, y: 150 })).toBe(true);
        expect(isPointInsideTextContainer(diamond as any, { x: 105, y: 105 })).toBe(false);
    });

    it('creates bound text configured as a child of the shape', () => {
        const shape = makeShape({ id: 'container-1' });
        const text = createBoundTextElement('text-1', shape as any, baseStyle);

        expect(text.containerId).toBe('container-1');
        expect(text.textAlign).toBe('center');
        expect(text.verticalAlign).toBe('middle');
        expect(text.width).toBe(shape.width - 8);
        expect(text.x).toBe(shape.x + 4);
    });
});

describe('orderBoundTextWithContainers', () => {
    function makeText(id: string, containerId: string | null): TextElement {
        return {
            id,
            type: 'text',
            x: 0,
            y: 0,
            width: 10,
            height: 20,
            rotation: 0,
            style: { ...baseStyle },
            isLocked: false,
            isVisible: true,
            boundElements: null,
            text: '',
            containerId,
            textAlign: 'left',
            verticalAlign: 'top',
            version: 0,
        } as TextElement;
    }

    it('moves bound text to sit immediately after its container', () => {
        const pink = makeShape({ id: 'pink' });
        const green = makeShape({ id: 'green' });
        const label = makeText('label', 'pink');

        // pink created first, green drawn on top later, label appended at end.
        const ordered = orderBoundTextWithContainers([pink, green, label]);

        expect(ordered.map((el) => el.id)).toEqual(['pink', 'label', 'green']);
    });

    it('returns the same reference when nothing needs reordering', () => {
        const pink = makeShape({ id: 'pink' });
        const label = makeText('label', 'pink');
        const green = makeShape({ id: 'green' });

        const input = [pink, label, green];
        expect(orderBoundTextWithContainers(input)).toBe(input);
    });

    it('keeps standalone text in original position', () => {
        const pink = makeShape({ id: 'pink' });
        const standalone = makeText('note', null);
        const green = makeShape({ id: 'green' });

        const ordered = orderBoundTextWithContainers([pink, standalone, green]);
        expect(ordered.map((el) => el.id)).toEqual(['pink', 'note', 'green']);
    });
});