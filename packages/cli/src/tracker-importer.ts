import * as path from 'node:path';
import * as TikKernel from '@tik/kernel';
import { JsonTaskImporter, WorkbenchTaskImporter } from '@tik/kernel';
import type { TrackedTaskImporter, TrackerWorkflowDefinition } from '@tik/kernel';

export function buildTaskImporterFromCli(input: {
  workspaceRoot: string;
  file?: string;
  workflow?: TrackerWorkflowDefinition;
  workbench: TikKernel.WorkbenchService;
}): TrackedTaskImporter {
  const workflowTracker = input.workflow?.config.tracker;
  const taskFile = input.file || workflowTracker?.taskFile;
  if (taskFile) {
    return new JsonTaskImporter(path.isAbsolute(taskFile) ? taskFile : path.join(input.workspaceRoot, taskFile));
  }
  if (workflowTracker?.kind === 'linear') {
    throw new Error('Linear runtime import is no longer supported. Import Linear issues into Workbench tasks first, then run tracker against local tasks.');
  }
  return new WorkbenchTaskImporter(input.workbench);
}
