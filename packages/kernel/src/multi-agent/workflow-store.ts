import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  generateId,
  type AgentInvocationRecord,
  type CreateMultiAgentWorkflowInput,
  type MultiAgentInvocationStatus,
  type MultiAgentWorkflowBundle,
  type MultiAgentWorkflowEvent,
  type MultiAgentWorkflowEventType,
  type MultiAgentWorkflowEvidence,
  type MultiAgentWorkflowRecord,
  type SubtaskRunState,
  type SubtaskRunStatus,
  type TaskGraph,
  type WorkflowDecision,
} from '@tik/shared';

const SUBTASK_TRANSITIONS: Record<SubtaskRunStatus, SubtaskRunStatus[]> = {
  pending: ['ready', 'blocked', 'human_review_required'],
  ready: ['executing', 'blocked', 'human_review_required'],
  executing: ['implemented', 'validation_failed', 'blocked', 'human_review_required'],
  implemented: ['validating', 'approved', 'reviewing', 'validation_failed', 'blocked', 'human_review_required'],
  validating: ['approved', 'validation_failed', 'blocked', 'human_review_required'],
  validation_failed: ['executing', 'implemented', 'blocked', 'human_review_required'],
  reviewing: ['needs_fix', 'approved', 'done', 'blocked', 'human_review_required'],
  needs_fix: ['fixing', 'executing', 'implemented', 'blocked', 'human_review_required'],
  fixing: ['implemented', 'reviewing', 'blocked', 'human_review_required'],
  approved: ['reviewing', 'done', 'blocked', 'human_review_required'],
  done: ['human_review_required'],
  blocked: ['ready', 'executing', 'human_review_required'],
  human_review_required: [],
};

const INVOCATION_TRANSITIONS: Record<MultiAgentInvocationStatus, MultiAgentInvocationStatus[]> = {
  created: ['started', 'cancelled'],
  started: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class MultiAgentCoordinationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MultiAgentCoordinationError';
  }
}

interface CreateAgentInvocationInput {
  id?: string;
  workflowId?: string;
  subtaskId?: string;
  role: AgentInvocationRecord['role'];
  runner: AgentInvocationRecord['runner'];
  promptContract: string;
  input?: Record<string, unknown>;
  allowedPaths?: string[];
  validationCommands?: string[];
}

export class FileMultiAgentWorkflowStore {
  constructor(private readonly rootPath: string) {}

