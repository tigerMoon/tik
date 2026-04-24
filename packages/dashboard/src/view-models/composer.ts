import type { WorkbenchDecisionResponse, WorkbenchTaskResponse } from '../api/client';

export type UniversalComposerIntent =
  | {
    kind: 'create_task';
    title: string;
    goal: string;
    explicit: boolean;
  }
  | {
    kind: 'resolve_decision';
    optionId: 'approve' | 'reject';
    message?: string;
    targetTaskId?: string;
    targetTaskLabel?: string;
  }
  | {
    kind: 'apply_note';
    note: string;
    targetTaskId?: string;
    targetTaskLabel?: string;
  };

const CREATE_TASK_PREFIX = /^(?:new(?:\s+task)?|create(?:\s+task)?|task|新任务|创建任务)\s*[:：-]?\s*/i;
const HASH_CREATE_PREFIX = /^#(?:new|create|task)\s*[:：-]?\s*/i;
const HASH_NOTE_PREFIX = /^#note\s*[:：-]?\s*/i;
const HASH_APPROVE_PREFIX = /^#approve\s*[:：-]?\s*(.*)$/i;
const HASH_REJECT_PREFIX = /^#reject\s*[:：-]?\s*(.*)$/i;
const APPROVE_PREFIX = /^(?:approve|approved|go\s+ahead|continue|yes|okay|ok|批准|同意|通过|继续)\s*[:：-]?\s*(.*)$/i;
const REJECT_PREFIX = /^(?:reject|decline|stop|no|驳回|拒绝|否决|不同意|停止)\s*[:：-]?\s*(.*)$/i;

export function parseUniversalComposerIntent(input: string, options: {
  task: WorkbenchTaskResponse | null;
  tasks?: WorkbenchTaskResponse[];
  decisions?: WorkbenchDecisionResponse[];
}): UniversalComposerIntent | null {
  const trimmed = normalizeComposerInput(input);
  if (!trimmed) {
    return null;
  }

  const targetResolution = resolveComposerTarget(trimmed, options.tasks || [], options.task);
  const remainingInput = targetResolution.remainingInput;
  const effectiveTask = targetResolution.task || options.task;
  const canResolveDecision = effectiveTask?.id === options.task?.id;

  const explicitHashApprove = matchDecisionCommand(remainingInput, HASH_APPROVE_PREFIX);
  if (explicitHashApprove !== null) {
    return {
      kind: 'resolve_decision',
      optionId: 'approve',
      message: explicitHashApprove || undefined,
      targetTaskId: effectiveTask?.id,
      targetTaskLabel: effectiveTask?.title,
    };
  }

  const explicitHashReject = matchDecisionCommand(remainingInput, HASH_REJECT_PREFIX);
  if (explicitHashReject !== null) {
    return {
      kind: 'resolve_decision',
      optionId: 'reject',
      message: explicitHashReject || undefined,
      targetTaskId: effectiveTask?.id,
      targetTaskLabel: effectiveTask?.title,
    };
  }

  const explicitCreate = HASH_CREATE_PREFIX.test(remainingInput) || CREATE_TASK_PREFIX.test(remainingInput);
  if (explicitCreate) {
    const createInput = remainingInput
      .replace(HASH_CREATE_PREFIX, '')
      .replace(CREATE_TASK_PREFIX, '')
      .trim() || remainingInput;
    return {
      kind: 'create_task',
      ...deriveComposerTaskDraft(createInput),
      explicit: true,
    };
  }

  if (HASH_NOTE_PREFIX.test(remainingInput)) {
    return {
      kind: 'apply_note',
      note: normalizeComposerInput(remainingInput.replace(HASH_NOTE_PREFIX, '')),
      targetTaskId: effectiveTask?.id,
      targetTaskLabel: effectiveTask?.title,
    };
  }

  if (!effectiveTask) {
    return {
      kind: 'create_task',
      ...deriveComposerTaskDraft(remainingInput),
      explicit: false,
    };
  }

  const activeDecision = canResolveDecision ? resolvePendingDecision(options.decisions || []) : null;
  if (activeDecision) {
    const approveMessage = matchDecisionCommand(remainingInput, APPROVE_PREFIX);
    if (approveMessage !== null) {
      return {
        kind: 'resolve_decision',
        optionId: 'approve',
        message: approveMessage || undefined,
        targetTaskId: effectiveTask.id,
        targetTaskLabel: effectiveTask.title,
      };
    }

    const rejectMessage = matchDecisionCommand(remainingInput, REJECT_PREFIX);
    if (rejectMessage !== null) {
      return {
        kind: 'resolve_decision',
        optionId: 'reject',
        message: rejectMessage || undefined,
        targetTaskId: effectiveTask.id,
        targetTaskLabel: effectiveTask.title,
      };
    }
  }

  return {
    kind: 'apply_note',
    note: remainingInput,
    targetTaskId: effectiveTask.id,
    targetTaskLabel: effectiveTask.title,
  };
}

export function deriveComposerTaskDraft(input: string): { title: string; goal: string } {
  const goal = normalizeComposerInput(input);
  const pipeParts = goal.split(/\s*[|｜]\s*/).map((part) => part.trim()).filter(Boolean);

  if (pipeParts.length > 1) {
    return {
      title: truncateComposerTitle(pipeParts[0]!),
      goal: pipeParts.slice(1).join(' | '),
    };
  }

  const firstClause = goal
    .split(/[。！？!?；;，,\n]/)
    .map((part) => part.trim())
    .find(Boolean) || goal;

  return {
    title: truncateComposerTitle(firstClause),
    goal,
  };
}

function resolvePendingDecision(decisions: WorkbenchDecisionResponse[]): WorkbenchDecisionResponse | null {
  return decisions.find((decision) => decision.status === 'pending') || decisions[0] || null;
}

function resolveComposerTarget(
  input: string,
  tasks: WorkbenchTaskResponse[],
  activeTask: WorkbenchTaskResponse | null,
): {
  task: WorkbenchTaskResponse | null;
  remainingInput: string;
} {
  const match = input.match(/^@([^\s]+)\s+(.+)$/);
  if (!match) {
    return {
      task: activeTask,
      remainingInput: input,
    };
  }

  const token = match[1];
  const remainingInput = normalizeComposerInput(match[2] || '');
  const resolvedTask = resolveTaskToken(token, tasks);

  if (!resolvedTask) {
    return {
      task: activeTask,
      remainingInput: input,
    };
  }

  return {
    task: resolvedTask,
    remainingInput,
  };
}

function resolveTaskToken(token: string, tasks: WorkbenchTaskResponse[]): WorkbenchTaskResponse | null {
  const normalized = token.trim().replace(/^@/, '');
  const upper = normalized.toUpperCase();

  return tasks.find((task) => (
    task.id.toUpperCase() === upper
    || task.id.slice(0, 8).toUpperCase() === upper
  )) || null;
}

function matchDecisionCommand(input: string, pattern: RegExp): string | null {
  const match = input.match(pattern);
  if (!match) {
    return null;
  }

  return normalizeComposerInput(match[1] || '');
}

function truncateComposerTitle(value: string, maxLength = 36): string {
  const normalized = normalizeComposerInput(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function normalizeComposerInput(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
