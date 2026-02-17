/**
 * workerFactory.ts — Unified worker creation with environment detection
 *
 * Provides a consistent API for creating Web Workers that gracefully
 * handles different bundler environments (Vite, Next.js, Webpack, etc.).
 *
 * Strategy:
 * 1. Try custom worker URL if provided (for Next.js/webpack consumers)
 * 2. Try Vite's worker URL pattern — if it's a `data:` URL (inline build),
 *    convert to Blob URL first to avoid webpack Asset Module conflicts
 * 3. Fall back to null (triggers sync fallback in managers)
 */

export interface WorkerConfig {
    /** Custom worker URL (for non-Vite environments) */
    url?: string;
    /** Force disable worker creation */
    disabled?: boolean;
}

/**
 * Convert a `data:` URL to a Blob URL.
 * Vite's inline worker build emits `data:video/mp2t;base64,...` URLs which
 * webpack (Next.js) cannot handle. Converting to Blob URL bypasses this.
 */
function dataUrlToBlobUrl(dataUrl: string): string {
    // Parse: data:[<mediatype>][;base64],<data>
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) throw new Error('Invalid data URL');

    const meta = dataUrl.slice(5, commaIdx); // after "data:"
    const isBase64 = meta.endsWith(';base64');
    const encoded = dataUrl.slice(commaIdx + 1);

    let bytes: Uint8Array;
    if (isBase64) {
        const binary = atob(encoded);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
    } else {
        const text = decodeURIComponent(encoded);
        bytes = new TextEncoder().encode(text);
    }

    // Worker scripts should be application/javascript
    const blob = new Blob([bytes as BlobPart], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
}

/**
 * Accepted worker URL source types.
 *
 * After the `stripImportMetaUrlFromDataUrls` Vite plugin runs, the call
 * sites may pass a plain `data:` string instead of a URL object.
 */
type WorkerUrlSource = URL | string | (() => URL | string);

/**
 * Create a Web Worker with environment-aware fallback.
 *
 * @param viteWorkerUrl - URL, data-URL string, or lazy getter for the worker script
 * @param config - Optional custom URL or disable flag
 * @returns Worker instance or null if creation fails
 */
export function createWorker(
    viteWorkerUrl: WorkerUrlSource,
    config?: WorkerConfig,
): Worker | null {
    // SSR guard
    if (typeof Worker === 'undefined') return null;

    // Explicit disable
    if (config?.disabled) {
        return null;
    }

    // Try custom URL first (for consumers who copy worker files to public/)
    if (config?.url) {
        try {
            return new Worker(config.url, { type: 'module' });
        } catch (err) {
            console.warn('[workerFactory] Failed to create worker from custom URL:', config.url, err);
            return null;
        }
    }

    // Resolve the URL/string from Vite's pattern
    try {
        const raw = typeof viteWorkerUrl === 'function' ? viteWorkerUrl() : viteWorkerUrl;
        const urlString = raw instanceof URL ? raw.href : String(raw);

        // If Vite inlined the worker as a data: URL string,
        // convert to Blob URL to create the Worker.
        if (urlString.startsWith('data:')) {
            const blobUrl = dataUrlToBlobUrl(urlString);
            return new Worker(blobUrl);
        }

        // Standard URL — use module type for ES module workers
        return new Worker(raw instanceof URL ? raw : new URL(urlString), { type: 'module' });
    } catch (err) {
        console.warn('[workerFactory] Worker creation failed, using sync fallback:', err);
        return null;
    }
}

/**
 * Check if Web Workers are supported in the current environment.
 */
export function isWorkerSupported(): boolean {
    return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
}
