import React, { useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { FlowCanvas } from './lib';
import type { FlowCanvasRef, CanvasElement } from './lib';

/**
 * Demo App — shows how to use <FlowCanvas> as a reusable component.
 */
const DemoApp: React.FC = () => {
    const canvasRef = useRef<FlowCanvasRef>(null);
    const [elementCount, setElementCount] = useState(0);

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
