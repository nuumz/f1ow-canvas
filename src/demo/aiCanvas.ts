import { DEFAULT_STYLE } from '@/constants';
import type { ArrowElement, CanvasElement, ElementStyle, RectangleElement, TextElement } from '@/types';
import { generateId } from '@/utils/id';

export type AiCanvasAction =
    | 'explain'
    | 'review'
    | 'document'
    | 'suggest-connections'
    | 'draft-architecture'
    | 'find-missing-pieces'
    | 'implementation-plan'
    | 'agent-brief'
    | 'export-tdd'
    | 'draw-architecture';

export type AiCanvasNodeRole =
    | 'component'
    | 'api'
    | 'database'
    | 'queue'
    | 'external-service'
    | 'ui-screen'
    | 'agent'
    | 'tool'
    | 'decision'
    | 'risk'
    | 'task';

export type AiCanvasConnectorRole =
    | 'calls'
    | 'publishes'
    | 'subscribes'
    | 'reads'
    | 'writes'
    | 'depends-on'
    | 'owns'
    | 'blocks'
    | 'implements'
    | 'flows-to';

export interface AiCanvasBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AiCanvasNode {
    id: string;
    type: CanvasElement['type'];
    role: AiCanvasNodeRole;
    label: string | null;
    bounds: AiCanvasBounds;
    isLocked: boolean;
    isVisible: boolean;
    ports?: Array<{ id: string; label: string | null; ratio: [number, number] }>;
    image?: {
        alt: string | null;
        naturalWidth: number;
        naturalHeight: number;
        scaleMode: string;
    };
}

export interface AiCanvasConnector {
    id: string;
    type: 'line' | 'arrow';
    role: AiCanvasConnectorRole;
    label: string | null;
    from: string | null;
    to: string | null;
    lineType: string;
    pointCount: number;
    startArrowhead?: string | null;
    endArrowhead?: string | null;
}

export interface AiCanvasContext {
    scope: 'selection' | 'canvas';
    selectedIds: string[];
    nodes: AiCanvasNode[];
    connectors: AiCanvasConnector[];
    stats: {
        totalElements: number;
        visibleElements: number;
        selectedElements: number;
        unlabeledNodes: number;
        danglingConnectors: number;
    };
}

export interface AiConnectionSuggestion {
    sourceId: string;
    targetId: string;
    label: string;
    reason: string;
    confidence: number;
}

export interface AiCanvasResponse {
    title: string;
    body: string;
    suggestions?: AiConnectionSuggestion[];
    draftElements?: CanvasElement[];
}

export interface AiCanvasRequest {
    action: AiCanvasAction;
    context: AiCanvasContext;
}

export type AiCanvasAdapter = (request: AiCanvasRequest) => Promise<AiCanvasResponse>;

const STRUCTURAL_NODE_TYPES = new Set<CanvasElement['type']>(['rectangle', 'ellipse', 'diamond', 'image']);

const AI_DRAW_NODE_STYLE: ElementStyle = {
    ...DEFAULT_STYLE,
    strokeColor: '#2563eb',
    fillColor: '#eff6ff',
    strokeWidth: 2,
    fontSize: 16,
};

const AI_DRAW_CONNECTOR_STYLE: ElementStyle = {
    ...DEFAULT_STYLE,
    strokeColor: '#334155',
    strokeWidth: 2,
    fontSize: 14,
};

const AI_DRAW_LABEL_STYLE: ElementStyle = {
    ...DEFAULT_STYLE,
    strokeColor: '#0f172a',
    fillColor: 'transparent',
    fontSize: 15,
};

function isTextElement(element: CanvasElement): element is TextElement {
    return element.type === 'text';
}

function isConnectorElement(element: CanvasElement): element is Extract<CanvasElement, { type: 'line' | 'arrow' }> {
    return element.type === 'line' || element.type === 'arrow';
}

function isStructuralNode(element: CanvasElement): boolean {
    return STRUCTURAL_NODE_TYPES.has(element.type) || (element.type === 'text' && !element.containerId);
}

