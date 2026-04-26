import React, { useRef, useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { FlowCanvas } from './lib';
import type { FlowCanvasRef, CanvasElement, ContextMenuItem, ContextMenuContext } from './lib';
import {
    demoAiCanvasAdapter,
    serializeCanvasForAI,
    type AiCanvasAction,
    type AiCanvasResponse,
} from './demo/aiCanvas';
import { installAgentBridge } from './demo/agentBridge';

type AiPanelStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AiPanelState {
    open: boolean;
    status: AiPanelStatus;
    title: string;
    body: string;
    suggestions: AiCanvasResponse['suggestions'];
    draftElements: CanvasElement[];
}

const AI_ACTION_LABELS: Record<AiCanvasAction, string> = {
    explain: 'Explain',
    review: 'Review',
    document: 'Markdown',
    'suggest-connections': 'Suggest Connections',
    'draft-architecture': 'Draft Architecture',
    'find-missing-pieces': 'Find Missing Pieces',
    'implementation-plan': 'Implementation Plan',
    'agent-brief': 'Agent Brief',
    'export-tdd': 'TDD / ADR',
    'draw-architecture': 'Draw Architecture',
};

/**
 * Demo App — shows how to use <FlowCanvas> as a reusable component.
 */
const DemoApp: React.FC = () => {
    const canvasRef = useRef<FlowCanvasRef>(null);
    const [elementCount, setElementCount] = useState(0);
    /** Set of element IDs that have an annotation badge */
    const [annotatedIds, setAnnotatedIds] = useState<Set<string>>(new Set());
    const [aiPanel, setAiPanel] = useState<AiPanelState>({
        open: false,
        status: 'idle',
        title: 'AI Canvas Assistant',
        body: '',
        suggestions: undefined,
        draftElements: [],
    });

    const handleChange = useCallback((elements: CanvasElement[]) => {
        setElementCount(elements.length);
    }, []);

    // Expose external command bridge so AI agents (Playwright, extensions,
    // iframe parent, devtools) can drive the canvas without coupling to React.
    useEffect(() => installAgentBridge(canvasRef), []);

    const handleExportJSON = () => {
        const json = canvasRef.current?.exportJSON();
        if (json) {
            console.log('Exported JSON:', json);
            navigator.clipboard.writeText(json).then(() => alert('JSON copied to clipboard!'));
        }
    };

    const handleExportPNG = () => {
        const dataUrl = canvasRef.current?.exportPNG();
        if (dataUrl) {
            const link = document.createElement('a');
            link.download = 'canvas.png';
            link.href = dataUrl;
            link.click();
        }
    };

    const handleUndo = () => canvasRef.current?.undo();
    const handleRedo = () => canvasRef.current?.redo();
    const handleReset = () => canvasRef.current?.resetView();

    const runAiAction = useCallback(async (action: AiCanvasAction, selectedIds?: string[]) => {
        const elements = canvasRef.current?.getElements() ?? [];
        const effectiveSelectedIds = selectedIds ?? canvasRef.current?.getSelectedIds() ?? [];
        const context = serializeCanvasForAI(elements, effectiveSelectedIds);

        setAiPanel({
            open: true,
            status: 'loading',
            title: AI_ACTION_LABELS[action],
            body: '',
            suggestions: undefined,
            draftElements: [],
        });

        try {
            const response = await demoAiCanvasAdapter({ action, context });
            setAiPanel({
                open: true,
                status: 'ready',
                title: response.title,
                body: response.body,
                suggestions: response.suggestions,
                draftElements: response.draftElements ?? [],
            });
        } catch (error) {
            setAiPanel({
                open: true,
                status: 'error',
                title: 'AI Assistant Error',
                body: error instanceof Error ? error.message : 'Unable to run the AI action.',
                suggestions: undefined,
                draftElements: [],
            });
        }
    }, []);

    const applyAiDraft = useCallback(() => {
        if (aiPanel.draftElements.length === 0) return;
        const currentElements = canvasRef.current?.getElements() ?? [];
        canvasRef.current?.setElements([...currentElements, ...aiPanel.draftElements]);
        canvasRef.current?.setSelectedIds(aiPanel.draftElements.map((element) => element.id));
        setAiPanel(prev => ({
            ...prev,
            title: 'AI Draft Applied',
            body: `${prev.body}\n\nApplied ${prev.draftElements.length} draft element(s) to the canvas.`,
            draftElements: [],
        }));
    }, [aiPanel]);

    return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <header
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 16px',
                    background: '#1a1a2e',
                    color: '#ffffff',
                    fontSize: 13,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    borderBottom: '1px solid #2a2a4a',
                    flexShrink: 0,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <strong style={{ fontSize: 16, letterSpacing: -0.5 }}>f1ow canvas</strong>
                    <span style={{ color: '#888', fontSize: 11 }}>Interactive canvas toolkit on KonvaJS</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#888' }}>Elements: {elementCount}</span>
                    <button onClick={handleUndo} style={headerBtn}>Undo</button>
                    <button onClick={handleRedo} style={headerBtn}>Redo</button>
                    <button onClick={handleReset} style={headerBtn}>Reset View</button>
                    <button onClick={() => runAiAction('draw-architecture')} style={{ ...headerBtn, background: '#7c3aed' }} title="Insert a sample 4-node flow into the canvas (template, no LLM)">
                        Demo: Insert Sample
                    </button>
                    <button onClick={handleExportJSON} style={{ ...headerBtn, background: '#4f46e5' }}>
                        Export JSON
                    </button>
                    <button onClick={handleExportPNG} style={{ ...headerBtn, background: '#059669' }}>
                        Export PNG
                    </button>
                </div>
            </header>

            {/* Canvas — takes remaining space */}
            <div style={{ flex: 1, position: 'relative' }}>
                <FlowCanvas
                    ref={canvasRef}
                    onChange={handleChange}
                    showToolbar={true}
                    showStylePanel={true}
                    showStatusBar={true}
                    showGrid={false}
                    enableShortcuts={true}
                    theme={{
                        canvasBackground: '#fafafa',
                    }}
                    contextMenuItems={(ctx: ContextMenuContext) => {
                        const hasSelection = ctx.selectedIds.length > 0;
                        const aiItems: ContextMenuItem[] = [
                            {
                                label: hasSelection ? 'AI: Explain Selection' : 'AI: Explain Canvas',
                                action: () => runAiAction('explain', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Review Selection' : 'AI: Review Canvas',
                                action: () => runAiAction('review', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Markdown from Selection' : 'AI: Markdown from Canvas',
                                action: () => runAiAction('document', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Draft Architecture from Selection' : 'AI: Draft Architecture',
                                action: () => runAiAction('draft-architecture', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Find Missing Pieces in Selection' : 'AI: Find Missing Pieces',
                                action: () => runAiAction('find-missing-pieces', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Implementation Plan from Selection' : 'AI: Implementation Plan',
                                action: () => runAiAction('implementation-plan', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Agent Brief from Selection' : 'AI: Agent Brief',
                                action: () => runAiAction('agent-brief', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Export TDD / ADR from Selection' : 'AI: Export TDD / ADR',
                                action: () => runAiAction('export-tdd', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: hasSelection ? 'AI: Draw Architecture from Selection' : 'AI: Draw Architecture',
                                action: () => runAiAction('draw-architecture', hasSelection ? ctx.selectedIds : []),
                            },
                            {
                                label: 'AI: Suggest Connections',
                                disabled: hasSelection ? ctx.selectedIds.length < 2 : ctx.elements.length < 2,
                                action: () => runAiAction('suggest-connections', hasSelection ? ctx.selectedIds : []),
                            },
                        ];

                        if (ctx.selectedIds.length === 1) {
                            const el = ctx.elements.find(e => e.id === ctx.selectedIds[0]);
                            if (el && !['line', 'arrow', 'text', 'freedraw'].includes(el.type)) {
                                const id = el.id;
                                const isAnnotated = annotatedIds.has(id);
                                aiItems.push({
                                    label: isAnnotated ? 'Remove Annotation' : 'Add Annotation',
                                    shortcut: '',
                                    action: () => {
                                        setAnnotatedIds(prev => {
                                            const next = new Set(prev);
                                            if (next.has(id)) next.delete(id);
                                            else next.add(id);
                                            return next;
                                        });
                                        ctx.close();
                                    },
                                });
                            }
                        }

                        return aiItems;
                    }}
                    renderAnnotation={({ element: el }) => {
                        // Only render badges for elements explicitly annotated via context menu
                        if (!annotatedIds.has(el.id)) return null;

                        // Badge scales naturally with element (world-space)
                        const badge: React.CSSProperties = {
                            position: 'absolute',
                            top: -10,
                            right: -10,
                            pointerEvents: 'auto',
                            borderRadius: '50%',
                            minWidth: 22,
                            height: 22,
                            padding: '0 4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                            fontWeight: 600,
                            fontFamily: 'system-ui, sans-serif',
                            lineHeight: 1,
                            cursor: 'pointer',
                            boxShadow: '0 1px 3px rgba(0,0,0,.15)',
                        };

                        return (
                            <div
                                style={{
                                    ...badge,
                                    background: '#4f46e5',
                                    color: '#fff',
                                }}
                                title={`ID: ${el.id}`}
                                onClick={() => console.log('annotation click →', el)}
                            >
                                {el.type.charAt(0).toUpperCase()}
                            </div>
                        );
                    }}
                />

                {aiPanel.open && (
                    <aside style={aiPanelStyle} aria-live="polite">
                        <div style={aiPanelHeaderStyle}>
                            <div>
                                <div style={aiPanelEyebrowStyle}>AI Assistant</div>
                                <strong style={aiPanelTitleStyle}>{aiPanel.title}</strong>
                            </div>
                            <button
                                type="button"
                                aria-label="Close AI assistant"
                                onClick={() => setAiPanel(prev => ({ ...prev, open: false }))}
                                style={iconButtonStyle}
                            >
                                X
                            </button>
                        </div>

                        <div style={aiPanelBodyStyle}>
                            {aiPanel.status === 'loading' && <div style={mutedTextStyle}>Thinking...</div>}
                            {aiPanel.status !== 'loading' && (
                                <pre style={aiResultStyle}>{aiPanel.body || 'No result.'}</pre>
                            )}

                            {aiPanel.suggestions && aiPanel.suggestions.length > 0 && (
                                <div style={suggestionListStyle}>
                                    {aiPanel.suggestions.map((suggestion) => (
                                        <div key={`${suggestion.sourceId}-${suggestion.targetId}`} style={suggestionItemStyle}>
                                            <strong>{suggestion.label}</strong>
                                            <span style={mutedTextStyle}>
                                                {suggestion.sourceId} {'->'} {suggestion.targetId}
                                            </span>
                                            <span>{suggestion.reason}</span>
                                            <span style={mutedTextStyle}>
                                                Confidence {Math.round(suggestion.confidence * 100)}%
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {aiPanel.draftElements.length > 0 && (
                                <div style={draftBoxStyle}>
                                    <strong>Draft ready</strong>
                                    <span style={mutedTextStyle}>
                                        {aiPanel.draftElements.length} element(s) will be added to the canvas.
                                    </span>
                                    <button type="button" onClick={applyAiDraft} style={primaryPanelBtnStyle}>
                                        Apply Draft to Canvas
                                    </button>
                                </div>
                            )}
                        </div>

                        <div style={aiPanelFooterStyle}>
                            <button type="button" onClick={() => runAiAction('draft-architecture')} style={secondaryBtnStyle}>
                                Architecture
                            </button>
                            <button type="button" onClick={() => runAiAction('implementation-plan')} style={secondaryBtnStyle}>
                                Plan
                            </button>
                            <button type="button" onClick={() => runAiAction('agent-brief')} style={secondaryBtnStyle}>
                                Brief
                            </button>
                            <button type="button" onClick={() => runAiAction('draw-architecture')} style={secondaryBtnStyle}>
                                Draw
                            </button>
                        </div>
                    </aside>
                )}
            </div>
        </div>
    );
};

const headerBtn: React.CSSProperties = {
    padding: '4px 12px',
    borderRadius: 6,
    border: '1px solid #333',
    background: '#2a2a4a',
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
};

const aiPanelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 16,
    right: 16,
    bottom: 16,
    width: 360,
    maxWidth: 'calc(100vw - 32px)',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(255, 255, 255, 0.96)',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.16)',
    zIndex: 900,
    fontFamily: 'system-ui, -apple-system, sans-serif',
};

const aiPanelHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 14px 12px',
    borderBottom: '1px solid #e5e7eb',
};

const aiPanelEyebrowStyle: React.CSSProperties = {
    color: '#64748b',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
};

const aiPanelTitleStyle: React.CSSProperties = {
    display: 'block',
    marginTop: 2,
    color: '#0f172a',
    fontSize: 16,
    lineHeight: '22px',
};

const iconButtonStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: '1px solid #cbd5e1',
    background: '#ffffff',
    color: '#334155',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
};

const aiPanelBodyStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    padding: 14,
    color: '#0f172a',
    fontSize: 13,
    lineHeight: '20px',
};

const aiResultStyle: React.CSSProperties = {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'system-ui, -apple-system, sans-serif',
};

const suggestionListStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 14,
};

const suggestionItemStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 10,
    border: '1px solid #dbe3ef',
    borderRadius: 8,
    background: '#f8fafc',
};

const aiPanelFooterStyle: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    padding: 12,
    borderTop: '1px solid #e5e7eb',
};

const secondaryBtnStyle: React.CSSProperties = {
    flex: 1,
    padding: '7px 10px',
    borderRadius: 6,
    border: '1px solid #cbd5e1',
    background: '#ffffff',
    color: '#1e293b',
    fontSize: 12,
    cursor: 'pointer',
};

const primaryPanelBtnStyle: React.CSSProperties = {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #5b21b6',
    background: '#7c3aed',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
};

const draftBoxStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 14,
    padding: 12,
    border: '1px solid #c4b5fd',
    borderRadius: 8,
    background: '#f5f3ff',
};

const mutedTextStyle: React.CSSProperties = {
    color: '#64748b',
    fontSize: 12,
};

// ─── Mount ──────────────────────────────────────────────────
const root = document.getElementById('root');
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <DemoApp />
        </React.StrictMode>
    );
}
