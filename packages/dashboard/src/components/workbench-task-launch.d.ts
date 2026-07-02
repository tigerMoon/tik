import { type EnvironmentPackManifest, type WorkbenchTaskStatus } from '@tik/shared';
export interface WorkbenchTaskLaunchValidation {
    valid: boolean;
    titleError: string | null;
    goalError: string | null;
}
export declare const emptyLaunchValidation: WorkbenchTaskLaunchValidation;
export declare function validateWorkbenchTaskLaunchDraft(input: {
    title: string;
    goal: string;
    attachmentCount?: number;
}): WorkbenchTaskLaunchValidation;
export declare function shouldInitializeWorkbenchTaskLaunchDraft(input: {
    launcherOpen: boolean;
    wasLauncherOpen: boolean;
}): boolean;
export declare function buildWorkbenchTaskLaunchInput(input: {
    title: string;
    status: Extract<WorkbenchTaskStatus, 'backlog' | 'todo'>;
    labels: string[];
    selectedPack: Pick<EnvironmentPackManifest, 'taskLabels'> | null;
}): {
    status: Extract<WorkbenchTaskStatus, 'backlog' | 'todo'>;
    labels: string[];
};
//# sourceMappingURL=workbench-task-launch.d.ts.map