function findLabelFor(element: CanvasElement, textByContainerId: Map<string, TextElement[]>): string | null {
    if (element.type === 'text') return element.text.trim() || null;
    if (element.type === 'image') return element.alt.trim() || null;

    const labels = textByContainerId
        .get(element.id)
        ?.map((textElement) => textElement.text.trim())
        .filter(Boolean);

    return labels && labels.length > 0 ? labels.join(' / ') : null;
}

function textContainers(elements: CanvasElement[]): Map<string, TextElement[]> {
    const containers = new Map<string, TextElement[]>();
    for (const element of elements) {
        if (!isTextElement(element) || !element.containerId) continue;
        const existing = containers.get(element.containerId) ?? [];
        existing.push(element);
        containers.set(element.containerId, existing);
    }
    return containers;
}

function boundsOf(element: CanvasElement): AiCanvasBounds {
    return {
        x: Math.round(element.x),
        y: Math.round(element.y),
        width: Math.round(element.width),
        height: Math.round(element.height),
    };
}

function normalizedText(value: string | null | undefined): string {
    return (value ?? '').toLowerCase();
}

function includesAny(value: string, needles: string[]): boolean {
    return needles.some((needle) => value.includes(needle));
}

function inferNodeRole(element: CanvasElement, label: string | null): AiCanvasNodeRole {
    const text = normalizedText(label);
    if (includesAny(text, ['api', 'endpoint', 'controller', 'route', 'graphql', 'rest'])) return 'api';
    if (includesAny(text, ['db', 'database', 'postgres', 'mysql', 'sqlite', 'redis', 'mongo', 'storage', 'store'])) return 'database';
    if (includesAny(text, ['queue', 'topic', 'event bus', 'kafka', 'sqs', 'pubsub', 'stream'])) return 'queue';
    if (includesAny(text, ['external', 'third party', 'vendor', 'partner', 'webhook'])) return 'external-service';
    if (includesAny(text, ['screen', 'page', 'view', 'ui', 'webview', 'frontend', 'form'])) return 'ui-screen';
    if (includesAny(text, ['agent', 'assistant', 'planner', 'executor'])) return 'agent';
    if (includesAny(text, ['tool', 'mcp', 'function', 'action'])) return 'tool';
    if (includesAny(text, ['decision', 'adr', 'trade-off', 'option'])) return 'decision';
    if (includesAny(text, ['risk', 'issue', 'concern', 'unknown', 'gap'])) return 'risk';
    if (includesAny(text, ['task', 'todo', 'implement', 'fix', 'build'])) return 'task';
    if (element.type === 'image') return 'external-service';
    if (element.type === 'diamond') return 'decision';
    return 'component';
}

function inferConnectorRole(label: string | null): AiCanvasConnectorRole {
    const text = normalizedText(label);
    if (includesAny(text, ['publish', 'emit', 'send event'])) return 'publishes';
    if (includesAny(text, ['subscribe', 'consume', 'listen'])) return 'subscribes';
    if (includesAny(text, ['read', 'query', 'fetch', 'load'])) return 'reads';
    if (includesAny(text, ['write', 'save', 'persist', 'insert', 'update'])) return 'writes';
    if (includesAny(text, ['depend', 'requires', 'needs'])) return 'depends-on';
    if (includesAny(text, ['own', 'owns'])) return 'owns';
    if (includesAny(text, ['block', 'blocks'])) return 'blocks';
    if (includesAny(text, ['implement', 'builds', 'delivers'])) return 'implements';
    if (includesAny(text, ['call', 'request', 'invoke', 'trigger'])) return 'calls';
    return 'flows-to';
}

function selectedElementSet(elements: CanvasElement[], selectedIds: string[]): Set<string> {
    if (selectedIds.length === 0) return new Set(elements.map((element) => element.id));

    const selected = new Set(selectedIds);
    for (const element of elements) {
        if (isTextElement(element) && element.containerId && selected.has(element.containerId)) {
            selected.add(element.id);
        }
        if (isConnectorElement(element)) {
            const from = element.startBinding?.elementId;
            const to = element.endBinding?.elementId;
            if ((from && selected.has(from)) || (to && selected.has(to))) {
                selected.add(element.id);
            }
        }
    }

    return selected;
}

