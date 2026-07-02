import type { Command } from 'commander';
import { type WorkspaceExecutionTarget, type WorkspaceExecutionTargetInput } from '@tik/kernel';
export interface TrackerCommandServices {
    workspaceWorktreeManager: {
        getExecutionTarget(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget>;
    };
}
export declare function registerTrackerCommands(program: Command, services: TrackerCommandServices): void;
//# sourceMappingURL=tracker-command.d.ts.map