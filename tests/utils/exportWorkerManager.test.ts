import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_STYLE } from '@/constants';
import { ExportWorkerManager } from '@/utils/exportWorkerManager';
import type { CanvasElement } from '@/types';

const originalWorker = globalThis.Worker;

function rectangle(id: string, x: number): CanvasElement {
    return {
        id,
        type: 'rectangle',
        x,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        style: { ...DEFAULT_STYLE },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        version: 0,
        cornerRadius: 0,
    };
}

function manyElements(count: number): CanvasElement[] {
    return Array.from({ length: count }, (_, index) => rectangle(`rect-${index}`, index * 12));
}

afterEach(() => {
    globalThis.Worker = originalWorker;
});

describe('ExportWorkerManager', () => {
    it('falls back to synchronous SVG export when worker postMessage throws', async () => {
        class ThrowingWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(): void {
                throw new Error('structured clone failed');
            }

            terminate(): void {}
        }

        globalThis.Worker = ThrowingWorker as unknown as typeof Worker;

        const manager = new ExportWorkerManager({ url: '/workers/exportWorker.js' });
        const svg = await manager.exportSVG(manyElements(201));

        expect(svg).toContain('<svg');
        expect(svg).toContain('<rect');
        manager.dispose();
    });
});