function toNode(element: CanvasElement, textByContainerId: Map<string, TextElement[]>): AiCanvasNode {
    const label = findLabelFor(element, textByContainerId);
    const node: AiCanvasNode = {
        id: element.id,
        type: element.type,
        role: inferNodeRole(element, label),
        label,
        bounds: boundsOf(element),
        isLocked: element.isLocked,
        isVisible: element.isVisible,
    };

    if (element.ports && element.ports.length > 0) {
        node.ports = element.ports.map((port) => ({
            id: port.id,
            label: port.label?.trim() || null,
            ratio: port.ratio,
        }));
    }

    if (element.type === 'image') {
        node.image = {
            alt: element.alt.trim() || null,
            naturalWidth: element.naturalWidth,
            naturalHeight: element.naturalHeight,
            scaleMode: element.scaleMode,
        };
    }

    return node;
}

function toConnector(
    element: Extract<CanvasElement, { type: 'line' | 'arrow' }>,
    textByContainerId: Map<string, TextElement[]>,
): AiCanvasConnector {
    const label = findLabelFor(element, textByContainerId);
    const connector: AiCanvasConnector = {
        id: element.id,
        type: element.type,
        role: inferConnectorRole(label),
        label,
        from: element.startBinding?.elementId ?? null,
        to: element.endBinding?.elementId ?? null,
        lineType: element.lineType,
        pointCount: Math.floor(element.points.length / 2),
    };

    if (element.type === 'arrow') {
        connector.startArrowhead = element.startArrowhead ?? null;
        connector.endArrowhead = element.endArrowhead ?? null;
    }

    return connector;
}

export function serializeCanvasForAI(elements: CanvasElement[], selectedIds: string[] = []): AiCanvasContext {
    const includedIds = selectedElementSet(elements, selectedIds);
    const scopedElements = elements.filter((element) => includedIds.has(element.id));
    const textByContainerId = textContainers(scopedElements);
    const nodes = scopedElements
        .filter((element) => isStructuralNode(element))
        .map((element) => toNode(element, textByContainerId));
    const connectors = scopedElements
        .filter(isConnectorElement)
        .map((element) => toConnector(element, textByContainerId));

    return {
        scope: selectedIds.length > 0 ? 'selection' : 'canvas',
        selectedIds: [...selectedIds],
        nodes,
        connectors,
        stats: {
            totalElements: elements.length,
            visibleElements: elements.filter((element) => element.isVisible).length,
            selectedElements: selectedIds.length,
            unlabeledNodes: nodes.filter((node) => !node.label).length,
            danglingConnectors: connectors.filter((connector) => !connector.from || !connector.to).length,
        },
    };
}

function formatNodeName(node: AiCanvasNode): string {
    return node.label ? `${node.label} (${node.role})` : `${node.role} ${node.id.slice(0, 6)}`;
}

function formatOverview(context: AiCanvasContext): string {
    const nodeSummary = context.nodes.length === 0
        ? '- No diagram nodes in scope.'
        : context.nodes.map((node) => `- ${formatNodeName(node)}`).join('\n');
    const connectorSummary = context.connectors.length === 0
        ? '- No connectors in scope.'
        : context.connectors.map((connector) => {
            const source = connector.from ?? 'unbound';
            const target = connector.to ?? 'unbound';
            const label = connector.label ? `: ${connector.label}` : '';
            return `- ${source} -> ${target} [${connector.role}]${label}`;
        }).join('\n');

    return [`Nodes`, nodeSummary, '', `Connectors`, connectorSummary].join('\n');
}

function roleCount(context: AiCanvasContext, role: AiCanvasNodeRole): number {
    return context.nodes.filter((node) => node.role === role).length;
}

