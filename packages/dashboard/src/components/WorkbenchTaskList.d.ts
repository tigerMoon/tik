import React from 'react';
import type { EnvironmentPackManifest, EnvironmentPackSelection } from '@tik/shared';
import { type CreateWorkbenchTaskInput, type WorkbenchTaskResponse } from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';
import { type WorkspaceBindingOption, type WorkspaceScopeKey } from '../view-models/workspace-hierarchy';
interface WorkbenchTaskListProps {
    packs: EnvironmentPackManifest[];
    activePackId: string | null;
    tasks: WorkbenchTaskResponse[];
    activeTask: WorkbenchTaskResponse | null;
    activeTaskId: string | null;
    selectedLens: WorkbenchLens;
    loading?: boolean;
    launcherOpen: boolean;
    launcherSeedPackId?: string | null;
    launcherSeedSelection?: EnvironmentPackSelection | null;
    launcherSeedSource?: 'focused-task' | 'active-pack';
    bindingOptions: WorkspaceBindingOption[];
    selectedBindingKey: WorkspaceScopeKey;
    onSelectTask: (taskId: string) => void;
    onCreateTask: (title: string, goal: string, input?: CreateWorkbenchTaskInput) => Promise<void>;
    onToggleLauncher: (open: boolean) => void;
}
export declare function WorkbenchTaskList({ packs, activePackId, tasks, activeTask, activeTaskId, selectedLens, loading, launcherOpen, launcherSeedPackId, launcherSeedSelection, launcherSeedSource, bindingOptions, selectedBindingKey, onSelectTask, onCreateTask, onToggleLauncher, }: WorkbenchTaskListProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkbenchTaskList.d.ts.map