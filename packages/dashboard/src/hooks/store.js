import { create } from 'zustand';
export const useStore = create((set) => ({
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
//# sourceMappingURL=store.js.map