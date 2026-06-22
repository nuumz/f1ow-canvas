/**
 * WorkerConfigContext.tsx — React Context for worker configuration
 *
 * Provides worker URLs and disable flags to child components without
 * prop drilling. Used by useElbowWorker and exportWorkerManager
 * to enable Next.js compatibility.
 */
import { createContext, useContext } from 'react';
import type { WorkerConfig } from '@/utils/workerFactory';
import type { ElbowWorkerManager } from '@/utils/elbowWorkerManager';

export interface WorkerConfigContextValue {
    elbowWorkerConfig?: WorkerConfig;
    exportWorkerConfig?: WorkerConfig;
    /**
     * Per-FlowCanvas-instance elbow routing worker manager. Each FlowCanvas
     * creates and owns one, so a canvas routes only against its OWN obstacles
     * and disposing one canvas never tears down another's worker. When absent
     * (no provider, or shapes rendered standalone), consumers fall back to the
     * module-level singleton via `getElbowWorkerManager()`.
     */
    elbowWorkerManager?: ElbowWorkerManager;
}

export const WorkerConfigContext = createContext<WorkerConfigContextValue | undefined>(undefined);

/**
 * Hook to access worker configuration from context.
 * Returns undefined if no provider exists (fallback to default behavior).
 */
export function useWorkerConfig(): WorkerConfigContextValue | undefined {
    return useContext(WorkerConfigContext);
}
