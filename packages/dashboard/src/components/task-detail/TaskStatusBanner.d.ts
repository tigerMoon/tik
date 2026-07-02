import React from 'react';
import type { TaskStatusBannerAction, TaskStatusBannerSpec } from '../../view-models/workbench';
interface TaskStatusBannerProps {
    spec: TaskStatusBannerSpec | null;
    busyActionId?: TaskStatusBannerAction['id'] | null;
    onAction?: (action: TaskStatusBannerAction) => void;
}
export declare function TaskStatusBanner({ spec, busyActionId, onAction }: TaskStatusBannerProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=TaskStatusBanner.d.ts.map