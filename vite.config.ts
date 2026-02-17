import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
    const isLib = mode === 'lib';

    return {
        plugins: [
            react(),
            ...(isLib
                ? [dts({ include: ['src/lib', 'src/types', 'src/constants', 'src/utils', 'src/store', 'src/components', 'src/hooks', 'src/workers'] })]
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
                    external: [
                        'react',
                        'react-dom',
                        'react/jsx-runtime',
                        'konva',
                        'react-konva',
                        'zustand',
                        'zustand/middleware',
                        'lucide-react',
                        'nanoid',
                        'rbush',
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
                            'lucide-react': 'LucideReact',
                            nanoid: 'nanoid',
                            rbush: 'RBush',
                            yjs: 'Y',
                            'y-websocket': 'yWebsocket',
                        },
                    },
                },
            },
        }),
    };
});

