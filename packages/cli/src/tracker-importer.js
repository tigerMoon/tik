import * as path from 'node:path';
import { JsonTaskImporter, WorkflowV2WorkbenchTaskImporter } from '@tik/kernel';
export function buildTaskImporterFromCli(input) {
    if (input.workflow?.version !== 2) {
        throw new Error('Workflow v2 is required for tracker importing.');
    }
    const workflowTracker = input.workflow?.config.tracker;
    const taskFile = input.file || workflowTracker?.taskFile;
    if (taskFile) {
        return new JsonTaskImporter(path.isAbsolute(taskFile) ? taskFile : path.join(input.workspaceRoot, taskFile));
    }
    if (workflowTracker?.kind === 'linear') {
        throw new Error('Linear runtime import is no longer supported. Import Linear issues into Workbench tasks first, then run tracker against local tasks.');
    }
    return new WorkflowV2WorkbenchTaskImporter(input.workbench, input.workspaceRoot);
}
//# sourceMappingURL=tracker-importer.js.map