  async createWorkflow(input: CreateMultiAgentWorkflowInput): Promise<MultiAgentWorkflowRecord> {
    if (!input.goal?.trim()) {
      throw new MultiAgentCoordinationError('invalid_workflow', 'Workflow goal is required.');
    }

    const id = this.normalizeId(input.id || `wf_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${generateId().slice(0, 8)}`);
    const existing = await this.readWorkflow(id);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const workflow: MultiAgentWorkflowRecord = {
      id,
      driver: 'codex-workflow',
      status: 'active',
      goal: input.goal,
      rootTaskId: input.rootTaskId || id,
      repo: input.repo,
      baseRef: input.baseRef,
      headRef: input.headRef,
      currentHeadSha: input.headSha,
      maxRounds: input.maxRounds ?? 3,
      workspaceBinding: input.workspaceBinding,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    assertWorkspaceBindingInsideRoot(workflow.workspaceBinding);
    await this.writeWorkflow(workflow);
    await this.appendEvent(workflow.id, 'workflow.created', 'tik', { workflowId: workflow.id });
    return workflow;
  }

  async readWorkflow(workflowId: string): Promise<MultiAgentWorkflowRecord | null> {
    return this.readJsonFile<MultiAgentWorkflowRecord>(this.workflowFile(this.normalizeId(workflowId)));
  }

  async updateWorkflow(
    workflowId: string,
    patch: Partial<Pick<MultiAgentWorkflowRecord, 'status' | 'currentHeadSha' | 'metadata'>>,
  ): Promise<MultiAgentWorkflowRecord> {
    const id = this.normalizeId(workflowId);
    const existing = await this.requireWorkflow(id);
    const now = new Date().toISOString();
    const workflow: MultiAgentWorkflowRecord = {
      ...existing,
      status: patch.status ?? existing.status,
      currentHeadSha: patch.currentHeadSha ?? existing.currentHeadSha,
      metadata: patch.metadata ?? existing.metadata,
      updatedAt: now,
      completedAt: patch.status === 'completed' ? now : existing.completedAt,
      abortedAt: patch.status === 'aborted' ? now : existing.abortedAt,
    };
    assertWorkspaceBindingInsideRoot(workflow.workspaceBinding);
    await this.writeWorkflow(workflow);
    if (patch.status === 'completed') {
      await this.appendEvent(id, 'workflow.completed', 'tik', { workflowId: id });
    } else if (patch.status === 'aborted') {
      await this.appendEvent(id, 'workflow.aborted', 'tik', { workflowId: id });
    }
    return workflow;
  }

  async readBundle(workflowId: string): Promise<MultiAgentWorkflowBundle | null> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.readWorkflow(id);
    if (!workflow) {
      return null;
    }

    return {
      workflow,
      taskGraph: await this.readTaskGraphForWorkflow(workflow),
      subtasks: await this.readSubtasks(id),
      decisions: await this.readJsonLines<WorkflowDecision>(this.decisionsFile(id)),
      evidence: await this.readEvidence(id),
      invocations: await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(id)),
      events: await this.readJsonLines<MultiAgentWorkflowEvent>(this.eventsFile(id)),
    };
  }

  async putTaskGraph(workflowId: string, graph: TaskGraph): Promise<{ graph: TaskGraph; subtasks: Record<string, SubtaskRunState> }> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    if (graph.workflowId !== id) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `TaskGraph workflowId ${graph.workflowId} does not match workflow ${id}.`);
    }
    if (!Number.isFinite(graph.version) || graph.version < 1) {
      throw new MultiAgentCoordinationError('invalid_task_graph', 'TaskGraph version must be a positive number.');
    }
    if (!Array.isArray(graph.subtasks) || graph.subtasks.length === 0) {
      throw new MultiAgentCoordinationError('invalid_task_graph', 'TaskGraph must contain at least one subtask.');
    }

    const duplicate = findDuplicate(graph.subtasks.map((subtask) => subtask.id));
    if (duplicate) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `Duplicate subtask id: ${duplicate}.`);
    }

    const existingSubtasks = await this.readSubtasks(id);
    const subtasks = buildSubtaskStatesForGraph(graph, existingSubtasks);
    await this.writeJsonFileAtomic(this.taskGraphFile(id, graph.version), graph);
    await this.writeJsonFileAtomic(this.subtasksFile(id), subtasks);
    await this.writeWorkflow({
      ...workflow,
      taskGraphVersion: graph.version,
      updatedAt: new Date().toISOString(),
    });
    await this.appendEvent(id, 'task_graph.created', 'tik', {
      version: graph.version,
      subtaskCount: graph.subtasks.length,
    });

    return { graph, subtasks };
  }

  async updateSubtask(
    workflowId: string,
    subtaskId: string,
    patch: Partial<SubtaskRunState>,
  ): Promise<SubtaskRunState> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    const subtasks = await this.readSubtasks(id);
    const existing = subtasks[subtaskId];
    if (!existing) {
      throw new MultiAgentCoordinationError('subtask_not_found', `Subtask not found: ${subtaskId}.`);
    }

    const nextStatus = patch.status ?? existing.status;
    assertSubtaskTransition(existing.status, nextStatus);

    const updated: SubtaskRunState = {
      ...existing,
      ...patch,
      subtaskId,
      reviewRoundIds: mergeUnique(existing.reviewRoundIds, patch.reviewRoundIds),
      validationRunIds: mergeUnique(existing.validationRunIds, patch.validationRunIds),
      evidenceRefs: mergeUnique(existing.evidenceRefs, patch.evidenceRefs),
      blockerFindingIds: mergeUnique(existing.blockerFindingIds, patch.blockerFindingIds),
      fixRound: patch.fixRound ?? existing.fixRound,
    };
    subtasks[subtaskId] = updated;
    await this.writeJsonFileAtomic(this.subtasksFile(id), subtasks);
    await this.writeWorkflow({
      ...workflow,
      updatedAt: new Date().toISOString(),
    });
    await this.appendEvent(id, 'subtask.updated', 'codex-workflow', {
      subtaskId,
      status: updated.status,
    });
    return updated;
  }

  async recordDecision(workflowId: string, decision: WorkflowDecision): Promise<WorkflowDecision> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    await fs.mkdir(this.workflowDir(id), { recursive: true });
    await fs.appendFile(this.decisionsFile(id), `${JSON.stringify(decision)}\n`, 'utf-8');

    const now = new Date().toISOString();
    const nextWorkflow: MultiAgentWorkflowRecord = {
      ...workflow,
      lastDecisionId: decision.id,
      status: decision.action === 'complete_workflow'
        ? 'completed'
        : decision.action === 'abort_workflow'
          ? 'aborted'
          : workflow.status,
      updatedAt: now,
      completedAt: decision.action === 'complete_workflow' ? now : workflow.completedAt,
      abortedAt: decision.action === 'abort_workflow' ? now : workflow.abortedAt,
    };
    await this.writeWorkflow(nextWorkflow);
    await this.appendEvent(id, 'decision.recorded', 'codex-workflow', {
      decisionId: decision.id,
      action: decision.action,
      subtaskId: decision.subtaskId,
    });
    if (decision.action === 'complete_workflow') {
      await this.appendEvent(id, 'workflow.completed', 'codex-workflow', {
        decisionId: decision.id,
      });
    } else if (decision.action === 'abort_workflow') {
      await this.appendEvent(id, 'workflow.aborted', 'codex-workflow', {
        decisionId: decision.id,
      });
    }
    return decision;
  }

  async recordEvidence(
    workflowId: string,
    input: Omit<Partial<MultiAgentWorkflowEvidence>, 'workflowId' | 'createdAt'> & {
      kind: MultiAgentWorkflowEvidence['kind'];
      title: string;
    },
  ): Promise<MultiAgentWorkflowEvidence> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    const now = new Date().toISOString();
    const evidence: MultiAgentWorkflowEvidence = {
      id: this.normalizeId(input.id || `ev_${generateId()}`),
      workflowId: id,
      subtaskId: input.subtaskId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      command: input.command,
      passed: input.passed,
      artifactRef: input.artifactRef,
      headSha: input.headSha,
      payload: input.payload,
      createdAt: now,
    };

    await fs.mkdir(this.evidenceDir(id), { recursive: true });
    await this.writeJsonFileAtomic(this.evidenceFile(id, evidence.id), evidence);
    await this.appendEvent(id, 'evidence.recorded', 'codex-workflow', {
      evidenceId: evidence.id,
      subtaskId: evidence.subtaskId,
      kind: evidence.kind,
    });
    return evidence;
  }

  async createInvocation(workflowId: string, input: CreateAgentInvocationInput): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    const now = new Date().toISOString();
    const invocation: AgentInvocationRecord = {
      id: this.normalizeId(input.id || `inv_${generateId()}`),
      workflowId: id,
      subtaskId: input.subtaskId,
      role: input.role,
      runner: input.runner,
      promptContract: input.promptContract,
      input: input.input,
      allowedPaths: input.allowedPaths,
      validationCommands: input.validationCommands,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
    await this.upsertInvocation(invocation);
    await this.appendEvent(id, 'agent_invocation.created', 'tik', {
      invocationId: invocation.id,
      role: invocation.role,
      runner: invocation.runner,
    });
    return invocation;
  }

  async readInvocation(workflowId: string, invocationId: string): Promise<AgentInvocationRecord | null> {
    const id = this.normalizeId(workflowId);
    const invocation = this.normalizeId(invocationId);
    const invocations = await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(id));
    return invocations.find((item) => item.id === invocation) ?? null;
  }

  async updateInvocation(
    workflowId: string,
    invocationId: string,
    patch: {
      status: MultiAgentInvocationStatus;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    const existing = await this.readInvocation(id, invocationId);
    if (!existing) {
      throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
    }
    assertInvocationTransition(existing.status, patch.status);

    const now = new Date().toISOString();
    const updated: AgentInvocationRecord = {
      ...existing,
      status: patch.status,
      result: patch.result ?? existing.result,
      error: patch.error ?? existing.error,
      updatedAt: now,
      startedAt: patch.status === 'started' ? now : existing.startedAt,
      completedAt: patch.status === 'completed' || patch.status === 'failed' || patch.status === 'cancelled'
        ? now
        : existing.completedAt,
    };
    await this.upsertInvocation(updated);
    await this.appendEvent(
      id,
      patch.status === 'started' ? 'agent_invocation.started' : 'agent_invocation.completed',
      'tik',
      {
        invocationId: updated.id,
        status: updated.status,
      },
    );
    return updated;
  }

  async readTimeline(workflowId: string): Promise<MultiAgentWorkflowEvent[]> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    return this.readJsonLines<MultiAgentWorkflowEvent>(this.eventsFile(id));
  }

  private async requireWorkflow(workflowId: string): Promise<MultiAgentWorkflowRecord> {
    const workflow = await this.readWorkflow(workflowId);
    if (!workflow) {
      throw new MultiAgentCoordinationError('workflow_not_found', `Multi-agent workflow not found: ${workflowId}.`);
    }
    return workflow;
  }

  private async readTaskGraphForWorkflow(workflow: MultiAgentWorkflowRecord): Promise<TaskGraph | null> {
    if (!workflow.taskGraphVersion) {
      return null;
    }
    return this.readJsonFile<TaskGraph>(this.taskGraphFile(workflow.id, workflow.taskGraphVersion));
  }

  private async readSubtasks(workflowId: string): Promise<Record<string, SubtaskRunState>> {
    return (await this.readJsonFile<Record<string, SubtaskRunState>>(this.subtasksFile(workflowId))) ?? {};
  }

  private async readEvidence(workflowId: string): Promise<MultiAgentWorkflowEvidence[]> {
    try {
      const entries = await fs.readdir(this.evidenceDir(workflowId));
      const records = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readJsonFile<MultiAgentWorkflowEvidence>(path.join(this.evidenceDir(workflowId), entry))));
      return records
        .filter((item): item is MultiAgentWorkflowEvidence => Boolean(item))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async upsertInvocation(invocation: AgentInvocationRecord): Promise<void> {
    const invocations = await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(invocation.workflowId));
    const next = [
      ...invocations.filter((item) => item.id !== invocation.id),
      invocation,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    await fs.mkdir(this.workflowDir(invocation.workflowId), { recursive: true });
    await fs.writeFile(
      this.invocationsFile(invocation.workflowId),
      next.map((item) => JSON.stringify(item)).join('\n') + (next.length > 0 ? '\n' : ''),
      'utf-8',
    );
  }

  private async writeWorkflow(workflow: MultiAgentWorkflowRecord): Promise<void> {
    await this.writeJsonFileAtomic(this.workflowFile(workflow.id), workflow);
  }

  private async appendEvent(
    workflowId: string,
    type: MultiAgentWorkflowEventType,
    actor: MultiAgentWorkflowEvent['actor'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: MultiAgentWorkflowEvent = {
      id: generateId(),
      workflowId,
      type,
      actor,
      timestamp: new Date().toISOString(),
      payload,
    };
    await fs.mkdir(this.workflowDir(workflowId), { recursive: true });
    await fs.appendFile(this.eventsFile(workflowId), `${JSON.stringify(event)}\n`, 'utf-8');
  }

  private normalizeId(id: string): string {
    const normalized = id.trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new MultiAgentCoordinationError('invalid_id', `Invalid multi-agent workflow id: ${id}.`);
    }
    return normalized;
  }

  private rootDir(): string {
    return path.join(this.rootPath, '.tik', 'multi-agent', 'workflows');
  }

  private workflowDir(workflowId: string): string {
    return path.join(this.rootDir(), workflowId);
  }

  private workflowFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'workflow.json');
  }

  private taskGraphFile(workflowId: string, version: number): string {
    return path.join(this.workflowDir(workflowId), `task-graph.v${version}.json`);
  }

  private subtasksFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'subtasks.json');
  }

  private decisionsFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'decisions.jsonl');
  }

  private invocationsFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'invocations.jsonl');
  }

  private eventsFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'events.jsonl');
  }

  private evidenceDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'evidence');
  }

  private evidenceFile(workflowId: string, evidenceId: string): string {
    return path.join(this.evidenceDir(workflowId), `${evidenceId}.json`);
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async readJsonLines<T>(filePath: string): Promise<T[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }
}

