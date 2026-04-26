import { describe, expect, it } from 'vitest';

import { DEFAULT_STYLE } from '@/constants';
import { demoAiCanvasAdapter, serializeCanvasForAI } from '@/demo/aiCanvas';
import type { Binding, CanvasElement, LineElement } from '@/types';

function rectangle(id: string, x = 0, y = 0): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y,
        width: 120,
        height: 64,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
    };
}

function labeledRectangle(id: string, label: string, x = 0): CanvasElement[] {
    return [
        rectangle(id, x),
        boundText(`${id}-label`, id, label),
    ];
}

function boundText(id: string, containerId: string, text: string): CanvasElement {
    return {
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 80,
        height: 24,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        text,
        containerId,
        textAlign: 'center',
        verticalAlign: 'middle',
    };
}

function image(id: string): CanvasElement {
    return {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 160,
        height: 100,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        src: 'data:image/png;base64,very-large-payload',
        naturalWidth: 640,
        naturalHeight: 400,
        scaleMode: 'fit',
        crop: null,
        cornerRadius: 0,
        alt: 'Architecture preview',
    };
}

function binding(elementId: string): Binding {
    return {
        elementId,
        fixedPoint: [0.5, 0.5],
        gap: 0,
        snapMode: 'center',
        elementVersion: 0,
    };
}

function line(id: string, endElementId: string): LineElement {
    return {
        id,
        type: 'line',
        x: 0,
        y: 0,
        width: 100,
        height: 0,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        points: [0, 0, 100, 0],
        lineType: 'sharp',
        startBinding: null,
        endBinding: binding(endElementId),
    };
}

function boundLine(id: string, startElementId: string, endElementId: string): LineElement {
    return {
        ...line(id, endElementId),
        startBinding: binding(startElementId),
    };
}

describe('serializeCanvasForAI', () => {
    it('keeps image metadata but excludes the raw image source payload', () => {
        const context = serializeCanvasForAI([image('image-1')]);

        expect(context.nodes[0].image).toEqual({
            alt: 'Architecture preview',
            naturalWidth: 640,
            naturalHeight: 400,
            scaleMode: 'fit',
        });
        expect(JSON.stringify(context)).not.toContain('very-large-payload');
        expect(JSON.stringify(context)).not.toContain('data:image/png');
    });

    it('includes bound labels and related connectors when serializing a selection', () => {
        const elements = [
            rectangle('checkout'),
            boundText('checkout-label', 'checkout', 'Checkout'),
            line('incoming-flow', 'checkout'),
            rectangle('other'),
        ];

        const context = serializeCanvasForAI(elements, ['checkout']);

        expect(context.scope).toBe('selection');
        expect(context.nodes).toHaveLength(1);
        expect(context.nodes[0].label).toBe('Checkout');
        expect(context.connectors).toHaveLength(1);
        expect(context.connectors[0]).toMatchObject({
            id: 'incoming-flow',
            from: null,
            to: 'checkout',
        });
        expect(context.stats.danglingConnectors).toBe(1);
    });

    it('infers architecture roles from labels for nodes and connectors', () => {
        const elements = [
            ...labeledRectangle('gateway', 'REST API Gateway'),
            ...labeledRectangle('store', 'Postgres Database'),
            boundLine('write-flow', 'gateway', 'store'),
            boundText('write-label', 'write-flow', 'writes orders'),
        ];

        const context = serializeCanvasForAI(elements);

        expect(context.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'gateway', role: 'api' }),
            expect.objectContaining({ id: 'store', role: 'database' }),
        ]));
        expect(context.connectors[0]).toMatchObject({
            id: 'write-flow',
            role: 'writes',
            label: 'writes orders',
        });
    });
});

