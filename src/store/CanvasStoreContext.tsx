/**
 * CanvasStoreContext — React context for providing a canvas store instance
 * to a `<FlowCanvas>` subtree.
 *
 * The default value is the module-level singleton `useCanvasStore`, so any
 * subscriber that does not have a provider above it falls back to the
 * legacy global store. This keeps every existing call site working while
 * giving multi-instance apps a path to opt into isolated stores via
 * `<CanvasStoreProvider>`.
 *
 * Usage (multi-instance):
 * ```tsx
 * const storeA = useMemo(() => createCanvasStore(), []);
 * const storeB = useMemo(() => createCanvasStore(), []);
 * <CanvasStoreProvider store={storeA}><FlowCanvas /></CanvasStoreProvider>
 * <CanvasStoreProvider store={storeB}><FlowCanvas /></CanvasStoreProvider>
 * ```
 *
 * Status: tools (`src/tools/*`) now act through the resolved per-instance
 * store via `ToolContext.store`, the keyboard-shortcut hook receives the
 * resolved store as a parameter, and each FlowCanvas owns its own elbow
 * routing worker + per-stage `pixelRatio` — so those subsystems are fully
 * isolated per instance. The remaining singleton consumer is the
 * collaboration sync bridge (`useCollaboration`), which still subscribes to
 * the module-level store; threading the resolved store into it is the final
 * (Phase 3) step toward complete multi-instance isolation.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useCanvasStore, type CanvasStore } from './useCanvasStore';

const CanvasStoreContext = createContext<CanvasStore | null>(null);

export interface CanvasStoreProviderProps {
    /** Store instance produced by `createCanvasStore()`. */
    store: CanvasStore;
    children: ReactNode;
}

export function CanvasStoreProvider({ store, children }: CanvasStoreProviderProps) {
    return <CanvasStoreContext.Provider value={store}>{children}</CanvasStoreContext.Provider>;
}

/**
 * Resolve the canvas store for the current React subtree. Falls back to
 * the singleton `useCanvasStore` when no provider is mounted, so existing
 * single-instance apps work without changes.
 */
export function useCanvasStoreInstance(): CanvasStore {
    return useContext(CanvasStoreContext) ?? useCanvasStore;
}
