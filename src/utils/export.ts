import type Konva from 'konva';
import type {
    CanvasElement,
    RectangleElement,
    EllipseElement,
    DiamondElement,
    LineElement,
    ArrowElement,
    FreeDrawElement,
    TextElement,
    ImageElement,
    Arrowhead,
    Point,
} from '@/types';
import { getStrokeDash, getDiamondPoints } from '@/utils/geometry';
import { computeCurveControlPoint, CURVE_RATIO } from '@/utils/curve';
import { arrowheadSize } from '@/utils/arrowheads';

// ── PNG Export ─────────────────────────────────────────────────

/** Export stage to data URL (PNG) */
export function exportToDataURL(stage: Konva.Stage): string {
    return stage.toDataURL({ pixelRatio: 2 });
}

/** Export stage as downloadable PNG */
export function downloadPNG(stage: Konva.Stage, filename = 'canvas.png'): void {
    const uri = exportToDataURL(stage);
    const link = document.createElement('a');
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/** Export elements to JSON string */
export function exportToJSON(elements: unknown[]): string {
    return JSON.stringify(elements, null, 2);
}

/** Download JSON */
export function downloadJSON(elements: unknown[], filename = 'canvas.json'): void {
    const json = exportToJSON(elements);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ── SVG Export ─────────────────────────────────────────────────

const PADDING = 20;

/** Escape XML special characters */
function escXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build a CSS-compatible dash-array string */
function svgDash(style: 'solid' | 'dashed' | 'dotted', sw: number): string {
    const arr = getStrokeDash(style, sw);
    return arr.length > 0 ? arr.join(',') : 'none';
}

/** Common style attributes */
function styleAttrs(el: CanvasElement): string {
    const { strokeColor, fillColor, strokeWidth, opacity, strokeStyle } = el.style;
    const dash = svgDash(strokeStyle, strokeWidth);
    const parts = [
        `fill="${escXml(fillColor === 'transparent' ? 'none' : fillColor)}"`,
        `stroke="${escXml(strokeColor)}"`,
        `stroke-width="${strokeWidth}"`,
        `opacity="${opacity}"`,
    ];
    if (dash !== 'none') parts.push(`stroke-dasharray="${dash}"`);
    return parts.join(' ');
}

/** Wrap element content with a rotation transform if needed */
function wrapRotation(inner: string, el: CanvasElement, cx: number, cy: number): string {
    if (!el.rotation) return inner;
    return `<g transform="rotate(${el.rotation} ${cx} ${cy})">${inner}</g>`;
}

// ── Individual element renderers ──────────────────────────────

function renderRect(el: RectangleElement): string {
    const { x, y, width: w, height: h, cornerRadius: r } = el;
    const rx = r ? ` rx="${r}" ry="${r}"` : '';
    const svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx} ${styleAttrs(el)} />`;
    return wrapRotation(svg, el, x + w / 2, y + h / 2);
}

function renderEllipse(el: EllipseElement): string {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const svg = `<ellipse cx="${cx}" cy="${cy}" rx="${el.width / 2}" ry="${el.height / 2}" ${styleAttrs(el)} />`;
    return wrapRotation(svg, el, cx, cy);
}

function renderDiamond(el: DiamondElement): string {
    const pts = getDiamondPoints(el.width, el.height);
    const pointStrs: string[] = [];
    for (let i = 0; i < pts.length; i += 2) {
        pointStrs.push(`${el.x + pts[i]},${el.y + pts[i + 1]}`);
    }
    const svg = `<polygon points="${pointStrs.join(' ')}" ${styleAttrs(el)} />`;
    return wrapRotation(svg, el, el.x + el.width / 2, el.y + el.height / 2);
}

function renderStraightLine(el: LineElement | ArrowElement): string {
    const pts = el.points;
    const d = pts.map((v, i) => `${i % 2 === 0 ? el.x + v : el.y + v}`);
    const polyPoints: string[] = [];
    for (let i = 0; i < d.length; i += 2) {
        polyPoints.push(`${d[i]},${d[i + 1]}`);
    }
    return `<polyline points="${polyPoints.join(' ')}" fill="none" stroke="${escXml(el.style.strokeColor)}" stroke-width="${el.style.strokeWidth}" opacity="${el.style.opacity}" stroke-linecap="round" stroke-linejoin="round"${svgDash(el.style.strokeStyle, el.style.strokeWidth) !== 'none' ? ` stroke-dasharray="${svgDash(el.style.strokeStyle, el.style.strokeWidth)}"` : ''} />`;
}

function renderCurvedLine(el: LineElement | ArrowElement): string {
    const pts = el.points;
    const start = { x: pts[0], y: pts[1] };
    const end = { x: pts[pts.length - 2], y: pts[pts.length - 1] };
    const cp = computeCurveControlPoint(start, end, (el as ArrowElement).curvature ?? CURVE_RATIO);
    const sx = el.x + start.x, sy = el.y + start.y;
    const cpx = el.x + cp.x, cpy = el.y + cp.y;
    const ex = el.x + end.x, ey = el.y + end.y;
    return `<path d="M ${sx} ${sy} Q ${cpx} ${cpy} ${ex} ${ey}" fill="none" stroke="${escXml(el.style.strokeColor)}" stroke-width="${el.style.strokeWidth}" opacity="${el.style.opacity}" stroke-linecap="round"${svgDash(el.style.strokeStyle, el.style.strokeWidth) !== 'none' ? ` stroke-dasharray="${svgDash(el.style.strokeStyle, el.style.strokeWidth)}"` : ''} />`;
}

// ── Arrowhead SVG helpers ─────────────────────────────────────

function dir(tip: Point, from: Point): Point {
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
}
function prp(d: Point): Point { return { x: -d.y, y: d.x }; }

function renderArrowheadSvg(type: Arrowhead, tip: Point, from: Point, size: number, stroke: string, sw: number): string {
    const d = dir(tip, from);
    const p = prp(d);
    const half = size * 0.45;

    switch (type) {
        case 'arrow': {
            const b1 = { x: tip.x - d.x * size + p.x * half, y: tip.y - d.y * size + p.y * half };
            const b2 = { x: tip.x - d.x * size - p.x * half, y: tip.y - d.y * size - p.y * half };
            return `<polyline points="${b1.x},${b1.y} ${tip.x},${tip.y} ${b2.x},${b2.y}" fill="none" stroke="${escXml(stroke)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />`;
        }
        case 'triangle': {
            const b1 = { x: tip.x - d.x * size + p.x * half, y: tip.y - d.y * size + p.y * half };
            const b2 = { x: tip.x - d.x * size - p.x * half, y: tip.y - d.y * size - p.y * half };
            return `<polygon points="${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}" fill="${escXml(stroke)}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`;
        }
        case 'triangle_outline': {
            const b1 = { x: tip.x - d.x * size + p.x * half, y: tip.y - d.y * size + p.y * half };
            const b2 = { x: tip.x - d.x * size - p.x * half, y: tip.y - d.y * size - p.y * half };
            return `<polygon points="${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}" fill="#ffffff" stroke="${escXml(stroke)}" stroke-width="${sw}" />`;
        }
        case 'circle': {
            const r = size * 0.35;
            const cx = tip.x - d.x * r, cy = tip.y - d.y * r;
            return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${escXml(stroke)}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`;
        }
        case 'circle_outline': {
            const r = size * 0.35;
            const cx = tip.x - d.x * r, cy = tip.y - d.y * r;
            return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff" stroke="${escXml(stroke)}" stroke-width="${sw}" />`;
        }
        case 'bar': {
            const barH = half * 1.2;
            return `<line x1="${tip.x + p.x * barH}" y1="${tip.y + p.y * barH}" x2="${tip.x - p.x * barH}" y2="${tip.y - p.y * barH}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`;
        }
        case 'diamond':
        case 'diamond_outline': {
            const hw = half * 0.7, hl = size * 0.55;
            const c = { x: tip.x - d.x * hl, y: tip.y - d.y * hl };
            const fill = type === 'diamond' ? escXml(stroke) : '#ffffff';
            return `<polygon points="${tip.x},${tip.y} ${c.x + p.x * hw},${c.y + p.y * hw} ${c.x - d.x * hl},${c.y - d.y * hl} ${c.x - p.x * hw},${c.y - p.y * hw}" fill="${fill}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`;
        }
        case 'crowfoot_one': {
            const barH2 = half * 1.0;
            const offset = size * 0.25;
            const b2 = { x: tip.x - d.x * offset, y: tip.y - d.y * offset };
            return [
                `<line x1="${tip.x + p.x * barH2}" y1="${tip.y + p.y * barH2}" x2="${tip.x - p.x * barH2}" y2="${tip.y - p.y * barH2}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
                `<line x1="${b2.x + p.x * barH2}" y1="${b2.y + p.y * barH2}" x2="${b2.x - p.x * barH2}" y2="${b2.y - p.y * barH2}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
            ].join('\n');
        }
        case 'crowfoot_many': {
            const barH2 = half * 1.0;
            const footLen = size * 0.6;
            const forkBase = { x: tip.x - d.x * footLen, y: tip.y - d.y * footLen };
            return [
                `<line x1="${tip.x + p.x * barH2}" y1="${tip.y + p.y * barH2}" x2="${tip.x - p.x * barH2}" y2="${tip.y - p.y * barH2}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
                `<polyline points="${tip.x + p.x * barH2},${tip.y + p.y * barH2} ${forkBase.x},${forkBase.y} ${tip.x - p.x * barH2},${tip.y - p.y * barH2}" fill="none" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
            ].join('\n');
        }
        case 'crowfoot_one_or_many': {
            const barH2 = half * 1.0;
            const footLen = size * 0.6;
            const offset = size * 0.25;
            const b2 = { x: tip.x - d.x * offset, y: tip.y - d.y * offset };
            const forkBase = { x: tip.x - d.x * footLen, y: tip.y - d.y * footLen };
            return [
                `<line x1="${tip.x + p.x * barH2}" y1="${tip.y + p.y * barH2}" x2="${tip.x - p.x * barH2}" y2="${tip.y - p.y * barH2}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
                `<line x1="${b2.x + p.x * barH2}" y1="${b2.y + p.y * barH2}" x2="${b2.x - p.x * barH2}" y2="${b2.y - p.y * barH2}" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
                `<polyline points="${tip.x + p.x * barH2},${tip.y + p.y * barH2} ${forkBase.x},${forkBase.y} ${tip.x - p.x * barH2},${tip.y - p.y * barH2}" fill="none" stroke="${escXml(stroke)}" stroke-width="${sw}" />`,
            ].join('\n');
        }
        default:
            return '';
    }
}

