import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchDecisionResponse, WorkbenchTaskResponse, WorkbenchTimelineResponseItem } from '../api/client';
interface DashboardState {
    tasks: WorkbenchTaskResponse[];
    activeTaskId: string | null;
    timeline: WorkbenchTimelineResponseItem[];
    decisions: WorkbenchDecisionResponse[];
    packs: EnvironmentPackManifest[];
    activePackId: string | null;
    setTasks: (tasks: WorkbenchTaskResponse[]) => void;
    setActiveTask: (taskId: string | null) => void;
    setTimeline: (timeline: WorkbenchTimelineResponseItem[]) => void;
    setDecisions: (decisions: WorkbenchDecisionResponse[]) => void;
    setPacks: (packs: EnvironmentPackManifest[], activePackId: string | null) => void;
}
export declare const useStore: import("zustand").UseBoundStore<import("zustand").StoreApi<DashboardState>>;
export {};
//# sourceMappingURL=store.d.ts.map