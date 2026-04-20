import { describe, expect, it } from 'vitest';

import { serializeEditableHtmlToMarkdown } from '@/utils/markdownEditing';

describe('serializeEditableHtmlToMarkdown', () => {
    it('serializes bold, italic and strike tags back to markdown', () => {
        expect(serializeEditableHtmlToMarkdown('<div>Hello <strong>bold</strong> <em>italic</em> <del>gone</del></div>')).toBe(
            'Hello **bold** *italic* ~~gone~~'
        );
    });

    it('preserves line breaks from editable block markup', () => {
        expect(serializeEditableHtmlToMarkdown('<div>one</div><div>two<br>three</div>')).toBe('one\ntwo\nthree');
    });

    it('drops other tags but keeps their text content', () => {
        expect(serializeEditableHtmlToMarkdown('<p><span>plain</span> <a href="#">link</a></p>')).toBe('plain link');
    });
});