function renderLineOrArrow(el: LineElement | ArrowElement): string {
    const parts: string[] = [];
    const isCurved = el.lineType === 'curved';

    // Main path
    parts.push(isCurved ? renderCurvedLine(el) : renderStraightLine(el));

    // Arrowheads (only for arrow type)
    if (el.type === 'arrow') {
        const arr = el as ArrowElement;
        const startHead = arr.startArrowhead ?? (arr.startArrow ? 'arrow' : null);
        const endHead = arr.endArrowhead ?? (arr.endArrow ? 'arrow' : null);
        const size = arrowheadSize(el.style.strokeWidth);
        const pts = el.points;

        if (isCurved) {
            const s = { x: pts[0], y: pts[1] };
            const e = { x: pts[pts.length - 2], y: pts[pts.length - 1] };
            const cp = computeCurveControlPoint(s, e, arr.curvature ?? CURVE_RATIO);
            const tipS = { x: el.x + s.x, y: el.y + s.y };
            const tipE = { x: el.x + e.x, y: el.y + e.y };
            // Tangent approximation: first/last 10% of bezier
            const prevS = { x: el.x + cp.x * 0.1 + s.x * 0.9, y: el.y + cp.y * 0.1 + s.y * 0.9 };
            const prevE = { x: el.x + cp.x * 0.1 + e.x * 0.9, y: el.y + cp.y * 0.1 + e.y * 0.9 };
            if (startHead) parts.push(renderArrowheadSvg(startHead, tipS, prevS, size, el.style.strokeColor, el.style.strokeWidth));
            if (endHead) parts.push(renderArrowheadSvg(endHead, tipE, prevE, size, el.style.strokeColor, el.style.strokeWidth));
        } else {
            if (startHead && pts.length >= 4) {
                const tip = { x: el.x + pts[0], y: el.y + pts[1] };
                const from = { x: el.x + pts[2], y: el.y + pts[3] };
                parts.push(renderArrowheadSvg(startHead, tip, from, size, el.style.strokeColor, el.style.strokeWidth));
            }
            if (endHead && pts.length >= 4) {
                const tip = { x: el.x + pts[pts.length - 2], y: el.y + pts[pts.length - 1] };
                const from = { x: el.x + pts[pts.length - 4], y: el.y + pts[pts.length - 3] };
                parts.push(renderArrowheadSvg(endHead, tip, from, size, el.style.strokeColor, el.style.strokeWidth));
            }
        }
    }

    return parts.join('\n');
}

