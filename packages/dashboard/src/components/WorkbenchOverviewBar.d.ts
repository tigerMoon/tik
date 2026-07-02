import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';
interface WorkbenchOverviewBarProps {
    tasks: WorkbenchTaskResponse[];
    packs: EnvironmentPackManifest[];
    activePackId: string | null;
    activeTask: WorkbenchTaskResponse | null;
    selectedLens: WorkbenchLens;
    onSelectLens: (lens: WorkbenchLens) => void;
}
export declare function WorkbenchOverviewBar({ tasks, packs, activePackId, activeTask, selectedLens, onSelectLens, }: WorkbenchOverviewBarProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkbenchOverviewBar.d.ts.map