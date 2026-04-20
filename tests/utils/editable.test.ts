import { describe, expect, it, vi } from 'vitest';

import { blurTextEditingTarget, isTextEditingTarget } from '@/utils/editable';

function createTarget(overrides: Partial<{
    tagName: string;
    isContentEditable: boolean;
    blur: ReturnType<typeof vi.fn>;
    closest: ReturnType<typeof vi.fn>;
}> = {}) {
    return {
        tagName: 'DIV',
        isContentEditable: false,
        blur: vi.fn(),
        closest: vi.fn(() => null),
        ...overrides,
    } as unknown as EventTarget & {
        tagName?: string;
        isContentEditable?: boolean;
        blur?: () => void;
        closest?: (selector: string) => EventTarget | null;
    };
}

describe('editable target helpers', () => {
    it('detects native form controls', () => {
        expect(isTextEditingTarget(createTarget({ tagName: 'input' }))).toBe(true);
        expect(isTextEditingTarget(createTarget({ tagName: 'textarea' }))).toBe(true);
        expect(isTextEditingTarget(createTarget({ tagName: 'select' }))).toBe(true);
    });

    it('detects contenteditable hosts and descendants', () => {
        const host = createTarget({ isContentEditable: true });
        const child = createTarget({ closest: vi.fn(() => host) });

        expect(isTextEditingTarget(host)).toBe(true);
        expect(isTextEditingTarget(child)).toBe(true);
    });

    it('blurs the active editable host', () => {
        const host = createTarget({ isContentEditable: true });
        const child = createTarget({ closest: vi.fn(() => host) });

        expect(blurTextEditingTarget(child)).toBe(true);
        expect(host.blur).toHaveBeenCalledTimes(1);
    });

    it('ignores non-editable targets', () => {
        const target = createTarget();

        expect(isTextEditingTarget(target)).toBe(false);
        expect(blurTextEditingTarget(target)).toBe(false);
        expect(target.blur).not.toHaveBeenCalled();
    });
});