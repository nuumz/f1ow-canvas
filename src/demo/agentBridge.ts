/**
 * External agent bridge — exposes a small command API so an AI agent
 * running outside this app (Playwright, browser extension, iframe parent,
 * devtools console) can drive the canvas without coupling to React internals.
 *
 * Two transports are supported simultaneously:
 *   1. `window.flowCanvasAgent.invoke(command, payload)` — direct JS call.
 *   2. `window.postMessage({ source: 'flow-canvas-agent', id, command, payload })`
 *      — cross-origin / iframe parent. Replies are posted back with the same `id`.
 *
 * The bridge is demo-only: it lives in the app layer, not the library, and is
 * mounted by `src/main.tsx` via `installAgentBridge()`.
 */

import type { CanvasElement, FlowCanvasRef } from '../lib';
import { serializeCanvasForAI } from './aiCanvas';

/** Message tag used for postMessage transport. */
export const AGENT_MESSAGE_SOURCE = 'flow-canvas-agent';

/** Command names accepted by the bridge. */
export type AgentCommand =
    | 'getElements'
    | 'getSelectedIds'
    | 'getContext'
    | 'setElements'
    | 'addElements'
    | 'setSelectedIds'
    | 'clearSelection'
    | 'clearCanvas'
    | 'undo'
    | 'redo'
    | 'resetView'
    | 'exportJSON'
    | 'exportPNG'
    | 'ping';

/** Discriminated payload — only the fields each command needs. */
export interface AgentCommandPayloads {
    getElements: void;
    getSelectedIds: void;
    getContext: { selectedIds?: string[] } | void;
    setElements: { elements: CanvasElement[] };
    addElements: { elements: CanvasElement[]; select?: boolean };
    setSelectedIds: { ids: string[] };
    clearSelection: void;
    clearCanvas: void;
    undo: void;
    redo: void;
    resetView: void;
    exportJSON: void;
    exportPNG: void;
    ping: void;
}

export interface AgentRequestMessage<C extends AgentCommand = AgentCommand> {
    source: typeof AGENT_MESSAGE_SOURCE;
    id: string;
    command: C;
    payload?: AgentCommandPayloads[C];
}

export type AgentResponseMessage =
    | {
          source: typeof AGENT_MESSAGE_SOURCE;
          id: string;
          ok: true;
          result: unknown;
      }
    | {
          source: typeof AGENT_MESSAGE_SOURCE;
          id: string;
          ok: false;
          error: string;
      };

/** Public bridge handle exposed on `window.flowCanvasAgent`. */
export interface AgentBridgeHandle {
    readonly version: string;
    readonly commands: readonly AgentCommand[];
    invoke<C extends AgentCommand>(command: C, payload?: AgentCommandPayloads[C]): Promise<unknown>;
}

const BRIDGE_VERSION = '0.1.0';

const COMMAND_LIST: readonly AgentCommand[] = [
    'getElements',
    'getSelectedIds',
    'getContext',
    'setElements',
    'addElements',
    'setSelectedIds',
    'clearSelection',
    'clearCanvas',
    'undo',
    'redo',
    'resetView',
    'exportJSON',
    'exportPNG',
    'ping',
];

/** Minimal runtime guard so external callers can't crash the canvas with junk. */
function assertElementArray(value: unknown, field: string): asserts value is CanvasElement[] {
    if (!Array.isArray(value)) {
        throw new Error(`agentBridge: \`${field}\` must be an array of CanvasElement.`);
    }
    for (const candidate of value as unknown[]) {
        if (!candidate || typeof candidate !== 'object') {
            throw new Error(`agentBridge: \`${field}\` contains a non-object element.`);
        }
        const element = candidate as Partial<CanvasElement>;
        if (typeof element.id !== 'string' || typeof element.type !== 'string') {
            throw new Error(`agentBridge: every element in \`${field}\` needs string \`id\` and \`type\`.`);
        }
    }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error(`agentBridge: \`${field}\` must be a string array.`);
    }
}

interface BridgeOptions {
    /** Allowed origins for postMessage requests. Use `'*'` for any (demo only). */
    allowedOrigins?: readonly string[] | '*';
}

