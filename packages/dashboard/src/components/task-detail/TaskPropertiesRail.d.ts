import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../../api/client';
interface TaskPropertiesRailProps {
    task: WorkbenchTaskResponse;
    pack: EnvironmentPackManifest | null;
    controllingTaskAction?: 'pause' | 'resume' | 'stop' | null;
    /** Extra class composed on the root <aside>. Lets callers re-skin the rail
        (e.g. as a Review Panel) without forking the component. */
    wrapperClassName?: string;
    onUpdateTaskMetadata: (task: WorkbenchTaskResponse, input: Partial<Pick<WorkbenchTaskResponse, 'status' | 'priority' | 'labels' | 'parentTaskId' | 'humanAssignee'>>) => Promise<void>;
    onControlTask: (taskId: string, action: 'pause' | 'resume' | 'stop') => Promise<void>;
}
export declare function TaskPropertiesRail({ task, pack, controllingTaskAction, wrapperClassName, onUpdateTaskMetadata, onControlTask, }: TaskPropertiesRailProps): React.JSX.Element;
export {};
//# sourceMappingURL=TaskPropertiesRail.d.ts.map