function connectorRoleCount(context: AiCanvasContext, role: AiCanvasConnectorRole): number {
    return context.connectors.filter((connector) => connector.role === role).length;
}

function architectureDraftFor(context: AiCanvasContext): string {
    const components = context.nodes.filter((node) => node.role === 'component' || node.role === 'agent' || node.role === 'tool');
    const interfaces = context.nodes.filter((node) => node.role === 'api' || node.role === 'ui-screen' || node.role === 'external-service');
    const dataStores = context.nodes.filter((node) => node.role === 'database' || node.role === 'queue');
    const risks = context.nodes.filter((node) => node.role === 'risk' || node.role === 'decision');

    return [
        '# Architecture Draft',
        '',
        '## System Overview',
        `This ${context.scope} contains ${context.nodes.length} architectural node(s) and ${context.connectors.length} relationship(s). It should be treated as a draft design until contracts, non-functional requirements, and rollout constraints are reviewed.`,
        '',
        '## Components',
        ...(components.length > 0 ? components.map((node) => `- ${formatNodeName(node)}: owns a bounded responsibility in the proposed system.`) : ['- No explicit application component, agent, or tool nodes were identified.']),
        '',
        '## Interfaces',
        ...(interfaces.length > 0 ? interfaces.map((node) => `- ${formatNodeName(node)}: define request/response, auth, validation, and error contracts.`) : ['- No API, UI, or external service boundary is explicit yet.']),
        '',
        '## Data And Messaging',
        ...(dataStores.length > 0 ? dataStores.map((node) => `- ${formatNodeName(node)}: document ownership, schema, retention, and consistency rules.`) : ['- No database, storage, queue, or event stream is explicit yet.']),
        '',
        '## Relationships',
        ...(context.connectors.length > 0
            ? context.connectors.map((connector) => `- ${connector.from ?? 'Unbound'} ${connector.role} ${connector.to ?? 'Unbound'}${connector.label ? ` (${connector.label})` : ''}`)
            : ['- No relationships are defined yet.']),
        '',
        '## Decisions And Risks',
        ...(risks.length > 0 ? risks.map((node) => `- ${formatNodeName(node)}: resolve before implementation starts.`) : ['- Add decision/risk nodes for trade-offs, unknowns, and rollout constraints.']),
    ].join('\n');
}

function missingPiecesFor(context: AiCanvasContext): string {
    const findings: string[] = [];

    if (roleCount(context, 'api') === 0) findings.push('- API contract: no explicit API or integration boundary is modeled.');
    if (roleCount(context, 'database') === 0 && connectorRoleCount(context, 'writes') > 0) findings.push('- Persistence: write relationship exists but no database/storage owner is modeled.');
    if (roleCount(context, 'queue') === 0 && connectorRoleCount(context, 'publishes') > 0) findings.push('- Messaging: publish relationship exists but no queue/topic/event stream is modeled.');
    if (context.connectors.some((connector) => !connector.label)) findings.push('- Relationship semantics: some connectors have no labels, so implementation order and contracts may be ambiguous.');
    if (context.stats.unlabeledNodes > 0) findings.push(`- Naming: ${context.stats.unlabeledNodes} node(s) need labels before agent handoff.`);
    if (context.stats.danglingConnectors > 0) findings.push(`- Wiring: ${context.stats.danglingConnectors} connector(s) are not bound to both ends.`);
    if (roleCount(context, 'risk') === 0) findings.push('- Risk management: no risk/open-question node is modeled.');

    findings.push('- Auth/security: define authentication, authorization, secret handling, and data sensitivity.');
    findings.push('- Observability: define logs, metrics, traces, and operator-facing failure signals.');
    findings.push('- Testing: define unit, integration, contract, and manual verification coverage.');
    findings.push('- Rollout: define migration, feature flag, fallback, and rollback strategy.');

    return ['# Missing Pieces', '', ...findings].join('\n');
}

function candidateModuleName(node: AiCanvasNode): string {
    const base = (node.label ?? node.role).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return base || node.id.slice(0, 8);
}

