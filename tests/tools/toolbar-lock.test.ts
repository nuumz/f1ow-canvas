import React, { act } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createCanvasStore } from '@/store/useCanvasStore';
import { CanvasStoreProvider } from '@/store/CanvasStoreContext';
import Toolbar from '@/components/Toolbar/Toolbar';
import { TOOLS } from '@/constants';
import { DEFAULT_THEME } from '@/lib/FlowCanvasProps';

const h = React.createElement;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

function renderToolbar(store: ReturnType<typeof createCanvasStore>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(
            h(CanvasStoreProvider, { store } as never,
                h(Toolbar as never, { visibleTools: TOOLS, theme: DEFAULT_THEME, position: 'bottom' } as never)),
        );
    });
    return container;
}

describe('Toolbar tool-lock button', () => {
    it('clicking the lock button toggles toolLocked in the store', () => {
        const store = createCanvasStore();
        const el = renderToolbar(store);

        const lockBtn = el.querySelector<HTMLButtonElement>(
            'button[title^="Keep selected tool active"]',
        );
        expect(lockBtn).toBeTruthy();
        expect(store.getState().toolLocked).toBe(false);

        act(() => { lockBtn!.click(); });
        expect(store.getState().toolLocked).toBe(true);

        act(() => { lockBtn!.click(); });
        expect(store.getState().toolLocked).toBe(false);
    });
});
