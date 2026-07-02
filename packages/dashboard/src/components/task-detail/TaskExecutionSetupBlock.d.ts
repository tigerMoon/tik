import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import { type UpdateWorkbenchTaskConfigurationInput, type WorkbenchTaskResponse } from '../../api/client';
interface TaskExecutionSetupBlockProps {
    task: WorkbenchTaskResponse;
    pack: EnvironmentPackManifest | null;
    packs: EnvironmentPackManifest[];
    savingConfiguration: boolean;
    onSaveTaskConfiguration: (taskId: string, selection: UpdateWorkbenchTaskConfigurationInput) => Promise<void>;
}
export declare function TaskExecutionSetupBlock({ task, pack, packs, savingConfiguration, onSaveTaskConfiguration, }: TaskExecutionSetupBlockProps): React.JSX.Element;
export {};
//# sourceMappingURL=TaskExecutionSetupBlock.d.ts.map