function buildSubtaskStatesForGraph(
  graph: TaskGraph,
  existing: Record<string, SubtaskRunState>,
): Record<string, SubtaskRunState> {
  const states: Record<string, SubtaskRunState> = {};
  for (const subtask of graph.subtasks) {
    const status: SubtaskRunStatus = subtask.dependsOn.length === 0 ? 'ready' : 'pending';
    states[subtask.id] = existing[subtask.id] || {
      subtaskId: subtask.id,
      status,
      reviewRoundIds: [],
      validationRunIds: [],
      evidenceRefs: [],
      blockerFindingIds: [],
      fixRound: 0,
    };
  }
  return states;
}

function assertSubtaskTransition(from: SubtaskRunStatus, to: SubtaskRunStatus): void {
  if (from === to) {
    return;
  }
  if (SUBTASK_TRANSITIONS[from]?.includes(to)) {
    return;
  }
  throw new MultiAgentCoordinationError(
    'invalid_transition',
    `Cannot transition subtask from ${from} to ${to}.`,
  );
}

function assertInvocationTransition(from: MultiAgentInvocationStatus, to: MultiAgentInvocationStatus): void {
  if (from === to) {
    return;
  }
  if (INVOCATION_TRANSITIONS[from]?.includes(to)) {
    return;
  }
  throw new MultiAgentCoordinationError(
    'invalid_transition',
    `Cannot transition agent invocation from ${from} to ${to}.`,
  );
}

function findDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function mergeUnique<T>(left: T[] | undefined, right: T[] | undefined): T[] {
  return Array.from(new Set([...(left || []), ...(right || [])]));
}

function assertWorkspaceBindingInsideRoot(binding: MultiAgentWorkflowRecord['workspaceBinding']): void {
  if (!binding?.workspaceRoot || !binding.effectiveProjectPath) {
    return;
  }

  const root = path.resolve(binding.workspaceRoot);
  const target = path.resolve(binding.effectiveProjectPath);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new MultiAgentCoordinationError(
    'worktree_out_of_scope',
    `Workflow worktree is outside workspace root: ${target}`,
  );
}
