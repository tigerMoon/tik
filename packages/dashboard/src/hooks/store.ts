import { create } from 'zustand';
import type { EnvironmentPackManifest } from '@tik/shared';
import type {
  WorkbenchDecisionResponse,
  WorkbenchTaskResponse,
  WorkbenchTimelineResponseItem,
} from '../api/client';

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

export const useStore = create<DashboardState>((set) => ({
  tasks: [],
  activeTaskId: null,
  timeline: [],
  decisions: [],
  packs: [],
  activePackId: null,
  setTasks: (tasks) => set({ tasks }),
  setActiveTask: (activeTaskId) => set({ activeTaskId, timeline: [], decisions: [] }),
  setTimeline: (timeline) => set({ timeline }),
  setDecisions: (decisions) => set({ decisions }),
  setPacks: (packs, activePackId) => set({ packs, activePackId }),
}));