function implementationPlanFor(context: AiCanvasContext): string {
    const moduleTargets = context.nodes
        .filter((node) => node.role !== 'risk' && node.role !== 'decision')
        .slice(0, 8)
        .map((node) => `- ${candidateModuleName(node)}: ${formatNodeName(node)}`);

    return [
        '# Implementation Plan',
        '',
        '## Phase 1: Contracts And Boundaries',
        '- Confirm public inputs/outputs for each API, UI, agent, tool, and external integration.',
        '- Define data ownership, validation rules, error model, and security assumptions.',
        '',
        '## Phase 2: Module Skeletons',
        ...(moduleTargets.length > 0 ? moduleTargets : ['- No concrete module targets are available until nodes are labeled.']),
        '',
        '## Phase 3: Flow Wiring',
        ...(context.connectors.length > 0
            ? context.connectors.map((connector) => `- Wire ${connector.from ?? 'source'} ${connector.role} ${connector.to ?? 'target'}${connector.label ? ` via "${connector.label}"` : ''}.`)
            : ['- Add connectors before implementation wiring is planned.']),
        '',
        '## Phase 4: Tests And Verification',
        '- Add focused unit tests for pure logic and contract tests for boundaries.',
        '- Add integration tests for cross-component flows and persistence/messaging paths.',
        '- Run typecheck/build and manually verify the primary canvas/user workflow.',
        '',
        '## Exit Criteria',
        '- Architecture draft reviewed.',
        '- Open risks either resolved or explicitly accepted.',
        '- Agent briefs are scoped to one coherent implementation slice each.',
    ].join('\n');
}

function agentBriefFor(context: AiCanvasContext): string {
    return [
        'TASK: Implement the selected architecture slice from the canvas.',
        '',
        'SCOPE:',
        ...context.nodes.map((node) => `- ${formatNodeName(node)} (${node.id})`),
        '',
        'CONTEXT:',
        ...context.connectors.map((connector) => `- ${connector.from ?? 'Unbound'} ${connector.role} ${connector.to ?? 'Unbound'}${connector.label ? `: ${connector.label}` : ''}`),
        '',
        'RETURN:',
        '- Code changes matching existing project conventions.',
        '- Tests for new behavior and changed contracts.',
        '- Notes for any assumptions, unresolved decisions, or follow-up slices.',
        '',
        'VERIFY:',
        '- Run focused tests for changed modules.',
        '- Run typecheck/build when shared types or public APIs change.',
        '- Confirm no direct canvas mutation occurs without user approval.',
    ].join('\n');
}

function tddFor(context: AiCanvasContext): string {
    return [
        '# Technical Design Document',
        '',
        '## Problem Statement',
        'Describe the user or engineering problem this architecture solves.',
        '',
        '## Proposed Architecture',
        architectureDraftFor(context),
        '',
        '## Implementation Plan',
        implementationPlanFor(context),
        '',
        '## Architecture Decision Record',
        '- Decision: Adopt the canvas-defined architecture slice as the working implementation plan.',
        '- Status: Proposed',
        '- Consequences: Implementation should proceed only after contracts, risks, and verification criteria are accepted.',
    ].join('\n');
}

