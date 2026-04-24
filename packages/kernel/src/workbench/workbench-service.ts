import {
  canArchiveWorkbenchTask,
  canRetryWorkbenchTask,
  EventType,
  generateId,
  isWorkbenchTerminalStatus,
} from '@tik/shared';
import type {
  AgentEvent,
  CreateWorkbenchTaskInput,
  IEventBus,
  Task,
  ToolCalledPayload,
  ToolResultPayload,
  WorkbenchDecisionRecord,
  WorkbenchTaskEvidenceSummary,
  WorkbenchTaskRecord,
  WorkbenchTaskStatus,
  WorkbenchTimelineItem,
} from '@tik/shared';
import { WorkbenchStore } from './workbench-store.js';
import { shouldRequestDecisionForTool } from './workbench-decision-policy.js';

interface WorkbenchServiceOptions {
  rootPath: string;
  eventBus: IEventBus;
  store: WorkbenchStore;
}

export class WorkbenchService {
  private readonly eventBus: IEventBus;
  private readonly store: WorkbenchStore;
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkbenchServiceOptions) {
    this.eventBus = options.eventBus;
    this.store = options.store;
    this.eventBus.onAny((event) => {
      this.eventQueue = this.eventQueue.then(
        () => this.handleEvent(event),
        () => this.handleEvent(event),
      );
    });
  }

  async createTask(input: CreateWorkbenchTaskInput, taskId = generateId()): Promise<WorkbenchTaskRecord> {
    const timestamp = new Date().toISOString();
    const sessionId = generateId();
    const task: WorkbenchTaskRecord = {
      id: taskId,
      title: input.title,
      goal: input.goal,
      status: 'new',
      createdAt: timestamp,
      updatedAt: timestamp,
      activeSessionId: sessionId,
      currentOwner: 'supervisor',
      latestSummary: 'Task created. Supervisor will start shortly.',
      environmentPackSnapshot: input.environmentPackSnapshot,
      environmentPackSelection: input.environmentPackSelection,
      workspaceBinding: input.workspaceBinding,
    };

    await this.store.upsertTask(task);
    await this.store.upsertSession({
      id: sessionId,
      taskId: task.id,
      status: 'running',
      owner: 'supervisor',
      createdAt: timestamp,
      updatedAt: timestamp,
      compactSummary: task.latestSummary,
    });

    return task;
  }

  async listTasks(): Promise<WorkbenchTaskRecord[]> {
    await this.drainEventQueue();
    const tasks = await this.store.listTasks();
    const projectedTasks: WorkbenchTaskRecord[] = [];

    for (const task of tasks) {
      const bundle = await this.store.readTaskBundle(task.id);
      if (!bundle.task) {
        continue;
      }
      projectedTasks.push(await this.projectTaskState(bundle.task, bundle.timeline));
    }

    return projectedTasks;
  }

  async readTask(taskId: string): Promise<WorkbenchTaskRecord | null> {
    await this.drainEventQueue();
    const bundle = await this.store.readTaskBundle(taskId);
    return bundle.task ? this.projectTaskState(bundle.task, bundle.timeline) : null;
  }

  async readTimeline(taskId: string): Promise<WorkbenchTimelineItem[]> {
    await this.drainEventQueue();
    return (await this.store.readTaskBundle(taskId)).timeline;
  }

  async readPendingDecisions(taskId: string): Promise<WorkbenchDecisionRecord[]> {
    await this.drainEventQueue();
    return this.store.readPendingDecisions(taskId);
  }

  async requestToolApproval(
    taskId: string,
    toolName: string,
  ): Promise<WorkbenchDecisionRecord | null> {
    const bundle = await this.store.readTaskBundle(taskId);
    if (!bundle.task) {
      return null;
    }

    if (bundle.task.waitingDecisionId) {
      const existing = await this.store.readDecision(bundle.task.waitingDecisionId);
      if (existing?.status === 'pending') {
        return existing;
      }
    }

    const createdAt = new Date().toISOString();
    const decision = this.buildHighRiskDecision(taskId, toolName, createdAt);
    const waitingTask: WorkbenchTaskRecord = {
      ...bundle.task,
      status: 'waiting_for_user',
      updatedAt: createdAt,
      latestSummary: `Waiting for operator approval before ${toolName}.`,
      waitingReason: `Awaiting approval for high-risk action: ${toolName}`,
      waitingDecisionId: decision.id,
      lastProgressAt: createdAt,
    };

    await this.store.appendDecision(decision);
    await this.store.appendTimelineItem({
      id: generateId(),
      taskId,
      kind: 'summary',
      actor: 'supervisor',
      body: `Supervisor paused before ${toolName} and opened a decision request.`,
      createdAt,
      decisionId: decision.id,
    });
    await this.store.upsertTask(waitingTask);
    return decision;
  }

  async waitForDecisionResolution(
    decisionId: string,
    options: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<{ decision: WorkbenchDecisionRecord; approved: boolean }> {
    const pollMs = options.pollMs ?? 250;
    const timeoutMs = options.timeoutMs ?? 60_000 * 30;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const decision = await this.store.readDecision(decisionId);
      if (!decision) {
        throw new Error(`Workbench decision not found: ${decisionId}`);
      }

      if (decision.status !== 'pending') {
        return {
          decision,
          approved: decision.status === 'resolved',
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(`Timed out waiting for workbench decision: ${decisionId}`);
  }

  async resolveDecision(
    taskId: string,
    decisionId: string,
    input: { optionId?: string; message?: string },
  ): Promise<{ task: WorkbenchTaskRecord; decision: WorkbenchDecisionRecord; approved: boolean }> {
    const bundle = await this.store.readTaskBundle(taskId);
    if (!bundle.task) {
      throw new Error(`Workbench task not found: ${taskId}`);
    }

    const decision = await this.store.readDecision(decisionId);
    if (!decision || decision.taskId !== taskId) {
      throw new Error(`Workbench decision not found: ${decisionId}`);
    }

    if (decision.status !== 'pending') {
      throw new Error(`Workbench decision is not pending: ${decisionId}`);
    }

    const option = input.optionId
      ? decision.options.find((item) => item.id === input.optionId)
      : decision.options.find((item) => item.id === decision.recommendedOptionId) || decision.options[0];
    if (!option) {
      throw new Error(`Workbench decision option not found: ${input.optionId || 'default'}`);
    }

    const approved = option.id === 'approve';
    const updatedAt = new Date().toISOString();
    const resolvedDecision: WorkbenchDecisionRecord = {
      ...decision,
      status: approved ? 'resolved' : 'dismissed',
      updatedAt,
    };
    const resolutionNote = input.message?.trim();
    const updatedTask: WorkbenchTaskRecord = {
      ...bundle.task,
      status: 'running',
      updatedAt,
      waitingReason: undefined,
      waitingDecisionId: undefined,
      latestSummary: approved
        ? `Operator approved ${decision.title}.`
        : `Operator rejected ${decision.title}; waiting for a safer follow-up.`,
      lastProgressAt: updatedAt,
    };

    const bodyLines = [
      approved
        ? `Approved decision: ${decision.title}`
        : `Rejected decision: ${decision.title}`,
      '',
      `Selected option: ${option.label}`,
    ];

    if (resolutionNote) {
      bodyLines.push('', 'Operator note:', resolutionNote);
    }

    await this.store.appendDecision(resolvedDecision);
    await this.store.appendTimelineItem({
      id: generateId(),
      taskId,
      kind: 'summary',
      actor: 'user',
      body: bodyLines.join('\n'),
      createdAt: updatedAt,
      decisionId,
    });
    await this.store.upsertTask(updatedTask);

    return {
      task: updatedTask,
      decision: resolvedDecision,
      approved,
    };
  }

  async canRetryTask(taskId: string): Promise<boolean> {
    const task = await this.readTask(taskId);
    return task ? canRetryWorkbenchTask(task.status) : false;
  }

  async updateTaskConfiguration(
    taskId: string,
    selection: NonNullable<WorkbenchTaskRecord['environmentPackSelection']>,
    environmentPackSnapshot?: WorkbenchTaskRecord['environmentPackSnapshot'],
  ): Promise<WorkbenchTaskRecord | null> {
    const bundle = await this.store.readTaskBundle(taskId);
    if (!bundle.task) {
      return null;
    }

    const updatedAt = new Date().toISOString();
    const nextSnapshot = environmentPackSnapshot || bundle.task.environmentPackSnapshot;
    const packChanged = nextSnapshot?.id !== bundle.task.environmentPackSnapshot?.id;
    const updatedTask: WorkbenchTaskRecord = {
      ...bundle.task,
      updatedAt,
      environmentPackSnapshot: nextSnapshot,
      environmentPackSelection: selection,
      latestSummary: packChanged
        ? `Rebound task to ${nextSnapshot?.id || 'default'} and updated runtime configuration.`
        : `Updated task configuration: ${selection.selectedSkills.length} skill(s), ${selection.selectedKnowledgeIds.length} knowledge source(s).`,
    };

    await this.store.appendTimelineItem({
      id: generateId(),
      taskId,
      kind: 'summary',
      actor: 'user',
      body: [
        'Updated task configuration.',
        nextSnapshot?.id ? `Environment: ${nextSnapshot.id}.` : null,
        `Skills: ${selection.selectedSkills.join(', ') || 'none'}.`,
        `Knowledge: ${selection.selectedKnowledgeIds.join(', ') || 'none'}.`,
      ].filter(Boolean).join(' '),
      createdAt: updatedAt,
    });
    await this.store.upsertTask(updatedTask);
    return updatedTask;
  }

  async updateTaskBrief(
    taskId: string,
    input: {
      title: string;
      goal: string;
      adjustment?: string;
    },
  ): Promise<WorkbenchTaskRecord | null> {
    const bundle = await this.store.readTaskBundle(taskId);
    if (!bundle.task) {
      return null;
    }

    const updatedAt = new Date().toISOString();
    const adjustment = input.adjustment?.trim();
    const updatedTask: WorkbenchTaskRecord = {
      ...bundle.task,
      title: input.title,
      goal: input.goal,
      updatedAt,
      latestSummary: adjustment
        ? 'Operator adjusted the task brief and added next-pass guidance.'
        : 'Operator adjusted the task brief.',
      lastAdjustment: {
        previousTitle: bundle.task.title,
        previousGoal: bundle.task.goal,
        nextTitle: input.title,
        nextGoal: input.goal,
        note: adjustment,
        appliedAt: updatedAt,
      },
    };

    const bodyLines = [
      'Adjusted task brief.',
      '',
      `Title: ${input.title}`,
      '',
      'Goal:',
      input.goal,
    ];

    if (adjustment) {
      bodyLines.push('', 'Adjustment note:', adjustment);
    }

    await this.store.appendTimelineItem({
      id: generateId(),
      taskId,
      kind: 'summary',
      actor: 'user',
      body: bodyLines.join('\n'),
      createdAt: updatedAt,
    });
    await this.store.upsertTask(updatedTask);
    return updatedTask;
  }

  async revertLastTaskAdjustment(taskId: string): Promise<WorkbenchTaskRecord | null> {
    const bundle = await this.store.readTaskBundle(taskId);
    if (!bundle.task) {
      return null;
    }

    if (!bundle.task.lastAdjustment) {
      throw new Error(`Workbench task ${taskId} has no reversible adjustment`);
    }

    const updatedAt = new Date().toISOString();
    const revertedTask: WorkbenchTaskRecord = {
      ...bundle.task,
      title: bundle.task.lastAdjustment.previousTitle,
      goal: bundle.task.lastAdjustment.previousGoal,
      updatedAt,
      latestSummary: 'Operator reverted the latest task adjustment.',
      lastAdjustment: undefined,
    };

    const bodyLines = [
      'Reverted latest task adjustment.',
      '',
      `Title: ${revertedTask.title}`,
      '',
      'Goal:',
      revertedTask.goal,
    ];

    if (bundle.task.lastAdjustment.note) {
      bodyLines.push('', `Reverted note: ${bundle.task.lastAdjustment.note}`);
    }

    await this.store.appendTimelineItem({
      id: generateId(),
      taskId,
      kind: 'summary',
      actor: 'user',
      body: bodyLines.join('\n'),
      createdAt: updatedAt,
    });
    await this.store.upsertTask(revertedTask);
    return revertedTask;
  }

  async archiveTask(
    taskId: string,
    options: { force?: boolean } = {},
  ): Promise<WorkbenchTaskRecord | null> {
    const bundle = await this.store.readTaskBundle(taskId);
    if (!bundle.task) {
      return null;
    }

    const force = options.force === true;
    if (!force && !canArchiveWorkbenchTask(bundle.task.status)) {
      throw new Error(`Workbench task ${taskId} cannot be archived from status ${bundle.task.status}`);
    }

    const updatedAt = new Date().toISOString();
    const archiveSummary = force && !canArchiveWorkbenchTask(bundle.task.status)
      ? 'Stale task archived after its runtime record went missing.'
      : 'Task archived from the active work queue.';
    const archivedTask: WorkbenchTaskRecord = {
      ...bundle.task,
      status: 'archived',
      updatedAt,
      latestSummary: archiveSummary,
      waitingReason: undefined,
      waitingDecisionId: undefined,
    };

    await this.store.appendTimelineItem({
      id: generateId(),
      taskId,
      kind: 'summary',
      actor: 'user',
      body: archiveSummary,
      createdAt: updatedAt,
    });
    await this.store.upsertTask(archivedTask);
    return archivedTask;
  }

  private async drainEventQueue(): Promise<void> {
    await this.eventQueue;
  }

  private async projectTaskState(
    task: WorkbenchTaskRecord,
    timeline: WorkbenchTimelineItem[] = [],
  ): Promise<WorkbenchTaskRecord> {
    const projectedTask: WorkbenchTaskRecord = {
      ...task,
      evidenceSummary: this.buildTaskEvidenceSummary(timeline),
    };

    if (
      task.status === 'completed'
      || task.status === 'failed'
      || task.status === 'cancelled'
      || task.status === 'archived'
    ) {
      return projectedTask;
    }

    const pendingDecision = (await this.store.readPendingDecisions(task.id))[0];
    if (!pendingDecision) {
      return projectedTask;
    }

    const decisionSubject = pendingDecision.title.replace(/^High-risk action:\s*/i, '').trim() || pendingDecision.title;
    return {
      ...projectedTask,
      status: 'waiting_for_user',
      waitingDecisionId: task.waitingDecisionId || pendingDecision.id,
      waitingReason: task.waitingReason || `Awaiting approval for high-risk action: ${decisionSubject}`,
      latestSummary: task.latestSummary?.includes('approval')
        ? task.latestSummary
        : `Waiting for operator approval before ${decisionSubject}.`,
    };
  }

  private async handleEvent(event: AgentEvent): Promise<void> {
    const task = await this.resolveTaskForEvent(event);
    if (!task) {
      return;
    }

    if (this.shouldIgnoreEventForTask(task.status)) {
      return;
    }

    const createdAt = new Date(event.timestamp).toISOString();
    const summaryBody = this.summarizeEvent(event.type, event.payload);
    if (summaryBody) {
      const summary: WorkbenchTimelineItem = {
        id: generateId(),
        taskId: event.taskId,
        kind: 'summary',
        actor: 'supervisor',
        body: summaryBody,
        createdAt,
      };

      await this.store.appendTimelineItem(summary);
    }

    const rawItem = this.buildRawTimelineItem(event, createdAt);
    if (rawItem) {
      await this.store.appendTimelineItem(rawItem);
    }

    const nextStatus = this.mapTaskStatus(task.status, event);
    const waitingDecision = task.waitingDecisionId
      ? await this.store.readDecision(task.waitingDecisionId)
      : null;
    const hasPendingWaitingDecision = waitingDecision?.status === 'pending';
    const shouldForceResolveWaitingDecision = hasPendingWaitingDecision
      && this.shouldForceResolveWaitingDecision(event);
    let nextTask: WorkbenchTaskRecord = {
      ...task,
      updatedAt: createdAt,
      lastProgressAt: createdAt,
      latestSummary: summaryBody || task.latestSummary,
      currentOwner: 'supervisor',
      status: nextStatus,
    };

    if (event.type === EventType.SESSION_STARTED) {
      const payload = event.payload as { sessionId?: string };
      if (payload.sessionId) {
        await this.store.upsertSession({
          id: payload.sessionId,
          taskId: task.id,
          status: 'running',
          owner: 'supervisor',
          createdAt,
          updatedAt: createdAt,
          compactSummary: summaryBody || undefined,
        });
        nextTask = {
          ...nextTask,
          activeSessionId: payload.sessionId,
        };
      }
    }

    if (hasPendingWaitingDecision && !shouldForceResolveWaitingDecision) {
      nextTask = {
        ...nextTask,
        status: 'waiting_for_user',
        waitingReason: task.waitingReason || `Awaiting decision: ${waitingDecision.title}`,
        waitingDecisionId: task.waitingDecisionId,
      };
    } else if (nextStatus !== 'waiting_for_user') {
      await this.resolveWaitingDecision(task, createdAt, nextStatus, event);
      nextTask = {
        ...nextTask,
        waitingReason: undefined,
        waitingDecisionId: undefined,
      };
    }

    if (event.type === EventType.TOOL_CALLED) {
      const payload = event.payload as ToolCalledPayload;
      const approvalDecision = payload.approvalDecisionId
        ? await this.store.readDecision(payload.approvalDecisionId)
        : null;

      if (approvalDecision?.status === 'pending') {
        nextTask = {
          ...nextTask,
          status: 'waiting_for_user',
          waitingReason: `Awaiting approval for high-risk action: ${payload.toolName}`,
          waitingDecisionId: payload.approvalDecisionId,
        };
      }
      if (shouldRequestDecisionForTool(payload.toolName, payload.input) && !payload.approvalDecisionId) {
        const decision = this.buildHighRiskDecision(event.taskId, payload.toolName, createdAt);
        await this.store.appendDecision(decision);
        nextTask = {
          ...nextTask,
          status: 'waiting_for_user',
          waitingReason: `Awaiting approval for high-risk action: ${payload.toolName}`,
          waitingDecisionId: decision.id,
        };
      }
    }

    await this.store.upsertTask(nextTask);
  }

  private shouldIgnoreEventForTask(status: WorkbenchTaskStatus): boolean {
    return isWorkbenchTerminalStatus(status);
  }

  private async resolveWaitingDecision(
    task: WorkbenchTaskRecord,
    updatedAt: string,
    nextStatus: WorkbenchTaskStatus,
    event: AgentEvent,
  ): Promise<void> {
    if (!task.waitingDecisionId) {
      return;
    }

    const pendingDecisions = await this.store.readPendingDecisions(task.id);
    const waitingDecision = pendingDecisions.find((decision) => decision.id === task.waitingDecisionId);
    if (!waitingDecision) {
      return;
    }

    await this.store.appendDecision({
      ...waitingDecision,
      status: this.resolveDecisionStatus(nextStatus, event),
      updatedAt,
    });
  }

  private resolveDecisionStatus(
    nextStatus: WorkbenchTaskStatus,
    event: AgentEvent,
  ): WorkbenchDecisionRecord['status'] {
    if (
      event.type === EventType.TOOL_ERROR
      || event.type === EventType.TASK_CANCELLED
      || nextStatus === 'failed'
      || nextStatus === 'cancelled'
      || nextStatus === 'archived'
    ) {
      return 'dismissed';
    }

    return 'resolved';
  }

  private shouldForceResolveWaitingDecision(event: AgentEvent): boolean {
    return (
      event.type === EventType.TOOL_ERROR
      || event.type === EventType.TASK_FAILED
      || event.type === EventType.TASK_COMPLETED
      || event.type === EventType.TASK_CANCELLED
    );
  }

  private async resolveTaskForEvent(event: AgentEvent): Promise<WorkbenchTaskRecord | null> {
    const bundle = await this.store.readTaskBundle(event.taskId);
    if (bundle.task) {
      return bundle.task;
    }

    if (event.type !== EventType.TASK_CREATED) {
      return null;
    }

    const payload = event.payload as Task;
    const timestamp = new Date(event.timestamp).toISOString();
    const sessionId = generateId();
    const task: WorkbenchTaskRecord = {
      id: event.taskId,
      title: payload.description,
      goal: payload.description,
      status: 'new',
      createdAt: timestamp,
      updatedAt: timestamp,
      activeSessionId: sessionId,
      currentOwner: 'supervisor',
      latestSummary: 'Task created. Supervisor will start shortly.',
      environmentPackSnapshot: payload.environmentPackSnapshot,
      environmentPackSelection: payload.environmentPackSelection,
      workspaceBinding: payload.workspaceBinding,
    };

    await this.store.upsertTask(task);
    await this.store.upsertSession({
      id: sessionId,
      taskId: task.id,
      status: 'running',
      owner: 'supervisor',
      createdAt: timestamp,
      updatedAt: timestamp,
      compactSummary: task.latestSummary,
    });

    return task;
  }

  private mapTaskStatus(currentStatus: WorkbenchTaskStatus, event: AgentEvent): WorkbenchTaskStatus {
    if (
      currentStatus === 'paused'
      && event.type !== EventType.TASK_RESUMED
      && event.type !== EventType.TASK_COMPLETED
      && event.type !== EventType.TASK_FAILED
      && event.type !== EventType.TASK_CANCELLED
    ) {
      return 'paused';
    }

    switch (event.type) {
      case EventType.TASK_STARTED:
      case EventType.TASK_RESUMED:
      case EventType.SESSION_STARTED:
      case EventType.TOOL_RESULT:
      case EventType.TOOL_ERROR:
        return 'running';
      case EventType.TOOL_CALLED:
        return currentStatus === 'waiting_for_user' ? currentStatus : 'running';
      case EventType.TASK_PAUSED:
        return 'paused';
      case EventType.TASK_COMPLETED:
        return 'completed';
      case EventType.TASK_FAILED:
        return 'failed';
      case EventType.TASK_CANCELLED:
        return 'cancelled';
      default:
        return currentStatus;
    }
  }

  private buildHighRiskDecision(
    taskId: string,
    toolName: string,
    createdAt: string,
  ): WorkbenchDecisionRecord {
    return {
      id: generateId(),
      taskId,
      title: `High-risk action: ${toolName}`,
      summary: 'Supervisor paused before a high-risk tool invocation.',
      risk: 'high',
      status: 'pending',
      recommendedOptionId: 'approve',
      options: [
        {
          id: 'approve',
          label: 'Approve',
          description: 'Allow the action to continue.',
          recommended: true,
        },
        {
          id: 'reject',
          label: 'Reject',
          description: 'Keep the task paused and ask for a safer path.',
        },
      ],
      createdAt,
      updatedAt: createdAt,
    };
  }

  private summarizeEvent(type: EventType, payload: unknown): string | null {
    if (this.shouldSuppressTimelineSummary(type)) {
      return null;
    }

    if (type === EventType.TASK_CREATED) {
      return 'Task entered the supervisor queue.';
    }

    if (type === EventType.TASK_STARTED || type === EventType.TASK_RESUMED) {
      return 'Supervisor resumed task execution.';
    }

    if (type === EventType.TASK_PAUSED) {
      return 'Operator paused the task and preserved the current runtime state.';
    }

    if (type === EventType.TASK_COMPLETED) {
      return 'Task completed and the latest outputs are ready for review.';
    }

    if (type === EventType.TASK_FAILED) {
      return 'Task failed and needs recovery before it can continue.';
    }

    if (type === EventType.TASK_CANCELLED) {
      return 'Operator stopped the task before completion.';
    }

    if (type === EventType.SESSION_STARTED) {
      return 'Supervisor opened a new execution session.';
    }

    if (type === EventType.PLAN_GENERATED) {
      const plan = payload as { actionCount?: number; goals?: string[] };
      const goal = Array.isArray(plan.goals) ? plan.goals[0] : undefined;
      const actionCount = typeof plan.actionCount === 'number' ? plan.actionCount : 0;
      if (goal && actionCount > 0) {
        return `Supervisor drafted the next pass: ${goal} (${actionCount} planned action${actionCount === 1 ? '' : 's'}).`;
      }
      if (goal) {
        return `Supervisor drafted the next pass: ${goal}.`;
      }
      return 'Supervisor drafted the next execution pass.';
    }

    if (type === EventType.TOOL_RESULT) {
      const result = payload as ToolResultPayload;
      if (result.toolName === 'write_file' || result.toolName === 'edit_file') {
        const fileCount = result.filesModified?.length || 0;
        return result.success
          ? `Supervisor updated ${fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : 'the target files'} and produced a reviewable artifact.`
          : `Supervisor could not apply the requested file change with ${result.toolName}.`;
      }

      if (result.toolName === 'read_file') {
        return result.success
          ? 'Supervisor inspected the current project files to ground the next pass.'
          : 'Supervisor could not inspect the requested file.';
      }

      if (result.toolName === 'bash') {
        return result.success
          ? 'Supervisor completed the shell step and recorded the result.'
          : 'Supervisor hit an error while running the shell step.';
      }

      const outcome = result.success ? 'successful' : 'failed';
      return `Supervisor recorded ${outcome} tool output from ${result.toolName}.`;
    }

    if (type === EventType.TOOL_CALLED) {
      const call = payload as ToolCalledPayload;
      if (call.toolName === 'read_file') {
        return 'Supervisor is inspecting the current files before making changes.';
      }
      if (call.toolName === 'write_file' || call.toolName === 'edit_file') {
        return 'Supervisor is preparing a concrete patch for the active task.';
      }
      if (call.toolName === 'bash') {
        return 'Supervisor is preparing a shell action that may need approval.';
      }
      return `Supervisor is preparing the next ${call.toolName} step.`;
    }

    return `Supervisor observed event ${type}.`;
  }

  private shouldSuppressTimelineSummary(type: EventType): boolean {
    return (
      type === EventType.SESSION_MESSAGE
      || type === EventType.SESSION_USAGE
      || type === EventType.PLAN_STARTED
      || type === EventType.CONTEXT_BUILT
      || type === EventType.CONTEXT_UPDATED
      || type === EventType.MEMORY_RECORDED
      || type === EventType.EVALUATION_STARTED
      || type === EventType.EVALUATED
      || type === EventType.FITNESS_CALCULATED
      || type === EventType.DRIFT_DETECTED
      || type === EventType.ENTROPY_CALCULATED
      || type === EventType.ITERATION_STARTED
      || type === EventType.ITERATION_COMPLETED
      || type === EventType.CONVERGED
      || type === EventType.DIVERGED
      || type === EventType.HUMAN_INTERVENTION
      || type === EventType.CONTROL_RECEIVED
      || type === EventType.CONSTRAINT_INJECTED
      || type === EventType.STRATEGY_CHANGED
      || type === EventType.ERROR
      || type === EventType.WARNING
      || type === EventType.AGENT_SWITCHED
      || type === EventType.EXECUTION_STARTED
      || type === EventType.PLAN_UPDATED
    );
  }

  private buildRawTimelineItem(
    event: AgentEvent,
    createdAt: string,
  ): WorkbenchTimelineItem | null {
    if (event.type !== EventType.TOOL_RESULT && event.type !== EventType.TOOL_ERROR) {
      return null;
    }

    const payload = event.payload as ToolResultPayload;
    const body = this.formatToolEvidenceBody(payload);
    if (!body) {
      return null;
    }

    return {
      id: generateId(),
      taskId: event.taskId,
      kind: 'raw',
      actor: 'system',
      body,
      createdAt,
    };
  }

  private formatToolEvidenceBody(payload: ToolResultPayload): string {
    const sections = [`Tool: ${payload.toolName}`];

    if (payload.filesModified?.length) {
      sections.push([
        'Files modified:',
        ...payload.filesModified.map((filePath: string) => `- ${filePath}`),
      ].join('\n'));
    }

    if (payload.error) {
      sections.push(`Error:\n${payload.error}`);
    }

    const output = this.stringifyPayloadOutput(payload.output);
    if (output) {
      sections.push(`Output:\n${output}`);
    }

    if (payload.truncated) {
      sections.push(`Note: output truncated from ${payload.originalSize ?? 'unknown'} bytes`);
    }

    return sections.join('\n\n').trim();
  }

  private stringifyPayloadOutput(output: unknown): string {
    if (output === null || output === undefined) {
      return '';
    }

    if (typeof output === 'string') {
      return output;
    }

    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }

  private buildTaskEvidenceSummary(
    timeline: WorkbenchTimelineItem[],
  ): WorkbenchTaskEvidenceSummary {
    const rawItems = [...timeline]
      .filter((item) => item.kind === 'raw')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const modifiedFiles = new Set<string>();
    const previewableArtifacts = new Set<string>();
    let latestPreviewableArtifactPath: string | undefined;
    let latestPreviewableArtifactCreatedAt: string | undefined;
    let latestToolName: string | undefined;
    let hasErrorEvidence = false;

    for (const item of rawItems) {
      const parsed = this.parseTaskEvidence(item.body);
      latestToolName = latestToolName || parsed.toolName;
      hasErrorEvidence = hasErrorEvidence || Boolean(parsed.error);

      parsed.filesModified.forEach((filePath) => modifiedFiles.add(filePath));
      parsed.previewableArtifacts.forEach((filePath) => previewableArtifacts.add(filePath));

      if (!latestPreviewableArtifactPath && parsed.previewableArtifacts[0]) {
        latestPreviewableArtifactPath = parsed.previewableArtifacts[0];
        latestPreviewableArtifactCreatedAt = item.createdAt;
      }
    }

    return {
      rawEventCount: rawItems.length,
      modifiedFileCount: modifiedFiles.size,
      previewableArtifactCount: previewableArtifacts.size,
      latestPreviewableArtifactPath,
      latestPreviewableArtifactCreatedAt,
      latestToolName,
      hasErrorEvidence,
    };
  }

  private parseTaskEvidence(body: string): {
    toolName?: string;
    filesModified: string[];
    previewableArtifacts: string[];
    error?: string;
  } {
    const toolName = body.match(/^Tool:\s*(.+)$/m)?.[1]?.trim();
    const filesModified = this.extractBulletSection(body, 'Files modified');
    const error = this.extractNamedSection(body, 'Error');

    return {
      toolName,
      filesModified,
      previewableArtifacts: filesModified.filter((filePath) => this.isPreviewableArtifactPath(filePath)),
      error,
    };
  }

  private extractNamedSection(body: string, sectionName: string): string {
    const pattern = new RegExp(`${this.escapeForRegex(sectionName)}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^\\n]*:|$)`);
    return body.match(pattern)?.[1]?.trim() || '';
  }

  private extractBulletSection(body: string, sectionName: string): string[] {
    const section = this.extractNamedSection(body, sectionName);
    if (!section) {
      return [];
    }

    return section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  }

  private escapeForRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private isPreviewableArtifactPath(filePath: string): boolean {
    const lowered = filePath.toLowerCase();
    return (
      lowered.endsWith('.html')
      || lowered.endsWith('.htm')
      || lowered.endsWith('.md')
      || lowered.endsWith('.txt')
      || lowered.endsWith('.json')
      || lowered.endsWith('.svg')
    );
  }
}
