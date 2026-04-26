// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { AGENT_MESSAGE_SOURCE, installAgentBridge } from '@/demo/agentBridge';
import type { AgentBridgeHandle } from '@/demo/agentBridge';
import type { CanvasElement, FlowCanvasRef } from '@/lib';

beforeAll(() => {
    // Ensure a DOM exists even when the test runner ignores the environment pragma.
    if (typeof globalThis.window === 'undefined') {
        const dom = new Window();
        const g = globalThis as unknown as { window: unknown; document: unknown; MessageEvent: unknown; CustomEvent: unknown };
        g.window = dom;
        g.document = dom.document;
        g.MessageEvent = dom.MessageEvent;
        g.CustomEvent = dom.CustomEvent;
    }
});

function makeRef(initial: CanvasElement[] = []): { current: FlowCanvasRef; state: { elements: CanvasElement[]; selected: string[] } } {
    const state = { elements: [...initial], selected: [] as string[] };
    const ref: FlowCanvasRef = {
        getElements: () => state.elements,
        setElements: (elements: CanvasElement[]) => {
            state.elements = elements;
        },
        getSelectedIds: () => state.selected,
        setSelectedIds: (ids: string[]) => {
            state.selected = ids;
        },
        undo: vi.fn(),
        redo: vi.fn(),
        resetView: vi.fn(),
        exportJSON: vi.fn(() => '{"json":true}'),
        exportPNG: vi.fn(() => 'data:image/png;base64,demo'),
        clear: vi.fn(),
    } as unknown as FlowCanvasRef;
    return { current: ref, state };
}

function rect(id: string, x = 0): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y: 0,
        width: 100,
        height: 60,
        rotation: 0,
        style: {} as CanvasElement['style'],
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
    } as CanvasElement;
}

describe('agentBridge', () => {
    let cleanup: (() => void) | null = null;

    afterEach(() => {
        cleanup?.();
        cleanup = null;
        if (typeof window !== 'undefined') {
            delete (window as unknown as { flowCanvasAgent?: AgentBridgeHandle }).flowCanvasAgent;
        }
    });

    it('exposes a handle on window with the documented commands', () => {
        const ref = makeRef();
        cleanup = installAgentBridge(ref);
        const handle = (window as unknown as { flowCanvasAgent: AgentBridgeHandle }).flowCanvasAgent;
        expect(handle).toBeDefined();
        expect(handle.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(handle.commands).toContain('addElements');
        expect(handle.commands).toContain('getContext');
    });

    it('addElements appends to canvas and selects them by default', async () => {
        const ref = makeRef([rect('existing')]);
        cleanup = installAgentBridge(ref);
        const handle = (window as unknown as { flowCanvasAgent: AgentBridgeHandle }).flowCanvasAgent;

        const result = await handle.invoke('addElements', { elements: [rect('new-1', 200), rect('new-2', 400)] });

        expect(result).toEqual({ added: 2, total: 3 });
        expect(ref.state.elements.map((element) => element.id)).toEqual(['existing', 'new-1', 'new-2']);
        expect(ref.state.selected).toEqual(['new-1', 'new-2']);
    });

    it('rejects malformed elements without mutating canvas', async () => {
        const ref = makeRef([rect('keep')]);
        cleanup = installAgentBridge(ref);
        const handle = (window as unknown as { flowCanvasAgent: AgentBridgeHandle }).flowCanvasAgent;

        await expect(handle.invoke('addElements', { elements: [{ id: 'no-type' } as unknown as CanvasElement] })).rejects.toThrow(/string `id` and `type`/);
        expect(ref.state.elements.map((element) => element.id)).toEqual(['keep']);
    });

    it('responds to postMessage requests with matching id', async () => {
        const ref = makeRef([rect('a'), rect('b', 200)]);
        cleanup = installAgentBridge(ref);

        const reply = await new Promise<unknown>((resolve) => {
            const listener = (event: MessageEvent) => {
                const data = event.data as { source?: string; id?: string; ok?: boolean };
                if (data?.source === AGENT_MESSAGE_SOURCE && data.id === 'req-1' && typeof data.ok === 'boolean') {
                    window.removeEventListener('message', listener);
                    resolve(event.data);
                }
            };
            window.addEventListener('message', listener);
            window.postMessage({ source: AGENT_MESSAGE_SOURCE, id: 'req-1', command: 'getElements' }, '*');
        });

        expect(reply).toMatchObject({ source: AGENT_MESSAGE_SOURCE, id: 'req-1', ok: true });
        expect((reply as { result: CanvasElement[] }).result).toHaveLength(2);
    });

    it('cleanup removes the global handle and message listener', async () => {
        const ref = makeRef();
        const dispose = installAgentBridge(ref);
        dispose();
        expect((window as unknown as { flowCanvasAgent?: AgentBridgeHandle }).flowCanvasAgent).toBeUndefined();

        // postMessage after dispose should not crash and should not produce a reply.
        const replied = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 30);
            const listener = (event: MessageEvent) => {
                const data = event.data as { source?: string; id?: string; ok?: boolean };
                if (data?.source === AGENT_MESSAGE_SOURCE && data.id === 'after-dispose' && typeof data.ok === 'boolean') {
                    clearTimeout(timer);
                    window.removeEventListener('message', listener);
                    resolve(true);
                }
            };
            window.addEventListener('message', listener);
            window.postMessage({ source: AGENT_MESSAGE_SOURCE, id: 'after-dispose', command: 'ping' }, '*');
        });
        expect(replied).toBe(false);
    });
});
