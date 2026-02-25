import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Rollup plugin: stub out `new URL("./worker.ts", import.meta.url)` expressions
 * in lib builds.
 *
 * When building as a library, Vite inlines worker scripts as base64 data-URLs
 * (e.g. `"data:video/mp2t;base64,<thousands of chars>"`). npm's security
 * scanner flags these as "obfuscated code".
 *
 * This plugin replaces every `new URL(<worker-file>, import.meta.url)` with
 * the string `"__worker_stub__"`. The workerFactory.createWorker() function
 * already handles unknown URLs by falling back to sync (main-thread) mode, so
 * workers stay opt-in via the `workerConfig` prop that consumers supply.
 */
function stubWorkerUrlsInLibBuild(): import('vite').Plugin {
    // Matches: new URL("./foo.worker.ts", import.meta.url)
    //          new URL('../workers/elbowWorker.ts', import.meta.url)
    const WORKER_URL_RE = /new\s+URL\(\s*(['"][^'"]*(?:worker|Worker)[^'"]*['"])\s*,\s*import\.meta\.url\s*\)/g;
    return {
        name: 'stub-worker-urls-in-lib',
        apply: 'build',
        transform(code, id) {
            if (!WORKER_URL_RE.test(code)) return null;
            WORKER_URL_RE.lastIndex = 0;
            const patched = code.replace(WORKER_URL_RE, '"__worker_stub__"');
            return { code: patched };
        },
    };
}

/**
 * Rollup plugin: strip `import.meta.url` from data-URL constructors.
 *
 * Vite inlines workers as:
 *   new URL("data:video/mp2t;base64,...", import.meta.url)
 *
 * webpack 5 (Next.js) statically detects `new URL(..., import.meta.url)`
 * and tries to process it as an asset module, which fails for data URLs.
 *
 * Since data URLs are absolute, the base argument is unnecessary.
 * This plugin rewrites them to plain string literals:
 *   "data:video/mp2t;base64,..."
 */
function stripImportMetaUrlFromDataUrls(): import('vite').Plugin {
    return {
        name: 'strip-data-url-import-meta',
        apply: 'build',
        renderChunk(code) {
            // Match: new URL("data:...", import.meta.url)
            // Replace with: "data:..."  (plain string — no URL constructor)
            const re = /new\s+URL\(\s*("data:[^"]+")\s*,\s*import\.meta\.url\s*\)/g;
            if (!re.test(code)) return null;
            return code.replace(re, '$1');
        },
    };
}

export default defineConfig(({ mode }) => {
    const isLib = mode === 'lib';

    return {
        plugins: [
            react(),
            ...(isLib
                ? [
                      dts({ include: ['src/lib', 'src/types', 'src/constants', 'src/utils', 'src/store', 'src/components', 'src/hooks', 'src/workers'] }),
                      stubWorkerUrlsInLibBuild(),
                      stripImportMetaUrlFromDataUrls(),
                  ]
                : []),
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        ...(isLib && {
            build: {
                // Libraries should NOT be minified — consumers' bundlers handle
                // minification. Un-minified output also prevents npm's security
                // scanner from flagging readable code as "obfuscated".
                minify: false,
                lib: {
                    entry: path.resolve(__dirname, 'src/lib/index.ts'),
                    name: 'FlowCanvas',
                    formats: ['es', 'umd'] as const,
                    fileName: (format) => `f1ow.${format === 'es' ? 'js' : 'umd.cjs'}`,
                },
                rollupOptions: {
                    // Packages that consumers must provide (peerDependencies).
                    // nanoid, rbush, lucide-react are bundled — no install required by consumers.
                    // yjs + y-websocket are optional peerDeps — only needed for collaboration.
                    external: [
                        'react',
                        'react-dom',
                        'react/jsx-runtime',
                        'konva',
                        'react-konva',
                        'zustand',
                        'zustand/middleware',
                        'yjs',
                        'y-websocket',
                    ],
                    output: {
                        globals: {
                            react: 'React',
                            'react-dom': 'ReactDOM',
                            'react/jsx-runtime': 'jsxRuntime',
                            konva: 'Konva',
                            'react-konva': 'ReactKonva',
                            zustand: 'zustand',
                            'zustand/middleware': 'zustandMiddleware',
                            yjs: 'Y',
                            'y-websocket': 'yWebsocket',
                        },
                    },
                },
            },
        }),
    };
});

