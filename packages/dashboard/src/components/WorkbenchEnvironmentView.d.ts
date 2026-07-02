import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { EnvironmentPackDashboardResponse, WorkbenchTaskResponse } from '../api/client';
interface WorkbenchEnvironmentViewProps {
    packs: EnvironmentPackManifest[];
    activePackId: string | null;
    tasks: WorkbenchTaskResponse[];
    lastSyncedAt: string | null;
    dashboard?: EnvironmentPackDashboardResponse | null;
    onSwitchPack: (packId: string) => Promise<void>;
    onUsePackForNewTask: (packId: string) => Promise<void>;
    onOpenTask: (taskId: string) => void;
}
export declare function WorkbenchEnvironmentView({ packs, activePackId, tasks, lastSyncedAt, dashboard, onSwitchPack, onUsePackForNewTask, onOpenTask, }: WorkbenchEnvironmentViewProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkbenchEnvironmentView.d.ts.map