describe('demoAiCanvasAdapter', () => {
    it('returns review-only connection suggestions without modifying the context', async () => {
        const context = serializeCanvasForAI([
            rectangle('source', 0),
            rectangle('target', 180),
        ]);

        const response = await demoAiCanvasAdapter({ action: 'suggest-connections', context });

        expect(response.title).toBe('Connection Suggestions');
        expect(response.suggestions).toEqual([
            expect.objectContaining({
                sourceId: 'source',
                targetId: 'target',
                label: 'flows to',
            }),
        ]);
        expect(context.connectors).toEqual([]);
    });

    it('generates architecture drafts and implementation plans from the canvas context', async () => {
        const context = serializeCanvasForAI([
            ...labeledRectangle('agent', 'Planner Agent'),
            ...labeledRectangle('api', 'REST API'),
            boundLine('call-flow', 'agent', 'api'),
            boundText('call-label', 'call-flow', 'calls'),
        ]);

        const architecture = await demoAiCanvasAdapter({ action: 'draft-architecture', context });
        const plan = await demoAiCanvasAdapter({ action: 'implementation-plan', context });

        expect(architecture.title).toBe('Architecture Draft');
        expect(architecture.body).toContain('## System Overview');
        expect(architecture.body).toContain('Planner Agent');
        expect(plan.title).toBe('Implementation Plan');
        expect(plan.body).toContain('## Phase 1: Contracts And Boundaries');
        expect(plan.body).toContain('Wire agent calls api');
    });

    it('generates missing-piece analysis and agent briefs for implementation handoff', async () => {
        const context = serializeCanvasForAI([
            ...labeledRectangle('worker', 'Implementation Worker'),
            rectangle('unlabeled'),
        ]);

        const gaps = await demoAiCanvasAdapter({ action: 'find-missing-pieces', context });
        const brief = await demoAiCanvasAdapter({ action: 'agent-brief', context });
        const tdd = await demoAiCanvasAdapter({ action: 'export-tdd', context });

        expect(gaps.body).toContain('API contract');
        expect(gaps.body).toContain('Testing');
        expect(brief.body).toContain('TASK: Implement the selected architecture slice from the canvas.');
        expect(brief.body).toContain('VERIFY:');
        expect(tdd.title).toBe('TDD / ADR Draft');
        expect(tdd.body).toContain('## Architecture Decision Record');
    });

    it('generates a reviewable drawing draft that can be applied to the canvas', async () => {
        const context = serializeCanvasForAI([
            ...labeledRectangle('planner', 'Planner Agent'),
            ...labeledRectangle('executor', 'Tool Executor'),
        ]);

        const response = await demoAiCanvasAdapter({ action: 'draw-architecture', context });
        const draftElements = response.draftElements ?? [];

        expect(response.title).toBe('AI Drawing Draft');
        expect(response.body).toContain('The agent prepared');
        expect(draftElements.length).toBeGreaterThan(0);
        expect(draftElements.filter((element) => element.type === 'rectangle')).toHaveLength(4);
        expect(draftElements.filter((element) => element.type === 'arrow')).toHaveLength(3);
        expect(draftElements.filter((element) => element.type === 'text')).toHaveLength(4);
        expect(draftElements.some((element) => element.type === 'text' && element.text === 'Planner Agent')).toBe(true);
        expect(draftElements.filter((element) => element.type === 'text').every((element) => element.containerId !== null)).toBe(true);
        expect(draftElements.filter((element) => element.type === 'arrow').every((element) => (
            element.boundElements === null &&
            element.lineType === 'sharp' &&
            element.startBinding?.elementId !== undefined &&
            element.endBinding?.elementId !== undefined &&
            element.points[1] === 0 &&
            element.points[3] === 0
        ))).toBe(true);
        // Each shape (except first/last) must reference the connecting arrows for stable binding.
        const rectangles = draftElements.filter((element) => element.type === 'rectangle');
        expect(rectangles[0].boundElements?.some((bound) => bound.type === 'arrow')).toBe(true);
        expect(rectangles[rectangles.length - 1].boundElements?.some((bound) => bound.type === 'arrow')).toBe(true);
        expect(new Set(rectangles.map((element) => element.y)).size).toBe(1);
    });
});