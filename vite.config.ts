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
                    fileName: (format) => `f1ow-canvas.${format === 'es' ? 'js' : 'umd.cjs'}`,
                },
                rollupOptions: {
                    external: ['react', 'react-dom', 'react/jsx-runtime'],
                    output: {
                        globals: {
                            react: 'React',
                            'react-dom': 'ReactDOM',
                            'react/jsx-runtime': 'jsxRuntime',
                        },
                    },
                },
            },
        }),
    };
});

