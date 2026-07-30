function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

export function serializeEditableHtmlToMarkdown(html: string): string {
    if (!html) return '';

    return decodeHtmlEntities(
        html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<(?:strong|b)\b[^>]*>/gi, '**')
            .replace(/<\/(?:strong|b)>/gi, '**')
            .replace(/<(?:em|i)\b[^>]*>/gi, '*')
            .replace(/<\/(?:em|i)>/gi, '*')
            .replace(/<(?:del|s|strike)\b[^>]*>/gi, '~~')
            .replace(/<\/(?:del|s|strike)>/gi, '~~')
            .replace(/<li\b[^>]*>/gi, '- ')
            .replace(/<\/(?:p|div|h1|h2|h3|h4|h5|h6|li|blockquote|pre)>/gi, '\n')
            .replace(/<[^>]+>/g, '')
    )
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}