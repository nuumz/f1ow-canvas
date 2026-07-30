/**
 * markdown.ts
 *
 * Lightweight markdown-to-HTML renderer for canvas text elements.
 * Uses `marked` with inline-styled output (no external CSS files)
 * and XSS-safe configuration (raw HTML is escaped).
 */
import { marked } from 'marked';

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

export function htmlToPlainText(html: string): string {
    if (!html) return '';

    return decodeHtmlEntities(
        html
            .replace(/<br\s*\/?>/gi, '\n')
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

// Configure marked — safe defaults
marked.use({
    breaks: true,  // newline → <br>
    gfm: true,     // GitHub Flavored Markdown
    renderer: {
        // Escape raw HTML blocks — prevents XSS when rendered via innerHTML
        html({ text }: { text: string }) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
    },
});

/**
 * Render markdown text to inline-styled HTML.
 * Safe for use with `innerHTML` — raw HTML in the source is escaped.
 */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    const html = marked.parse(text);
    return typeof html === 'string' ? html : '';
}

export function markdownToPlainText(text: string): string {
    if (!text) return '';
    return htmlToPlainText(renderMarkdown(text));
}

/** CSS class name for the markdown overlay container */
export const MD_CLASS = 'fc-md';

/**
 * CSS rules for markdown-rendered content.
 * Injected once via a <style> tag by the overlay component.
 */
export const MD_STYLES = `
.${MD_CLASS} { line-height: inherit; }
.${MD_CLASS} p { margin: 0; }
.${MD_CLASS} h1 { margin: 0; font-weight: bold; font-size: 1.5em; line-height: 1.3; }
.${MD_CLASS} h2 { margin: 0; font-weight: bold; font-size: 1.3em; line-height: 1.3; }
.${MD_CLASS} h3 { margin: 0; font-weight: bold; font-size: 1.15em; line-height: 1.3; }
.${MD_CLASS} h4, .${MD_CLASS} h5, .${MD_CLASS} h6 { margin: 0; font-weight: bold; font-size: 1em; }
.${MD_CLASS} strong { font-weight: bold; }
.${MD_CLASS} em { font-style: italic; }
.${MD_CLASS} del { text-decoration: line-through; }
.${MD_CLASS} code {
    background: rgba(0,0,0,0.06);
    padding: 0.1em 0.3em;
    border-radius: 3px;
    font-size: 0.9em;
    font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
}
.${MD_CLASS} pre {
    background: rgba(0,0,0,0.06);
    padding: 0.4em 0.6em;
    border-radius: 4px;
    font-size: 0.85em;
    overflow-x: auto;
    margin: 0.2em 0;
}
.${MD_CLASS} pre code { background: none; padding: 0; font-size: inherit; }
.${MD_CLASS} ul, .${MD_CLASS} ol { padding-left: 1.5em; margin: 0.15em 0; }
.${MD_CLASS} li { margin: 0; }
.${MD_CLASS} blockquote {
    border-left: 3px solid rgba(0,0,0,0.15);
    padding-left: 0.8em;
    margin: 0.2em 0;
    color: rgba(0,0,0,0.55);
}
.${MD_CLASS} a { color: #4f8df7; text-decoration: underline; }
.${MD_CLASS} hr { border: none; border-top: 1px solid rgba(0,0,0,0.12); margin: 0.3em 0; }
.${MD_CLASS} img { max-width: 100%; }
`;
