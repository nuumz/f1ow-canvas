import { describe, expect, it } from 'vitest';

import { htmlToPlainText, markdownToPlainText } from '@/utils/markdown';

describe('htmlToPlainText', () => {
    it('converts markdown-rendered html into visible text', () => {
        expect(htmlToPlainText('<p>Hello <strong>world</strong><br>next</p>')).toBe('Hello world\nnext');
    });
});

describe('markdownToPlainText', () => {
    it('strips inline markdown syntax from the visible text', () => {
        expect(markdownToPlainText('Hello **world**\n~~done~~')).toBe('Hello world\ndone');
    });
});