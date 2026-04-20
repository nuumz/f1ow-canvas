import { describe, expect, it } from 'vitest';

import { isStylePanelTarget, shouldKeepEditingOnBlur } from '@/components/Canvas/TextHtmlOverlay';

function makeTarget(inPanel: boolean): EventTarget {
    return {
        closest: (selector: string) => {
            if (selector !== '[data-flow-style-panel="true"]') return null;
            return inPanel ? {} : null;
        },
    } as unknown as EventTarget;
}

describe('TextHtmlOverlay style panel blur guard', () => {
    it('recognizes targets inside the style panel subtree', () => {
        expect(isStylePanelTarget(makeTarget(true))).toBe(true);
    });

    it('keeps editing when blur lands on style panel control', () => {
        expect(shouldKeepEditingOnBlur(makeTarget(true), makeTarget(false))).toBe(true);
    });

    it('keeps editing when relatedTarget is null but activeElement is in style panel', () => {
        expect(shouldKeepEditingOnBlur(null, makeTarget(true))).toBe(true);
    });

    it('allows finishing edit when blur moves outside style panel', () => {
        expect(shouldKeepEditingOnBlur(makeTarget(false), makeTarget(false))).toBe(false);
    });
});
