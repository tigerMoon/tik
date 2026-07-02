import * as TikKernel from '@tik/kernel';
import type { TrackedTaskImporter, TrackerWorkflowDefinition } from '@tik/kernel';
export declare function buildTaskImporterFromCli(input: {
    workspaceRoot: string;
    file?: string;
    workflow?: TrackerWorkflowDefinition;
    workbench: TikKernel.WorkbenchService;
}): TrackedTaskImporter;
//# sourceMappingURL=tracker-importer.d.ts.map