/**
 * Install the bridge on `window`. Returns a cleanup function so React
 * effects can unmount it on hot reload / teardown.
 */
export function installAgentBridge(canvasRef: { current: FlowCanvasRef | null }, options: BridgeOptions = {}): () => void {
    if (typeof window === 'undefined') {
        return () => {};
    }

    const allowedOrigins = options.allowedOrigins ?? '*';

    const dispatch = async <C extends AgentCommand>(command: C, payload?: AgentCommandPayloads[C]): Promise<unknown> => {
        const ref = canvasRef.current;
        if (!ref) {
            throw new Error('agentBridge: canvas is not mounted yet.');
        }

        switch (command) {
            case 'ping':
                return { ok: true, version: BRIDGE_VERSION };

            case 'getElements':
                return ref.getElements();

            case 'getSelectedIds':
                return ref.getSelectedIds();

            case 'getContext': {
                const elements = ref.getElements();
                const selected = (payload as AgentCommandPayloads['getContext'])?.selectedIds ?? ref.getSelectedIds();
                return serializeCanvasForAI(elements, selected);
            }

            case 'setElements': {
                const data = payload as AgentCommandPayloads['setElements'];
                assertElementArray(data?.elements, 'elements');
                ref.setElements(data.elements);
                return { applied: data.elements.length };
            }

            case 'addElements': {
                const data = payload as AgentCommandPayloads['addElements'];
                assertElementArray(data?.elements, 'elements');
                const current = ref.getElements();
                ref.setElements([...current, ...data.elements]);
                if (data.select !== false) {
                    ref.setSelectedIds(data.elements.map((element) => element.id));
                }
                return { added: data.elements.length, total: current.length + data.elements.length };
            }

            case 'setSelectedIds': {
                const data = payload as AgentCommandPayloads['setSelectedIds'];
                assertStringArray(data?.ids, 'ids');
                ref.setSelectedIds(data.ids);
                return { selected: data.ids.length };
            }

            case 'clearSelection':
                ref.setSelectedIds([]);
                return { selected: 0 };

            case 'clearCanvas':
                ref.setElements([]);
                ref.setSelectedIds([]);
                return { cleared: true };

            case 'undo':
                ref.undo();
                return { ok: true };

            case 'redo':
                ref.redo();
                return { ok: true };

            case 'resetView':
                ref.resetView();
                return { ok: true };

            case 'exportJSON':
                return ref.exportJSON();

            case 'exportPNG':
                return ref.exportPNG();

            default:
                throw new Error(`agentBridge: unknown command \`${String(command)}\`.`);
        }
    };

    const handle: AgentBridgeHandle = {
        version: BRIDGE_VERSION,
        commands: COMMAND_LIST,
        invoke: (command, payload) => dispatch(command, payload),
    };

    (window as unknown as { flowCanvasAgent: AgentBridgeHandle }).flowCanvasAgent = handle;
    window.dispatchEvent(new CustomEvent('flow-canvas-agent:ready', { detail: { version: BRIDGE_VERSION } }));

    const messageListener = async (event: MessageEvent<AgentRequestMessage | unknown>) => {
        const data = event.data as AgentRequestMessage | undefined;
        if (!data || data.source !== AGENT_MESSAGE_SOURCE || typeof data.id !== 'string' || typeof data.command !== 'string') {
            return;
        }
        if (allowedOrigins !== '*' && !allowedOrigins.includes(event.origin)) {
            return;
        }

        const reply = (response: AgentResponseMessage) => {
            const target = (event.source ?? window) as Window;
            const targetOrigin = allowedOrigins === '*' ? '*' : event.origin;
            target.postMessage(response, targetOrigin);
        };

        try {
            const result = await dispatch(data.command as AgentCommand, data.payload as never);
            reply({ source: AGENT_MESSAGE_SOURCE, id: data.id, ok: true, result });
        } catch (error) {
            reply({
                source: AGENT_MESSAGE_SOURCE,
                id: data.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    window.addEventListener('message', messageListener);

    return () => {
        window.removeEventListener('message', messageListener);
        const w = window as unknown as { flowCanvasAgent?: AgentBridgeHandle };
        if (w.flowCanvasAgent === handle) {
            delete w.flowCanvasAgent;
        }
    };
}
