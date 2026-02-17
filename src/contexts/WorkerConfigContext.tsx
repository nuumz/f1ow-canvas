/**
 * WorkerConfigContext.tsx — React Context for worker configuration
 *
 * Provides worker URLs and disable flags to child components without
 * prop drilling. Used by useElbowWorker and exportWorkerManager
 * to enable Next.js compatibility.
 */
import { createContext, useContext } from 'react';
import type { WorkerConfig } from '@/utils/workerFactory';

export interface WorkerConfigContextValue {
    elbowWorkerConfig?: WorkerConfig;
    exportWorkerConfig?: WorkerConfig;
}

export const WorkerConfigContext = createContext<WorkerConfigContextValue | undefined>(undefined);

/**
 * Hook to access worker configuration from context.
 * Returns undefined if no provider exists (fallback to default behavior).
 */
export function useWorkerConfig(): WorkerConfigContextValue | undefined {
    return useContext(WorkerConfigContext);
}
