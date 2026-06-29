import {
  getWorkbenchLabelAction,
  getWorkbenchLabelDefinitions,
  type EnvironmentPackManifest,
  type WorkbenchTaskStatus,
} from '@tik/shared';
import { validateWorkbenchTaskLaunchDraftWithAttachments } from '../view-models/task-goal-attachments';

export interface WorkbenchTaskLaunchValidation {
  valid: boolean;
  titleError: string | null;
  goalError: string | null;
}

export const emptyLaunchValidation: WorkbenchTaskLaunchValidation = {
  valid: true,
  titleError: null,
  goalError: null,
};

export function validateWorkbenchTaskLaunchDraft(input: {
  title: string;
  goal: string;
  attachmentCount?: number;
}): WorkbenchTaskLaunchValidation {
  return validateWorkbenchTaskLaunchDraftWithAttachments(input);
}

export function shouldInitializeWorkbenchTaskLaunchDraft(input: {
  launcherOpen: boolean;
  wasLauncherOpen: boolean;
}): boolean {
  return input.launcherOpen && !input.wasLauncherOpen;
}

export function buildWorkbenchTaskLaunchInput(input: {
  title: string;
  status: Extract<WorkbenchTaskStatus, 'backlog' | 'todo'>;
  labels: string[];
  selectedPack: Pick<EnvironmentPackManifest, 'taskLabels'> | null;
}): {
  status: Extract<WorkbenchTaskStatus, 'backlog' | 'todo'>;
  labels: string[];
} {
  if (input.status !== 'todo') {
    return {
      status: input.status,
      labels: input.labels,
    };
  }

  if (input.labels.some((label) => {
    const action = getWorkbenchLabelAction(input.selectedPack, label);
    return action === 'codex_dispatch' || action === 'codex_fix';
  })) {
    return {
      status: input.status,
      labels: input.labels,
    };
  }

  const defaultLabel = selectDefaultDispatchLabel(input.selectedPack, input.title);
  return {
    status: input.status,
    labels: defaultLabel ? [...input.labels, defaultLabel].sort() : input.labels,
  };
}

function selectDefaultDispatchLabel(
  environment: Pick<EnvironmentPackManifest, 'taskLabels'> | null,
  title: string,
): string | null {
  const dispatchLabels = getWorkbenchLabelDefinitions(environment).filter((definition) => (
    definition.action === 'codex_dispatch' || definition.action === 'codex_fix'
  ));
  if (dispatchLabels.length === 0) return null;

  const normalizedTitle = title.toLowerCase();
  if (/\b(readme|docs?|documentation|markdown|md)\b/.test(normalizedTitle)) {
    return dispatchLabels.find((definition) => definition.value === 'docs')?.value || dispatchLabels[0]!.value;
  }

  return dispatchLabels.find((definition) => definition.value === 'implementation')?.value
    || dispatchLabels[0]!.value;
}
