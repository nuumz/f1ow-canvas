import type { CanvasElement, ElementStyle, Point, TextElement } from '@/types';
import { computeBoundTextPosition, CONTAINER_TYPES } from '@/utils/dragSync';
import { LABEL_LINE_HEIGHT } from '@/utils/labelMetrics';

export type TextContainerElement = Extract<CanvasElement, { type: 'rectangle' | 'ellipse' | 'diamond' | 'image' }>;

function toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
}

function toUnrotatedPoint(point: Point, element: CanvasElement): Point {
    const angle = toRadians(element.rotation || 0);
    if (angle === 0) return point;

    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);

    return {
        x: cx + dx * cos - dy * sin,
        y: cy + dx * sin + dy * cos,
    };
}

export function isTextContainerElement(element: CanvasElement): element is TextContainerElement {
    return CONTAINER_TYPES.has(element.type);
}

export function isPointInsideTextContainer(element: TextContainerElement, point: Point): boolean {
    const local = toUnrotatedPoint(point, element);
    const relX = local.x - element.x;
    const relY = local.y - element.y;

    if (relX < 0 || relY < 0 || relX > element.width || relY > element.height) {
        return false;
    }

    if (element.type === 'ellipse') {
        const radiusX = element.width / 2 || 1;
        const radiusY = element.height / 2 || 1;
        const normX = (relX - radiusX) / radiusX;
        const normY = (relY - radiusY) / radiusY;
        return normX * normX + normY * normY <= 1;
    }

    if (element.type === 'diamond') {
        const halfW = element.width / 2 || 1;
        const halfH = element.height / 2 || 1;
        const normX = Math.abs(relX - halfW) / halfW;
        const normY = Math.abs(relY - halfH) / halfH;
        return normX + normY <= 1;
    }

    return true;
}

export function findTopmostTextContainerAtPoint(
    elements: CanvasElement[],
    point: Point,
): TextContainerElement | null {
    // Collect every visible, unlocked container that contains the point.
    const candidates: TextContainerElement[] = [];
    for (let i = elements.length - 1; i >= 0; i--) {
        const element = elements[i];
        if (!element.isVisible || element.isLocked) continue;
        if (!isTextContainerElement(element)) continue;
        if (isPointInsideTextContainer(element, point)) {
            candidates.push(element);
        }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // When multiple shapes overlap at the click, pick the one the user most
    // likely aimed at: nearest center to the click. Falls back to smallest
    // area (usually a foreground badge on top of a larger container), and
    // finally to the original z-order iteration order (topmost first).
    return candidates.reduce((best, candidate) => {
        const bestDist = centerDistanceSquared(best, point);
        const candDist = centerDistanceSquared(candidate, point);
        if (candDist < bestDist) return candidate;
        if (candDist > bestDist) return best;

        const bestArea = best.width * best.height;
        const candArea = candidate.width * candidate.height;
        return candArea < bestArea ? candidate : best;
    });
}

function centerDistanceSquared(element: TextContainerElement, point: Point): number {
    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    return dx * dx + dy * dy;
}

/**
 * Reorder elements so every bound text element is placed immediately
 * after its container. This keeps a shape and its label at the same
 * logical z-index — shapes stacked above the container occlude the
 * label, and the label never leaks above unrelated foreground elements.
 *
 * Pure function — returns the input reference unchanged when no
 * reordering is required so downstream memoization stays stable.
 */
export function orderBoundTextWithContainers(elements: CanvasElement[]): CanvasElement[] {
    let hasBoundText = false;
    for (const el of elements) {
        if (el.type === 'text' && (el as TextElement).containerId) {
            hasBoundText = true;
            break;
        }
    }
    if (!hasBoundText) return elements;

    const containerIds = new Set<string>();
    const boundByContainer = new Map<string, TextElement[]>();
    for (const el of elements) {
        if (el.type !== 'text') {
            containerIds.add(el.id);
            continue;
        }
        const text = el as TextElement;
        if (!text.containerId) continue;
        const list = boundByContainer.get(text.containerId);
        if (list) list.push(text);
        else boundByContainer.set(text.containerId, [text]);
    }

    const output: CanvasElement[] = [];

    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];

        if (el.type === 'text') {
            const text = el as TextElement;
            if (text.containerId && containerIds.has(text.containerId)) {
                // Skip — inserted below after its container.
                continue;
            }
        }

        output.push(el);

        const attached = boundByContainer.get(el.id);
        if (attached) {
            for (const t of attached) output.push(t);
        }
    }

    // Preserve reference identity if the result matches the input order.
    if (output.length === elements.length) {
        let identical = true;
        for (let i = 0; i < output.length; i++) {
            if (output[i] !== elements[i]) {
                identical = false;
                break;
            }
        }
        if (identical) return elements;
    }

    return output;
}

export function createBoundTextElement(
    id: string,
    container: TextContainerElement,
    style: ElementStyle,
): TextElement {
    const initialHeight = Math.max(30, Math.ceil(style.fontSize * LABEL_LINE_HEIGHT));
    const position = computeBoundTextPosition(container, {
        height: initialHeight,
        verticalAlign: 'middle',
    });

    return {
        id,
        type: 'text',
        x: position.x,
        y: position.y,
        width: position.width,
        height: initialHeight,
        rotation: 0,
        style: { ...style, fillColor: 'transparent' },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        text: '',
        containerId: container.id,
        textAlign: 'center',
        verticalAlign: 'middle',
        version: 0,
    };
}