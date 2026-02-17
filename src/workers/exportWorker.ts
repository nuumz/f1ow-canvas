/**
 * exportWorker.ts — Web Worker for off-main-thread SVG export.
 *
 * Generates SVG strings from serialized element data in a background
 * thread, keeping the main thread responsive during export of large
 * canvases (10K+ elements).
 *
 * Communication protocol:
 *   Main → Worker:
 *     { type: 'exportSVG', requestId: string, elements: CanvasElement[] }
 *   Worker → Main:
 *     { type: 'svgResult', requestId: string, svg: string }
 *     { type: 'error', requestId: string, message: string }
 *
 * Uses Vite's native Worker module support — imported with:
 *   new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
 */

import { exportToSVG } from '@/utils/export';
import type { CanvasElement } from '@/types';

// ─── Message Types ────────────────────────────────────────────

interface ExportSVGMessage {
    type: 'exportSVG';
    requestId: string;
    elements: CanvasElement[];
}

type IncomingMessage = ExportSVGMessage;

interface SVGResultMessage {
    type: 'svgResult';
    requestId: string;
    svg: string;
}

interface ErrorMessage {
    type: 'error';
    requestId: string;
    message: string;
}

type OutgoingMessage = SVGResultMessage | ErrorMessage;

// ─── Worker main ──────────────────────────────────────────────

self.onmessage = (ev: MessageEvent<IncomingMessage>) => {
    const msg = ev.data;

    switch (msg.type) {
        case 'exportSVG': {
            try {
                const svg = exportToSVG(msg.elements);
                const response: OutgoingMessage = {
                    type: 'svgResult',
                    requestId: msg.requestId,
                    svg,
                };
                self.postMessage(response);
            } catch (err) {
                const response: OutgoingMessage = {
                    type: 'error',
                    requestId: msg.requestId,
                    message: err instanceof Error ? err.message : String(err),
                };
                self.postMessage(response);
            }
            break;
        }
        default:
            break;
    }
};
