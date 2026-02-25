import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