function createTextElement(id: string, text: string, containerId: string | null, x: number, y: number, width: number, height: number): TextElement {
    return {
        id,
        type: 'text',
        x,
        y,
        width,
        height,
        rotation: 0,
        style: { ...AI_DRAW_LABEL_STYLE },
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

function createDrawNode(label: string, x: number, y: number): { shape: RectangleElement; label: TextElement } {
    const shapeId = generateId();
    const labelId = generateId();
    const shape: RectangleElement = {
        id: shapeId,
        type: 'rectangle',
        x,
        y,
        width: 180,
        height: 76,
        rotation: 0,
        style: { ...AI_DRAW_NODE_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: [{ id: labelId, type: 'text' }],
        version: 0,
        cornerRadius: 8,
    };
    return {
        shape,
        label: createTextElement(labelId, label, shapeId, x + 14, y + 22, 152, 32),
    };
}

function createDrawArrow(from: RectangleElement, to: RectangleElement): ArrowElement {
    const arrowId = generateId();
    const fromCenterX = from.x + from.width;
    const fromCenterY = from.y + from.height / 2;
    const toCenterX = to.x;
    const toCenterY = to.y + to.height / 2;
    return {
        id: arrowId,
        type: 'arrow',
        x: fromCenterX,
        y: fromCenterY,
        width: Math.abs(toCenterX - fromCenterX),
        height: Math.abs(toCenterY - fromCenterY),
        rotation: 0,
        style: { ...AI_DRAW_CONNECTOR_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        points: [0, 0, toCenterX - fromCenterX, toCenterY - fromCenterY],
        startArrowhead: null,
        endArrowhead: 'arrow',
        lineType: 'sharp',
        startBinding: {
            elementId: from.id,
            fixedPoint: [1, 0.5],
            gap: 0,
            snapMode: 'anchor',
            elementVersion: from.version,
            anchor: 'e',
        },
        endBinding: {
            elementId: to.id,
            fixedPoint: [0, 0.5],
            gap: 0,
            snapMode: 'anchor',
            elementVersion: to.version,
            anchor: 'w',
        },
    };
}

function createAiArchitectureDrawing(context: AiCanvasContext): CanvasElement[] {
    const originX = context.nodes.length > 0 ? Math.max(...context.nodes.map((node) => node.bounds.x + node.bounds.width)) + 120 : 120;
    const originY = context.nodes.length > 0 ? Math.min(...context.nodes.map((node) => node.bounds.y)) : 120;
    const labels = context.nodes.length > 0
        ? context.nodes.slice(0, 4).map((node) => node.label ?? `${node.role} module`)
        : ['User Request', 'Planner Agent', 'Tool Executor', 'Result Canvas'];
    const uniqueLabels = Array.from(new Set(labels)).slice(0, 4);
    while (uniqueLabels.length < 4) {
        uniqueLabels.push(['Planner Agent', 'Tool Executor', 'Generated Canvas', 'Review Gate'][uniqueLabels.length]);
    }

    const nodeDrafts = uniqueLabels.map((label, index) => createDrawNode(label, originX + index * 250, originY));
    const elements: CanvasElement[] = [];
    const arrows: ArrowElement[] = [];

    for (let index = 0; index < nodeDrafts.length - 1; index++) {
        const arrow = createDrawArrow(nodeDrafts[index].shape, nodeDrafts[index + 1].shape);
        arrows.push(arrow);
        // Bidirectional reference so binding stays consistent under move/delete.
        const fromShape = nodeDrafts[index].shape;
        const toShape = nodeDrafts[index + 1].shape;
        fromShape.boundElements = [...(fromShape.boundElements ?? []), { id: arrow.id, type: 'arrow' }];
        toShape.boundElements = [...(toShape.boundElements ?? []), { id: arrow.id, type: 'arrow' }];
    }

    for (const draft of nodeDrafts) {
        elements.push(draft.shape, draft.label);
    }

    for (const arrow of arrows) {
        elements.push(arrow);
    }

    return elements;
}

function drawingSummary(elements: CanvasElement[]): string {
    const shapeCount = elements.filter((element) => element.type === 'rectangle').length;
    const connectorCount = elements.filter((element) => element.type === 'arrow' || element.type === 'line').length;
    const labelCount = elements.filter((element) => element.type === 'text').length;
    return [
        '# AI Drawing Draft',
        '',
        `The agent prepared ${shapeCount} node(s), ${connectorCount} connector(s), and ${labelCount} label(s).`,
        'Review the draft below, then apply it to the canvas if it matches the intended architecture.',
    ].join('\n');
}

function reviewCanvas(context: AiCanvasContext): string {
    const findings: string[] = [];
    if (context.stats.unlabeledNodes > 0) {
        findings.push(`- ${context.stats.unlabeledNodes} node(s) need clearer labels.`);
    }
    if (context.stats.danglingConnectors > 0) {
        findings.push(`- ${context.stats.danglingConnectors} connector(s) are missing a source or target binding.`);
    }
    if (context.connectors.some((connector) => !connector.label)) {
        findings.push('- Some connectors have no relationship label. Add verbs such as "triggers", "validates", or "returns" where the flow is ambiguous.');
    }
    if (context.nodes.length > 1 && context.connectors.length === 0) {
        findings.push('- Multiple nodes are present but no relationships are drawn yet.');
    }

    return findings.length > 0 ? findings.join('\n') : '- The scoped diagram is readable and has no obvious structural gaps.';
}

function documentationFor(context: AiCanvasContext): string {
    const lines = [
        '## Diagram Summary',
        '',
        `- Scope: ${context.scope}`,
        `- Nodes: ${context.nodes.length}`,
        `- Connectors: ${context.connectors.length}`,
        '',
        '## Components',
        ...context.nodes.map((node) => `- ${formatNodeName(node)}`),
        '',
        '## Relationships',
    ];

    if (context.connectors.length === 0) {
        lines.push('- No relationships defined.');
    } else {
        for (const connector of context.connectors) {
            const label = connector.label ?? 'connects to';
            lines.push(`- ${connector.from ?? 'Unbound'} ${label} ${connector.to ?? 'Unbound'}`);
        }
    }

    return lines.join('\n');
}

function suggestConnections(context: AiCanvasContext): AiConnectionSuggestion[] {
    const existingPairs = new Set(
        context.connectors
            .filter((connector) => connector.from && connector.to)
            .map((connector) => `${connector.from}->${connector.to}`),
    );
    const visibleNodes = context.nodes.filter((node) => node.isVisible);
    const suggestions: AiConnectionSuggestion[] = [];

    for (let index = 0; index < visibleNodes.length - 1 && suggestions.length < 3; index++) {
        const source = visibleNodes[index];
        const target = visibleNodes[index + 1];
        const pairKey = `${source.id}->${target.id}`;
        if (source.id === target.id || existingPairs.has(pairKey)) continue;
        suggestions.push({
            sourceId: source.id,
            targetId: target.id,
            label: 'flows to',
            reason: 'Nodes are adjacent in the current reading order and do not already have a connector.',
            confidence: 0.58,
        });
    }

    return suggestions;
}

export const demoAiCanvasAdapter: AiCanvasAdapter = async ({ action, context }) => {
    await Promise.resolve();

    if (action === 'explain') {
        return {
            title: context.scope === 'selection' ? 'Selection Explained' : 'Canvas Explained',
            body: formatOverview(context),
        };
    }

    if (action === 'review') {
        return {
            title: context.scope === 'selection' ? 'Selection Review' : 'Canvas Review',
            body: reviewCanvas(context),
        };
    }

    if (action === 'document') {
        return {
            title: 'Generated Markdown',
            body: documentationFor(context),
        };
    }

    if (action === 'draft-architecture') {
        return {
            title: 'Architecture Draft',
            body: architectureDraftFor(context),
        };
    }

    if (action === 'find-missing-pieces') {
        return {
            title: 'Missing Pieces',
            body: missingPiecesFor(context),
        };
    }

    if (action === 'implementation-plan') {
        return {
            title: 'Implementation Plan',
            body: implementationPlanFor(context),
        };
    }

    if (action === 'agent-brief') {
        return {
            title: 'Agent Brief',
            body: agentBriefFor(context),
        };
    }

    if (action === 'export-tdd') {
        return {
            title: 'TDD / ADR Draft',
            body: tddFor(context),
        };
    }

    if (action === 'draw-architecture') {
        const draftElements = createAiArchitectureDrawing(context);
        return {
            title: 'AI Drawing Draft',
            body: drawingSummary(draftElements),
            draftElements,
        };
    }

    const suggestions = suggestConnections(context);
    return {
        title: 'Connection Suggestions',
        body: suggestions.length > 0
            ? 'Review these draft relationships before applying them to the canvas.'
            : 'No obvious missing connections were found in the current scope.',
        suggestions,
    };
};