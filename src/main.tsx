import React, { useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { FlowCanvas } from './lib';
import type { FlowCanvasRef, CanvasElement, ContextMenuItem, ContextMenuContext } from './lib';

/**
 * Demo App — shows how to use <FlowCanvas> as a reusable component.
 */
const DemoApp: React.FC = () => {
    const canvasRef = useRef<FlowCanvasRef>(null);
    const [elementCount, setElementCount] = useState(0);
    /** Set of element IDs that have an annotation badge */
    const [annotatedIds, setAnnotatedIds] = useState<Set<string>>(new Set());

    const handleChange = useCallback((elements: CanvasElement[]) => {
        setElementCount(elements.length);
    }, []);

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
                        // Only offer annotation toggle when exactly one shape is selected
                        if (ctx.selectedIds.length !== 1) return [];
                        const el = ctx.elements.find(e => e.id === ctx.selectedIds[0]);
                        if (!el) return [];
                        // Skip connectors / text / freedraw — only shapes
                        if (['line', 'arrow', 'text', 'freedraw'].includes(el.type)) return [];

                        const id = el.id;
                        const isAnnotated = annotatedIds.has(id);

                        return [{
                            label: isAnnotated ? 'Remove Annotation' : 'Add Annotation',
                            shortcut: '',
                            divider: true,
                            action: () => {
                                setAnnotatedIds(prev => {
                                    const next = new Set(prev);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    return next;
                                });
                                ctx.close();
                            },
                        }];
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

// ─── Mount ──────────────────────────────────────────────────
const root = document.getElementById('root');
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <DemoApp />
        </React.StrictMode>
    );
}