function renderFreeDraw(el: FreeDrawElement): string {
    if (el.points.length < 4) return '';
    const pts: string[] = [];
    for (let i = 0; i < el.points.length; i += 2) {
        pts.push(`${el.x + el.points[i]},${el.y + el.points[i + 1]}`);
    }
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${escXml(el.style.strokeColor)}" stroke-width="${el.style.strokeWidth}" opacity="${el.style.opacity}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function renderText(el: TextElement): string {
    if (!el.text) return '';
    const { style, x, y, text, textAlign } = el;
    const lines = text.split('\n');
    const lineHeight = style.fontSize * 1.18; // matches LINE_HEIGHT in TextShape
    let anchor = 'start';
    let dx = 0;
    if (textAlign === 'center') { anchor = 'middle'; dx = el.width / 2; }
    else if (textAlign === 'right') { anchor = 'end'; dx = el.width; }

    const tspans = lines.map((line, i) =>
        `<tspan x="${x + dx}" dy="${i === 0 ? 0 : lineHeight}">${escXml(line)}</tspan>`,
    ).join('');

    const parts = [
        `font-family="${escXml(style.fontFamily)}"`,
        `font-size="${style.fontSize}"`,
        `fill="${escXml(style.strokeColor)}"`,
        `opacity="${style.opacity}"`,
        `text-anchor="${anchor}"`,
    ];

    return `<text x="${x + dx}" y="${y + style.fontSize}" ${parts.join(' ')}>${tspans}</text>`;
}

function renderImage(el: ImageElement): string {
    const { x, y, width: w, height: h, src, cornerRadius: r, style } = el;
    const parts: string[] = [];

    // Generate unique clip path ID if corner radius is set
    const clipId = r > 0 ? `clip-${el.id}` : '';

    if (clipId) {
        parts.push(`<defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" /></clipPath></defs>`);
    }

    const imgTag = `<image href="${escXml(src)}" x="${x}" y="${y}" width="${w}" height="${h}" opacity="${style.opacity}" preserveAspectRatio="none"${clipId ? ` clip-path="url(#${clipId})"` : ''} />`;

    // Border stroke
    let borderTag = '';
    if (style.strokeWidth > 0 && style.strokeColor !== 'transparent') {
        const rx = r ? ` rx="${r}" ry="${r}"` : '';
        borderTag = `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx} fill="none" stroke="${escXml(style.strokeColor)}" stroke-width="${style.strokeWidth}" opacity="${style.opacity}" />`;
    }

    const inner = parts.join('') + imgTag + borderTag;
    return wrapRotation(inner, el, x + w / 2, y + h / 2);
}

// ── Main SVG export ───────────────────────────────────────────

function renderElement(el: CanvasElement): string {
    switch (el.type) {
        case 'rectangle': return renderRect(el);
        case 'ellipse': return renderEllipse(el);
        case 'diamond': return renderDiamond(el);
        case 'line':
        case 'arrow': return renderLineOrArrow(el);
        case 'freedraw': return renderFreeDraw(el);
        case 'text': return renderText(el);
        case 'image': return renderImage(el);
        default: return '';
    }
}

/**
 * Export canvas elements to an SVG string.
 * Computes tight bounding box + padding automatically.
 */
export function exportToSVG(elements: CanvasElement[]): string {
    if (elements.length === 0) {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>';
    }

    // Compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
        if (!el.isVisible) continue;
        if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
            const pts = (el as LineElement | ArrowElement | FreeDrawElement).points;
            for (let i = 0; i < pts.length; i += 2) {
                const px = el.x + pts[i];
                const py = el.y + pts[i + 1];
                minX = Math.min(minX, px);
                minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);
                maxY = Math.max(maxY, py);
            }
        } else {
            minX = Math.min(minX, el.x);
            minY = Math.min(minY, el.y);
            maxX = Math.max(maxX, el.x + el.width);
            maxY = Math.max(maxY, el.y + el.height);
        }
    }

    const w = maxX - minX + PADDING * 2;
    const h = maxY - minY + PADDING * 2;
    const offsetX = -minX + PADDING;
    const offsetY = -minY + PADDING;

    const content = elements
        .filter((el) => el.isVisible)
        .map((el) => renderElement(el))
        .filter(Boolean)
        .join('\n  ');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
        `  <g transform="translate(${offsetX} ${offsetY})">`,
        `  ${content}`,
        `  </g>`,
        `</svg>`,
    ].join('\n');
}

/** Download SVG file */
export function downloadSVG(elements: CanvasElement[], filename = 'canvas.svg'): void {
    const svg = exportToSVG(elements);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
