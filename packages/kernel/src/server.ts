/**
 * API Server
 *
 * Fastify-based HTTP server for Tik.
 * Provides REST API + SSE for CLI and Dashboard.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  AgentLoopPayload,
  ArtifactKind,
  ArtifactStatus,
  CreateTaskInput,
  ControlCommand,
  ExecutionMode,
  ReviewResult,
  SkillManifestMutationInput,
  TaskWorkspaceBinding,
  WorkbenchTaskRecord,
  WorkbenchTaskStatus,
  AgentInvocationRecord,
  CodexEvaluationResult,
  CreateMultiAgentWorkflowInput,
  EvaluationRun,
  HumanOverrideRecord,
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowRecord,
  QuestionerOutput,
  SprintContract,
  SubtaskRunState,
  TaskGraph,
  WorkflowContextSnapshot,
  WorkflowDecision,
  WorkflowPolicy,
} from '@tik/shared';
import {
  canRetryWorkbenchTask,
  createEnvironmentPackSelection,
  generateId,
  isWorkbenchTaskCodexDispatchable,
  isWorkbenchTaskExternallyOwnedClaudeReview,
  isWorkbenchTaskMaintenance,
  isWorkbenchTerminalStatus,
  toEnvironmentPackSnapshot,
} from '@tik/shared';
import type { ExecutionKernel } from './execution-kernel.js';
import type { CreateTaskInputV2 } from './execution-kernel.js';
import { WorkspaceReadModel, WORKSPACE_PUBLIC_API_VERSION, WORKSPACE_PUBLIC_SCHEMA_VERSION } from './workspace-public-api.js';
import { WorkspaceOrchestrator } from './workspace-orchestrator.js';
import { WorkspaceWorktreeManager } from './workspace-worktree-manager.js';
import { buildEnvironmentPackDashboard } from './environment-pack-dashboard.js';
import { SkillManifestRegistry } from './skill-manifest-registry.js';
import { FileTrackerDaemonStateStore } from './tracker-daemon/file-state-store.js';
import { TrackerDaemon } from './tracker-daemon/tracker-daemon.js';
import { WorkbenchTrackerLauncher } from './tracker-daemon/workbench-launcher.js';
import { runWorkbenchKernelTaskInBackground } from './tracker-daemon/workbench-runner.js';
import { WorkflowV2WorkbenchTaskImporter } from './tracker-daemon/workbench-tracker-client.js';
import { loadTrackerWorkflow, readTrackerWorkflowFile, resolveTrackerWorkflowPath, writeTrackerWorkflowFile } from './tracker-daemon/workflow-loader.js';
import { FileAgentRunStore } from './agent-runners/agent-run-store.js';
import { FileRunProofStore } from './agent-runners/run-proof-store.js';
import { RunProofService } from './agent-runners/run-proof-service.js';
import { createDefaultRuntimeRunners } from './agent-runners/default-runtime-runners.js';
import type { AgentRuntimeName, TrackedTask } from './tracker-daemon/types.js';
import type { AgentRuntimeRunner } from './agent-runners/agent-runtime-runner.js';
import { parseSlashCommand } from './workbench/comment-commands.js';
import { WorkbenchTaskError } from './workbench/workbench-service.js';
import type { ArtifactTemplateName } from './artifacts/artifact-templates.js';
import { normalizeArtifactExtension } from './artifacts/artifact-security.js';
import { FileArtifactRegistry } from './artifacts/artifact-registry.js';
import { FileMultiAgentWorkflowStore, MultiAgentCoordinationError } from './multi-agent/workflow-store.js';
import { evaluateWorkflowDecisionGuard } from './multi-agent/guard.js';

export interface ServerConfig {
  port: number;
  host: string;
}

export interface WorkspaceServerOptions {
  workspaceRoot?: string;
  apiToken?: string;
  dashboardOrigin?: string;
  allowUnauthenticatedRemote?: boolean;
  enableLegacyPathArtifactPreview?: boolean;
  runtimeRunners?: Partial<Record<AgentRuntimeName, AgentRuntimeRunner>>;
}

interface TrackerListenerStatus {
  id: string;
  label: string;
  status: 'running' | 'stopped' | 'expected' | 'unknown';
  detail: string;
  pid?: number;
  port?: number;
  session?: string;
}

interface ResolveWorkspaceDecisionBody {
  optionId?: string;
  message?: string;
}

interface WorkspaceWorktreeMutationBody {
  projectName: string;
  sourceProjectPath?: string;
  laneId?: string;
  force?: boolean;
}

interface SwitchEnvironmentPackBody {
  packId: string;
}

interface WorkbenchTaskConfigurationBody {
  environmentPackId?: string;
  selectedSkills?: string[];
  selectedKnowledgeIds?: string[];
}

interface CreateWorkbenchTaskBody extends WorkbenchTaskConfigurationBody {
  title: string;
  goal: string;
  description?: string | null;
  status?: WorkbenchTaskRecord['status'];
  priority?: number | null;
  labels?: string[];
  parentTaskId?: string | null;
  humanAssignee?: string | null;
  workspaceBinding?: TaskWorkspaceBinding;
}

interface UpdateV1TaskBody {
  title?: string;
  description?: string | null;
  goal?: string;
  status?: WorkbenchTaskRecord['status'];
  priority?: number | null;
  labels?: string[];
  parentTaskId?: string | null;
  humanAssignee?: string | null;
  assignee?: string | null;
  createdBy?: string | null;
  sourceUrl?: string | null;
  workspaceBinding?: TaskWorkspaceBinding;
}

interface WorkbenchTaskBriefBody {
  title?: string;
  goal?: string;
  adjustment?: string;
  launchFollowUp?: boolean;
}

interface SkillManifestMutationBody extends SkillManifestMutationInput {}

interface WorkflowFileBody {
  content?: string;
}

interface MultiAgentWorkflowPatchBody {
  status?: MultiAgentWorkflowRecord['status'];
  headSha?: string;
  metadata?: Record<string, unknown>;
  policy?: Partial<WorkflowPolicy>;
}

interface CreateSprintContractBody {
  id?: string;
  version?: number;
  status?: SprintContract['status'];
  goal: string;
  scope: SprintContract['scope'];
  deliverables: SprintContract['deliverables'];
  acceptanceCriteria: SprintContract['acceptanceCriteria'];
  verificationPlan: SprintContract['verificationPlan'];
  questionerOutputRefs?: string[];
  acceptedBy?: SprintContract['acceptedBy'];
  acceptedAt?: string;
  headShaAtAcceptance?: string;
}

interface AcceptSprintContractBody {
  acceptedBy?: SprintContract['acceptedBy'];
  headShaAtAcceptance?: string;
  questionerOutputRefs?: string[];
}

interface CreateEvaluationRunBody {
  id?: string;
  contractId: string;
  evaluator?: EvaluationRun['evaluator'];
  status?: EvaluationRun['status'];
  headSha: string;
  readonlyPolicy?: EvaluationRun['readonlyPolicy'];
  artifactRefs?: string[];
}

interface UpdateEvaluationRunBody {
  status?: EvaluationRun['status'];
  headSha?: string;
  readonlyPolicy?: Partial<EvaluationRun['readonlyPolicy']>;
  artifactRefs?: string[];
}

interface RecordEvaluationResultBody {
  result: CodexEvaluationResult;
}

interface ValidateEvaluationReadonlyBody {
  gitStatusBefore?: string;
  gitStatusAfter?: string;
  allowedWritePaths?: string[];
  forbiddenWritePaths?: string[];
}

interface RecordQuestionerOutputBody {
  id?: string;
  subtaskId?: string;
  intent: QuestionerOutput['intent'];
  actor: QuestionerOutput['actor'];
  source: QuestionerOutput['source'];
  headSha: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  contractId?: string;
  artifactRef?: string;
  verdict: QuestionerOutput['verdict'];
  questions?: QuestionerOutput['questions'];
  risks?: QuestionerOutput['risks'];
  missingTests?: QuestionerOutput['missingTests'];
  suggestedContractChanges?: QuestionerOutput['suggestedContractChanges'];
}

interface RecordWorkflowDecisionBody {
  decision: WorkflowDecision;
}

interface CompleteSubtaskActionBody {
  decision: WorkflowDecision;
  subtaskPatch?: UpdateSubtaskBody;
}

interface CompleteWorkflowActionBody {
  decision: WorkflowDecision;
}

interface RecordImplementationActionBody {
  decision: WorkflowDecision;
  evidence: RecordEvidenceBody;
  subtaskPatch?: UpdateSubtaskBody;
}

interface RecordEvaluationResultActionBody {
  decision?: WorkflowDecision;
  subtaskId: string;
  evaluationRunId: string;
  result: CodexEvaluationResult;
  subtaskPatch?: UpdateSubtaskBody;
}

interface RecordQuestionerOutputActionBody {
  decision?: WorkflowDecision;
  output: RecordQuestionerOutputBody;
  subtaskPatch?: UpdateSubtaskBody;
}

interface PutTaskGraphBody {
  graph: TaskGraph;
}

interface UpdateSubtaskBody {
  status?: SubtaskRunState['status'];
  implementationHeadSha?: string;
  lastValidatedHeadSha?: string;
  lastReviewedHeadSha?: string;
  reviewRoundIds?: string[];
  validationRunIds?: string[];
  evidenceRefs?: string[];
  blockerFindingIds?: string[];
  fixRound?: number;
}

interface RecordEvidenceBody {
  id?: string;
  subtaskId?: string;
  kind: 'implementation' | 'validation' | 'review' | 'fix' | 'plan' | 'decision' | 'note';
  title: string;
  summary?: string;
  command?: string;
  passed?: boolean;
  artifactRef?: string;
  headSha?: string;
  payload?: Record<string, unknown>;
}

interface CreateAgentInvocationBody {
  id?: string;
  subtaskId?: string;
  role: AgentInvocationRecord['role'];
  runner: AgentInvocationRecord['runner'];
  promptContract: string;
  input?: Record<string, unknown>;
  allowedPaths?: string[];
  validationCommands?: string[];
  threadId?: string;
  actualSubagentThreadId?: string;
  parentThreadId?: string;
  headSha?: string;
  evidenceRefs?: string[];
  evaluationRunId?: string;
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
}

interface UpdateAgentInvocationBody {
  status: AgentInvocationRecord['status'];
  result?: Record<string, unknown>;
  error?: string;
  threadId?: string;
  actualSubagentThreadId?: string;
  parentThreadId?: string;
  headSha?: string;
  evidenceRefs?: string[];
  evaluationRunId?: string;
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
}

interface StartAgentInvocationBody {}

interface HookStartAgentInvocationBody {
  attestationToken: string;
  nonce: string;
  parentThreadId: string;
  actualSubagentThreadId: string;
  role: AgentInvocationRecord['role'];
  startedAt?: string;
}

interface HookStopAgentInvocationBody {
  attestationToken: string;
  stoppedAt?: string;
  headSha?: string;
  evidenceRefs?: string[];
  evaluationRunId?: string;
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
  result?: Record<string, unknown>;
  status?: Extract<AgentInvocationRecord['status'], 'completed' | 'failed' | 'cancelled'>;
  error?: string;
}

interface SaveContextSnapshotBody {
  snapshot: Omit<Partial<WorkflowContextSnapshot>, 'workflowId'> & {
    workflowId?: string;
    headSha: string;
    target: WorkflowContextSnapshot['target'];
    objectiveSummary: string;
    completedSubtasks?: string[];
    unresolvedBlockers?: string[];
    artifactRefs?: string[];
    maxChars?: number;
  };
}

interface ReconcileStalledInvocationsBody {
  now?: string;
}

interface HumanOverrideBody {
  reason: string;
  approver: string;
  unblockAction: HumanOverrideRecord['unblockAction'];
  subtaskId?: string;
  note?: string;
}

interface CreateArtifactBody {
  taskId?: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  attemptId?: string;
  title?: string;
  description?: string;
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  content?: string;
  contentType?: string;
  extension?: 'html' | 'md' | 'svg' | 'json' | 'txt' | 'diff';
  sourceEventIds?: string[];
  sourceEvidenceIds?: string[];
  changedFiles?: string[];
  validationRefs?: string[];
  decisionIds?: string[];
  producedBy?: Record<string, string>;
  summary?: string;
  risks?: string[];
  tags?: string[];
}

interface AppendArtifactVersionBody {
  content?: string;
  contentType?: string;
  extension?: 'html' | 'md' | 'svg' | 'json' | 'txt' | 'diff';
  sourceEventIds?: string[];
  sourceEvidenceIds?: string[];
  changedFiles?: string[];
  validationRefs?: string[];
  decisionIds?: string[];
  summary?: string;
}

interface GenerateTaskArtifactBody {
  template?: ArtifactTemplateName;
}

type AgentLoopReviewRoundBody = Omit<AgentLoopPayload, 'kind'> & WorkbenchTaskConfigurationBody;

interface AcceptTaskReviewBody {
  runId?: string;
  artifactId?: string;
  versionId?: string;
  message?: string;
  reviewer?: string;
}

interface RejectTaskReviewBody extends AcceptTaskReviewBody {
  reason?: string;
  retry?: boolean;
}

const MAX_LEGACY_PREVIEW_BYTES = 16 * 1024 * 1024;
interface AgentLoopWorktreeReviewRoundBody extends WorkbenchTaskConfigurationBody {
  rootTaskId?: string;
  round?: number;
  maxRounds?: number;
  repo?: string;
  title?: string;
  baseRef?: string;
  headRef?: string;
  headSha?: string;
  idempotencyKey?: string;
  workspaceBinding?: TaskWorkspaceBinding;
  allowedScope?: string[];
  acceptanceCriteria?: string[];
  reviewFocus?: string[];
  reviewInput?: AgentLoopPayload['reviewInput'];
  reviewInputSource?: NonNullable<AgentLoopPayload['reviewInput']>['source'];
  mergeRequestUrl?: string;
  fetchRemote?: string;
  fetchRef?: string;
  createdBy?: AgentLoopPayload['createdBy'];
  labels?: string[];
}
type AgentLoopFixWorkItemBody = Omit<AgentLoopPayload, 'kind'>;
type AgentLoopHumanReviewWorkItemBody = Omit<AgentLoopPayload, 'kind'>;

export async function createServer(
  kernel: ExecutionKernel,
  config: ServerConfig = { port: 3000, host: 'localhost' },
  options?: WorkspaceServerOptions,
) {
  const { default: Fastify } = await import('fastify');
  const apiToken = options?.apiToken || process.env.TIK_API_TOKEN;
  if (!apiToken && !options?.allowUnauthenticatedRemote && isRemoteBindHost(config.host)) {
    throw new Error('API token is required when binding Tik server to a non-localhost host.');
  }
  const fastify = Fastify({ logger: false });
  const skillRegistry = new SkillManifestRegistry(options?.workspaceRoot || kernel.projectPath || process.cwd());
  const corsOrigin = options?.dashboardOrigin || process.env.TIK_DASHBOARD_ORIGIN || 'http://localhost:5173';
  const serverWorkspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
  const multiAgentStore = new FileMultiAgentWorkflowStore(serverWorkspaceRoot);

  function resolveWorkspaceRoot(rootPath?: string): string {
    const resolved = rootPath || options?.workspaceRoot;
    if (!resolved) {
      throw new Error('workspaceRoot is required for workspace API routes');
    }
    return resolved;
  }

  function decorateWorkspaceApiReply(reply: any): void {
    reply.header('X-Tik-Workspace-Api-Version', WORKSPACE_PUBLIC_API_VERSION);
  }

  async function resolveWorkspaceProject(rootPath: string, projectName: string, sourceProjectPath?: string) {
    const orchestrator = new WorkspaceOrchestrator();
    const snapshot = await orchestrator.getStatus(rootPath);
    const settings = snapshot.settings;
    const candidates = (snapshot.state?.projects || []).filter((item) => item.projectName === projectName);
    const project = sourceProjectPath
      ? candidates.find((item) => (item.sourceProjectPath || item.projectPath) === sourceProjectPath)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!settings || !snapshot.state || !project) {
      throw new Error(sourceProjectPath
        ? `Workspace project not found: ${projectName} (${sourceProjectPath})`
        : `Workspace project not found or ambiguous: ${projectName}`);
    }
    return { orchestrator, snapshot, settings, project };
  }

  async function resolveWorkbenchWorkspaceBinding(
    rootPath: string,
    executionProjectPath: string,
    requested?: TaskWorkspaceBinding,
  ): Promise<TaskWorkspaceBinding> {
    const readModel = new WorkspaceReadModel(rootPath);
    const status = await readModel.readStatusView().catch(() => null);
    const projects = status?.state?.projects || [];
    const matchedProject = requested?.projectName
      ? projects.find((project) => (
        project.projectName === requested.projectName
        && (!requested.sourceProjectPath || (project.sourceProjectPath || project.projectPath) === requested.sourceProjectPath)
      ))
      : requested?.effectiveProjectPath
        ? projects.find((project) => (
          (project.effectiveProjectPath || project.projectPath) === requested.effectiveProjectPath
          || (project.sourceProjectPath || project.projectPath) === requested.effectiveProjectPath
        ))
        : projects.length === 1
          ? projects[0]
          : undefined;

    const baseBinding: TaskWorkspaceBinding = {
      workspaceRoot: rootPath,
      workspaceName: status?.settings?.workspaceName || path.basename(rootPath),
      workspaceFile: status?.settings?.workspaceFile,
      effectiveProjectPath: matchedProject?.effectiveProjectPath || matchedProject?.projectPath || executionProjectPath,
      projectName: matchedProject?.projectName,
      sourceProjectPath: matchedProject?.sourceProjectPath || matchedProject?.projectPath,
      laneId: matchedProject?.worktree?.laneId,
      worktreeKind: matchedProject?.worktree?.kind || 'root',
      worktreePath: matchedProject?.worktree?.worktreePath,
    };

    return {
      workspaceRoot: rootPath,
      workspaceName: requested?.workspaceName || baseBinding.workspaceName,
      workspaceFile: requested?.workspaceFile || baseBinding.workspaceFile,
      effectiveProjectPath: requested?.effectiveProjectPath || baseBinding.effectiveProjectPath,
      projectName: requested?.projectName || baseBinding.projectName,
      sourceProjectPath: requested?.sourceProjectPath || baseBinding.sourceProjectPath,
      laneId: requested?.laneId || baseBinding.laneId,
      worktreeKind: requested?.worktreeKind || baseBinding.worktreeKind,
      worktreePath: requested?.worktreePath || baseBinding.worktreePath,
    };
  }

  async function resolveSafeWorkbenchWorkspaceBinding(
    rootPath: string,
    executionProjectPath: string,
    requested: TaskWorkspaceBinding,
  ): Promise<TaskWorkspaceBinding> {
    const binding = await resolveWorkbenchWorkspaceBinding(rootPath, executionProjectPath, requested);
    await assertWorkspaceBindingInsideRoot(rootPath, binding);
    return binding;
  }

  async function resolveMultiAgentWorkspaceBinding(
    requested?: TaskWorkspaceBinding,
  ): Promise<TaskWorkspaceBinding | undefined> {
    if (!requested) {
      return undefined;
    }
    const rootPath = serverWorkspaceRoot;
    const executionProjectPath = requested.effectiveProjectPath || kernel.projectPath || rootPath;
    const binding = await resolveWorkbenchWorkspaceBinding(rootPath, executionProjectPath, {
      ...requested,
      workspaceRoot: rootPath,
      workspaceName: path.basename(rootPath),
    });
    await assertWorkspaceBindingInsideRoot(rootPath, binding);
    return binding;
  }

  function buildWorkbenchTaskDescription(
    title: string,
    goal: string,
    adjustment?: string,
  ): string {
    return [
      `${title}: ${goal}`,
      adjustment?.trim() ? `Adjustment note: ${adjustment.trim()}` : null,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n');
  }

  async function resolveWorkbenchEnvironmentPackBinding(
    body: WorkbenchTaskConfigurationBody,
  ) {
    const requestedPackId = body.environmentPackId?.trim();
    const activePack = await kernel.environmentPacks.getActivePack();
    const packs = requestedPackId
      ? await kernel.environmentPacks.listPacks()
      : [];
    const boundPack = requestedPackId
      ? packs.find((item) => item.id === requestedPackId) || null
      : activePack;

    if (requestedPackId && !boundPack) {
      throw new WorkbenchTaskError('environment_pack_not_found', `Environment pack not found: ${requestedPackId}`);
    }

    if (boundPack) {
      const invalidSkills = (body.selectedSkills || []).filter((skill) => !boundPack.skills.includes(skill));
      const invalidKnowledge = (body.selectedKnowledgeIds || []).filter((id) => !boundPack.knowledge.some((entry) => entry.id === id));
      if (invalidSkills.length > 0 || invalidKnowledge.length > 0) {
        throw new WorkbenchTaskError(
          'invalid_environment_selection',
          `Invalid task configuration. Unknown skills: ${invalidSkills.join(', ') || 'none'}. Unknown knowledge: ${invalidKnowledge.join(', ') || 'none'}.`,
        );
      }
    }

    const requestedSelection = {
      selectedSkills: body.selectedSkills,
      selectedKnowledgeIds: body.selectedKnowledgeIds,
    };

    return {
      environmentPackSnapshot: boundPack
        ? toEnvironmentPackSnapshot(boundPack)
        : undefined,
      environmentPackSelection: boundPack
        ? createEnvironmentPackSelection(boundPack, requestedSelection)
        : undefined,
    };
  }

  async function launchWorkbenchFollowUpTask(
    workbench: NonNullable<Partial<ExecutionKernel>['workbench']>,
    sourceTask: WorkbenchTaskRecord,
    adjustmentOverride?: string,
  ): Promise<WorkbenchTaskRecord> {
    const adjustment = adjustmentOverride?.trim() || sourceTask.lastAdjustment?.note?.trim();
    const workspaceBinding = sourceTask.workspaceBinding;
    const kernelTask = kernel.taskManager.create({
      description: buildWorkbenchTaskDescription(sourceTask.title, sourceTask.goal, adjustment),
      projectPath: workspaceBinding?.effectiveProjectPath || kernel.projectPath,
      environmentPackSnapshot: sourceTask.environmentPackSnapshot,
      environmentPackSelection: sourceTask.environmentPackSelection,
      workspaceBinding,
    });

    let followUpTask = await workbench.createTask({
      title: sourceTask.title,
      goal: sourceTask.goal,
      environmentPackSnapshot: sourceTask.environmentPackSnapshot,
      environmentPackSelection: sourceTask.environmentPackSelection,
      workspaceBinding,
    }, kernelTask.id);

    if (adjustment) {
      followUpTask = await workbench.updateTaskBrief(followUpTask.id, {
        title: followUpTask.title,
        goal: followUpTask.goal,
        adjustment,
      }) || followUpTask;
    }

    kernel.runTask(kernelTask, 'single').catch(() => {});
    return followUpTask;
  }

  async function steerAdjustedWorkbenchTask(
    workbench: NonNullable<Partial<ExecutionKernel>['workbench']>,
    task: WorkbenchTaskRecord,
    adjustment?: string,
  ): Promise<WorkbenchTaskRecord> {
    const nextConstraint = adjustment?.trim();
    if (!nextConstraint) {
      return task;
    }

    try {
      kernel.control(task.id, { type: 'inject_constraint', constraint: nextConstraint });
    } catch {}

    const waitingDecision = (await workbench.readPendingDecisions(task.id))[0];
    if (waitingDecision) {
      const resolution = await workbench.resolveDecision(task.id, waitingDecision.id, {
        optionId: 'reject',
        message: nextConstraint,
      });
      return resolution.task;
    }

    if (task.status === 'paused') {
      try {
        kernel.control(task.id, { type: 'resume' });
        return (await workbench.readTask(task.id)) || task;
      } catch {
        return task;
      }
    }

    return task;
  }

  // CORS
  fastify.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', corsOrigin);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
    if (req.method === 'OPTIONS') { return reply.send(); }
    if (apiToken && !isPublicApiRoute(req.method, req.url)) {
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${apiToken}`) {
        reply.code(401);
        return reply.send({ error: 'Unauthorized' });
      }
    }
  });

  // Create task (async — runs in background, returns task immediately)
  fastify.post<{ Body: CreateTaskInputV2 }>('/api/tasks', async (req) => {
    const activePack = await kernel.environmentPacks.getActivePack();
    const task = kernel.taskManager.create({
      ...req.body,
      environmentPackSnapshot: req.body.environmentPackSnapshot
        || (activePack ? toEnvironmentPackSnapshot(activePack) : undefined),
      environmentPackSelection: req.body.environmentPackSelection
        || (activePack ? createEnvironmentPackSelection(activePack) : undefined),
    });
    const mode: ExecutionMode = req.body.mode || 'single';
    // Run in background — no duplicate task creation
    kernel.runTask(task, mode).catch(() => {});
    return task;
  });

  // List tasks
  fastify.get('/api/tasks', async () => kernel.listTasks());

  // Get task
  fastify.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = kernel.getTask(req.params.id);
    if (!task) { reply.code(404); return { error: 'Task not found' }; }
    return task;
  });

  // Control task
  fastify.post<{ Params: { id: string }; Body: ControlCommand }>(
    '/api/tasks/:id/control',
    async (req, reply) => {
      try {
        kernel.control(req.params.id, req.body);
        return { ok: true };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  // Event stream (SSE)
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id/events',
    async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      reply.raw.write(': connected\n\n');

      // Send history
      const history = kernel.getEvents(req.params.id);
      for (const event of history) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      // Stream new events
      const stream = kernel.streamEvents(req.params.id);
      (async () => {
        for await (const event of stream) {
          if (reply.raw.destroyed) break;
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      })().catch(() => {});

      req.raw.on('close', () => { /* client disconnected */ });
    },
  );

  fastify.get(
    '/api/workbench/events',
    async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      reply.raw.write(': connected\n\n');

      const stream = kernel.streamAllEvents();
      (async () => {
        for await (const event of stream) {
          if (reply.raw.destroyed) break;
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      })().catch(() => {});

      req.raw.on('close', () => { /* client disconnected */ });
    },
  );

  fastify.post<{ Body: CreateWorkbenchTaskBody }>('/api/workbench/tasks', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    let environmentBinding: Awaited<ReturnType<typeof resolveWorkbenchEnvironmentPackBinding>>;
    try {
      environmentBinding = await resolveWorkbenchEnvironmentPackBinding(req.body);
    } catch (error) {
      const status = error instanceof WorkbenchTaskError && error.code === 'environment_pack_not_found' ? 404 : 400;
      reply.code(status);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
    const workspaceBinding = await resolveWorkbenchWorkspaceBinding(
      workspaceRoot,
      req.body.workspaceBinding?.effectiveProjectPath || kernel.projectPath,
      req.body.workspaceBinding,
    );

    const kernelTask = kernel.taskManager.create({
      description: buildWorkbenchTaskDescription(req.body.title, req.body.goal),
      projectPath: workspaceBinding.effectiveProjectPath,
      environmentPackSnapshot: environmentBinding.environmentPackSnapshot,
      environmentPackSelection: environmentBinding.environmentPackSelection,
      workspaceBinding,
    });
    const task = await workbench.createTask({
      ...req.body,
      environmentPackSnapshot: environmentBinding.environmentPackSnapshot,
      environmentPackSelection: environmentBinding.environmentPackSelection,
      workspaceBinding,
    }, kernelTask.id);
    kernel.runTask(kernelTask, 'single').catch(() => {});
    return { task };
  });

  fastify.get('/api/workbench/tasks', async (_req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    return { tasks: await workbench.listTasks() };
  });

  fastify.get('/api/v1/tasks', async (_req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    return { tasks: await workbench.listTasks() };
  });

  fastify.post<{ Body: CreateWorkbenchTaskBody }>('/api/v1/tasks', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    try {
      const environmentBinding = await resolveWorkbenchEnvironmentPackBinding(req.body);
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      const workspaceBinding = await resolveWorkbenchWorkspaceBinding(
        workspaceRoot,
        req.body.workspaceBinding?.effectiveProjectPath || kernel.projectPath,
        req.body.workspaceBinding,
      );
      const task = await workbench.createTask({
        title: req.body.title,
        description: req.body.description,
        goal: req.body.goal,
        status: req.body.status || 'backlog',
        priority: req.body.priority,
        labels: req.body.labels,
        parentTaskId: req.body.parentTaskId,
        humanAssignee: req.body.humanAssignee,
        environmentPackSnapshot: environmentBinding.environmentPackSnapshot,
        environmentPackSelection: environmentBinding.environmentPackSelection,
        workspaceBinding,
      });
      return { task };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateV1TaskBody }>('/api/v1/tasks/:id', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    try {
      const existingTask = await workbench.readTask(req.params.id);
      if (!existingTask) {
        return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
      }
      const body = { ...req.body };
      if (body.workspaceBinding) {
        if (hasOpenWorkbenchAttempt(existingTask)) {
          return sendV1Error(reply, 409, 'task_running', 'Cannot update workspace binding while a task attempt is running.');
        }
        const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
        body.workspaceBinding = await resolveSafeWorkbenchWorkspaceBinding(
          workspaceRoot,
          body.workspaceBinding.effectiveProjectPath || kernel.projectPath || process.cwd(),
          body.workspaceBinding,
        );
      }
      const task = await workbench.updateTaskTrackerMetadata(req.params.id, body);
      if (!task) {
        return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
      }
      return { task };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.post<{ Params: { id: string }; Body: { to: WorkbenchTaskRecord['status']; reason?: string; actor?: 'human' | 'agent' | 'daemon' | 'system' } }>(
    '/api/v1/tasks/:id/transitions',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.transitionTask(req.params.id, req.body.to, {
          reason: req.body.reason,
          actor: req.body.actor || 'human',
        });
        if (!task) {
          return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
        }
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: Pick<ControlCommand, 'type'> & { reason?: string } }>(
    '/api/workbench/tasks/:id/control',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }

      const nextStatusByCommand: Partial<Record<ControlCommand['type'], WorkbenchTaskStatus>> = {
        pause: 'paused',
        resume: 'running',
        stop: 'cancelled',
      };
      const nextStatus = nextStatusByCommand[req.body?.type];
      if (!nextStatus) {
        reply.code(400);
        return { error: `Unsupported workbench control command: ${req.body?.type || 'unknown'}` };
      }

      try {
        const existingTask = await workbench.readTask(req.params.id);
        if (!existingTask) {
          reply.code(404);
          return { error: 'Workbench task not found' };
        }
        if (req.body?.type === 'resume' && existingTask.status === 'in_review') {
          throw new WorkbenchTaskError(
            'human_review_resume_not_allowed',
            'Cannot resume a task that is in human review. Open the review artifact and accept or request changes instead.',
          );
        }
        const task = await workbench.transitionTask(req.params.id, nextStatus, {
          reason: req.body?.reason,
          actor: 'human',
        });
        return { task };
      } catch (error) {
        reply.code(error instanceof WorkbenchTaskError ? 409 : 400);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { body: string; authorKind?: 'human' | 'agent' | 'system'; authorId?: string } }>(
    '/api/v1/tasks/:id/comments',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.addComment(req.params.id, {
          authorKind: req.body.authorKind || 'human',
          authorId: req.body.authorId,
          body: req.body.body,
        });
        if (!task) {
          return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
        }
        injectHumanCommentIntoActiveTask(kernel, task, req.body);
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { add?: string[]; remove?: string[] } }>(
    '/api/v1/tasks/:id/labels',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.setLabels(req.params.id, req.body);
        if (!task) {
          return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
        }
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { add?: string[]; remove?: string[] } }>(
    '/api/v1/tasks/:id/dependencies',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.setTaskDependencies(req.params.id, req.body);
        if (!task) {
          return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
        }
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/v1/tasks/:id/routing-preview', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    try {
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      const workflow = await loadWorkspaceTrackerWorkflow(workspaceRoot);
      const task = await workbench.readTask(req.params.id);
      if (!task) {
        return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
      }
      const tracked = workbenchTaskToTrackedTaskForWorkflow(task, kernel.projectPath);
      if (tracked.stateKind !== 'active') {
        return {
          runnable: false,
          reason: tracked.stateKind,
          workflow: workflowSummary(workflow),
        };
      }
      const selectorReason = workflowV2SelectorSkipReason(workflow, tracked);
      if (selectorReason) {
        return {
          runnable: false,
          reason: selectorReason,
          workflow: workflowSummary(workflow),
        };
      }
      return {
        runnable: true,
        workflow: workflowSummary(workflow),
        routing: workflow.resolveRouting(tracked),
      };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/tasks/:id/multi-agent-workflow', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    try {
      const bundle = await resolveTaskMultiAgentWorkflowBundle(workbench, multiAgentStore, req.params.id);
      if (!bundle) {
        return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found for task');
      }
      return sanitizeMultiAgentWorkflowBundle(bundle);
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/v1/tasks/:id/run', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    try {
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      const workflow = await loadWorkspaceTrackerWorkflow(workspaceRoot);
      const task = await workbench.readTask(req.params.id);
      if (!task) {
        return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
      }
      const daemon = buildWorkbenchTrackerDaemon({
        kernel,
        workbench,
        workspaceRoot,
        importer: new SingleTrackedTaskImporter(workbenchTaskToTrackedTaskForWorkflow(task, kernel.projectPath)),
        workflow,
        runtimeRunners: options?.runtimeRunners,
      });
      const result = await daemon.tick();
      return {
        queued: false,
        result,
      };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.post<{ Body: CreateMultiAgentWorkflowInput }>(
    '/api/v1/multi-agent/workflows',
    async (req, reply) => {
      try {
        const workflow = await multiAgentStore.createWorkflow({
          ...req.body,
          workspaceBinding: await resolveMultiAgentWorkspaceBinding(req.body.workspaceBinding),
        });
        return { workflow };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId',
    async (req, reply) => {
      try {
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        return sanitizeMultiAgentWorkflowBundle(bundle);
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.patch<{ Params: { workflowId: string }; Body: MultiAgentWorkflowPatchBody }>(
    '/api/v1/multi-agent/workflows/:workflowId',
    async (req, reply) => {
      try {
        const existing = await multiAgentStore.readWorkflow(req.params.workflowId);
        if (!existing) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        if (req.body.status && req.body.status !== existing.status) {
          throw new MultiAgentCoordinationError(
            'invalid_transition',
            'Workflow status changes must be recorded through a codex-workflow decision.',
          );
        }
        const workflow = await multiAgentStore.updateWorkflow(existing.id, {
          currentHeadSha: req.body.headSha,
          metadata: req.body.metadata,
          policy: req.body.policy,
        });
        return { workflow };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordWorkflowDecisionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/decisions',
    async (req, reply) => {
      try {
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        const guard = evaluateWorkflowDecisionGuard(bundle, req.body.decision);
        if (!guard.accepted) {
          reply.code(409);
          return {
            decision: req.body.decision,
            guard,
            workflow: bundle.workflow,
          };
        }
        const recorded = await multiAgentStore.recordDecisionIfMatch(
          req.params.workflowId,
          req.body.decision,
          readIfMatch(req.headers['if-match']),
        );
        if (!recorded.guard.accepted) {
          reply.code(409);
          return {
            decision: req.body.decision,
            guard: recorded.guard,
            workflow: recorded.workflow,
          };
        }
        return {
          decision: recorded.decision,
          guard,
          workflow: recorded.workflow,
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordWorkflowDecisionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/decisions/preflight',
    async (req, reply) => {
      try {
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        let guard = evaluateWorkflowDecisionGuard(bundle, req.body.decision);
        if (guard.accepted) {
          const expectedLastDecisionId = readIfMatch(req.headers['if-match']);
          if (!lastDecisionMatchesForPreflight(bundle.workflow.lastDecisionId, expectedLastDecisionId)) {
            guard = {
              accepted: false,
              code: 'invalid_transition',
              message: `Decision history changed; expected ${expectedLastDecisionId || 'no last decision'}, current ${bundle.workflow.lastDecisionId || 'none'}.`,
              currentState: {
                expectedLastDecisionId,
                lastDecisionId: bundle.workflow.lastDecisionId,
              },
            };
          }
        }
        return {
          decision: req.body.decision,
          guard,
          workflow: bundle.workflow,
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: SaveContextSnapshotBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/context-snapshots',
    async (req, reply) => {
      try {
        const result = await multiAgentStore.saveContextSnapshot(
          req.params.workflowId,
          req.body.snapshot,
          readIfMatch(req.headers['if-match']),
        );
        if (!result.guard.accepted) {
          reply.code(409);
        }
        return result;
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string; target: WorkflowContextSnapshot['target'] } }>(
    '/api/v1/multi-agent/workflows/:workflowId/context-snapshots/:target',
    async (req, reply) => {
      try {
        const snapshot = await multiAgentStore.readContextSnapshot(req.params.workflowId, req.params.target);
        if (!snapshot) {
          return sendV1Error(reply, 404, 'context_snapshot_not_found', 'Context snapshot not found');
        }
        return { snapshot };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: ReconcileStalledInvocationsBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/invocations/reconcile-stalled',
    async (req, reply) => {
      try {
        const result = await multiAgentStore.reconcileStalledInvocations(req.params.workflowId, req.body || {});
        return {
          ...result,
          stalled: result.stalled.map(sanitizeAgentInvocation),
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: HumanOverrideBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/human-overrides',
    async (req, reply) => {
      try {
        return await multiAgentStore.recordHumanOverride(req.params.workflowId, req.body);
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: CompleteSubtaskActionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/actions/complete-subtask',
    async (req, reply) => {
      try {
        if (req.body.decision.action !== 'complete_subtask' || !req.body.decision.subtaskId) {
          throw new MultiAgentCoordinationError(
            'invalid_transition',
            'complete-subtask action requires a complete_subtask decision with subtaskId.',
          );
        }
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        const guard = evaluateWorkflowDecisionGuard(bundle, req.body.decision);
        if (!guard.accepted) {
          reply.code(409);
          return {
            decision: req.body.decision,
            guard,
            workflow: bundle.workflow,
            subtask: bundle.subtasks[req.body.decision.subtaskId],
          };
        }
        const decision = await multiAgentStore.recordDecision(req.params.workflowId, req.body.decision);
        const subtask = await multiAgentStore.updateSubtask(
          req.params.workflowId,
          req.body.decision.subtaskId,
          sanitizeSubtaskPatch({
            status: 'done',
            evidenceRefs: req.body.decision.evidenceRefs,
            ...req.body.subtaskPatch,
          }),
        );
        const workflow = await multiAgentStore.readWorkflow(req.params.workflowId);
        return {
          decision,
          guard,
          workflow: workflow || bundle.workflow,
          subtask,
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordImplementationActionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/actions/record-implementation',
    async (req, reply) => {
      try {
        if (req.body.decision.action !== 'record_implementation') {
          throw new MultiAgentCoordinationError(
            'invalid_transition',
            'record-implementation action requires a record_implementation decision.',
          );
        }
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        const now = new Date().toISOString();
        const plannedEvidence = {
          id: req.body.evidence.id || `ev_${generateId()}`,
          workflowId: req.params.workflowId,
          createdAt: now,
          ...req.body.evidence,
        };
        const guard = evaluateWorkflowDecisionGuard(
          {
            ...bundle,
            evidence: bundle.evidence.concat(plannedEvidence),
          },
          {
            ...req.body.decision,
            evidenceRefs: req.body.decision.evidenceRefs.length > 0
              ? req.body.decision.evidenceRefs
              : [plannedEvidence.id],
          },
        );
        if (!guard.accepted) {
          reply.code(409);
          return {
            decision: req.body.decision,
            evidence: plannedEvidence,
            guard,
            workflow: bundle.workflow,
            subtask: req.body.decision.subtaskId ? bundle.subtasks[req.body.decision.subtaskId] : undefined,
          };
        }
        const evidence = await multiAgentStore.recordEvidence(req.params.workflowId, {
          ...req.body.evidence,
          id: plannedEvidence.id,
        });
        const decision = await multiAgentStore.recordDecision(req.params.workflowId, {
          ...req.body.decision,
          evidenceRefs: req.body.decision.evidenceRefs.length > 0
            ? req.body.decision.evidenceRefs
            : [evidence.id],
        });
        const subtask = req.body.decision.subtaskId
          ? await multiAgentStore.updateSubtask(
            req.params.workflowId,
            req.body.decision.subtaskId,
            sanitizeSubtaskPatch({
              status: 'implemented',
              implementationHeadSha: evidence.headSha,
              evidenceRefs: [evidence.id],
              ...req.body.subtaskPatch,
            }),
          )
          : undefined;
        const workflow = await multiAgentStore.readWorkflow(req.params.workflowId);
        return { decision, evidence, guard, workflow: workflow || bundle.workflow, subtask };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordEvaluationResultActionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/actions/record-evaluation-result',
    async (req, reply) => {
      try {
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        let guard = { accepted: true, code: 'ok' as const };
        let decision: WorkflowDecision | undefined;
        if (req.body.decision) {
          guard = evaluateWorkflowDecisionGuard(bundle, req.body.decision) as typeof guard;
          if (!guard.accepted) {
            reply.code(409);
            return {
              decision: req.body.decision,
              guard,
              workflow: bundle.workflow,
              subtask: bundle.subtasks[req.body.subtaskId],
            };
          }
          decision = await multiAgentStore.recordDecision(req.params.workflowId, req.body.decision);
        }
        const evaluationRun = await multiAgentStore.recordEvaluationResult(
          req.params.workflowId,
          req.body.subtaskId,
          req.body.evaluationRunId,
          req.body.result,
        );
        const subtask = req.body.subtaskPatch
          ? await multiAgentStore.updateSubtask(
            req.params.workflowId,
            req.body.subtaskId,
            sanitizeSubtaskPatch(req.body.subtaskPatch),
          )
          : undefined;
        return { decision, guard, evaluationRun, subtask };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordQuestionerOutputActionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/actions/record-questioner-output',
    async (req, reply) => {
      try {
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        let guard = { accepted: true, code: 'ok' as const };
        let decision: WorkflowDecision | undefined;
        if (req.body.decision) {
          guard = evaluateWorkflowDecisionGuard(bundle, req.body.decision) as typeof guard;
          if (!guard.accepted) {
            reply.code(409);
            return {
              decision: req.body.decision,
              guard,
              workflow: bundle.workflow,
              subtask: req.body.output.subtaskId ? bundle.subtasks[req.body.output.subtaskId] : undefined,
            };
          }
          decision = await multiAgentStore.recordDecision(req.params.workflowId, req.body.decision);
        }
        const questionerOutput = await multiAgentStore.recordQuestionerOutput(req.params.workflowId, req.body.output);
        const subtask = req.body.output.subtaskId && req.body.subtaskPatch
          ? await multiAgentStore.updateSubtask(
            req.params.workflowId,
            req.body.output.subtaskId,
            sanitizeSubtaskPatch(req.body.subtaskPatch),
          )
          : undefined;
        return { decision, guard, questionerOutput, subtask };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: CompleteWorkflowActionBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/actions/complete-workflow',
    async (req, reply) => {
      try {
        if (req.body.decision.action !== 'complete_workflow') {
          throw new MultiAgentCoordinationError(
            'invalid_transition',
            'complete-workflow action requires a complete_workflow decision.',
          );
        }
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        const guard = evaluateWorkflowDecisionGuard(bundle, req.body.decision);
        if (!guard.accepted) {
          reply.code(409);
          return {
            decision: req.body.decision,
            guard,
            workflow: bundle.workflow,
          };
        }
        const decision = await multiAgentStore.recordDecision(req.params.workflowId, req.body.decision);
        const workflow = await multiAgentStore.readWorkflow(req.params.workflowId);
        return {
          decision,
          guard,
          workflow: workflow || bundle.workflow,
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/timeline',
    async (req, reply) => {
      try {
        return { events: await multiAgentStore.readTimeline(req.params.workflowId) };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.put<{ Params: { workflowId: string }; Body: PutTaskGraphBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/task-graph',
    async (req, reply) => {
      try {
        return await multiAgentStore.putTaskGraph(req.params.workflowId, req.body.graph);
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/task-graph',
    async (req, reply) => {
      try {
        const bundle = await multiAgentStore.readBundle(req.params.workflowId);
        if (!bundle) {
          return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found');
        }
        return {
          graph: bundle.taskGraph,
          subtasks: bundle.subtasks,
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.patch<{ Params: { workflowId: string; subtaskId: string }; Body: UpdateSubtaskBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId',
    async (req, reply) => {
      try {
        const patch = sanitizeSubtaskPatch(req.body);
        const subtask = await multiAgentStore.updateSubtask(req.params.workflowId, req.params.subtaskId, patch);
        return { subtask };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; subtaskId: string }; Body: CreateSprintContractBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/contracts',
    async (req, reply) => {
      try {
        const contract = await multiAgentStore.createContract(req.params.workflowId, req.params.subtaskId, req.body);
        return { contract };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string; subtaskId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/contracts/latest',
    async (req, reply) => {
      try {
        const contract = await multiAgentStore.readLatestContract(req.params.workflowId, req.params.subtaskId);
        if (!contract) {
          return sendV1Error(reply, 404, 'contract_not_found', 'SprintContract not found');
        }
        return { contract };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; subtaskId: string; contractId: string }; Body: AcceptSprintContractBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/contracts/:contractId/accept',
    async (req, reply) => {
      try {
        const contract = await multiAgentStore.acceptContract(req.params.workflowId, req.params.subtaskId, req.params.contractId, req.body);
        return { contract };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; subtaskId: string; contractId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/contracts/:contractId/stale',
    async (req, reply) => {
      try {
        const contract = await multiAgentStore.staleContract(req.params.workflowId, req.params.subtaskId, req.params.contractId);
        return { contract };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; subtaskId: string }; Body: CreateEvaluationRunBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/evaluations',
    async (req, reply) => {
      try {
        const evaluationRun = await multiAgentStore.createEvaluationRun(req.params.workflowId, req.params.subtaskId, req.body);
        return { evaluationRun };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.patch<{ Params: { workflowId: string; subtaskId: string; evaluationRunId: string }; Body: UpdateEvaluationRunBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/evaluations/:evaluationRunId',
    async (req, reply) => {
      try {
        const evaluationRun = await multiAgentStore.updateEvaluationRun(
          req.params.workflowId,
          req.params.subtaskId,
          req.params.evaluationRunId,
          req.body,
        );
        return { evaluationRun };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; subtaskId: string; evaluationRunId: string }; Body: RecordEvaluationResultBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/evaluations/:evaluationRunId/result',
    async (req, reply) => {
      try {
        const evaluationRun = await multiAgentStore.recordEvaluationResult(
          req.params.workflowId,
          req.params.subtaskId,
          req.params.evaluationRunId,
          req.body.result,
        );
        return { evaluationRun };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string; subtaskId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/evaluations/latest',
    async (req, reply) => {
      try {
        const evaluationRun = await multiAgentStore.readLatestEvaluationRun(req.params.workflowId, req.params.subtaskId);
        if (!evaluationRun) {
          return sendV1Error(reply, 404, 'evaluation_not_found', 'EvaluationRun not found');
        }
        return { evaluationRun };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; subtaskId: string; evaluationRunId: string }; Body: ValidateEvaluationReadonlyBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/subtasks/:subtaskId/evaluations/:evaluationRunId/validate-readonly',
    async (req, reply) => {
      try {
        const result = await multiAgentStore.validateEvaluationReadonly(
          req.params.workflowId,
          req.params.subtaskId,
          req.params.evaluationRunId,
          req.body,
        );
        if (!result.guard.accepted) {
          reply.code(409);
        }
        return result;
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordQuestionerOutputBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/questioner-outputs',
    async (req, reply) => {
      try {
        const questionerOutput = await multiAgentStore.recordQuestionerOutput(req.params.workflowId, req.body);
        return { questionerOutput };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string }; Querystring: { intent?: QuestionerOutput['intent']; subtaskId?: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/questioner-outputs/latest',
    async (req, reply) => {
      try {
        const questionerOutput = await multiAgentStore.readLatestQuestionerOutput(req.params.workflowId, {
          intent: req.query.intent,
          subtaskId: req.query.subtaskId,
        });
        if (!questionerOutput) {
          return sendV1Error(reply, 404, 'questioner_output_not_found', 'QuestionerOutput not found');
        }
        return { questionerOutput };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: RecordEvidenceBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/evidence',
    async (req, reply) => {
      try {
        const evidence = await multiAgentStore.recordEvidence(req.params.workflowId, req.body);
        return { evidence };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string }; Body: CreateAgentInvocationBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/agent-invocations',
    async (req, reply) => {
      try {
        const invocation = await multiAgentStore.createInvocation(req.params.workflowId, req.body);
        return { invocation };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get<{ Params: { workflowId: string; invocationId: string } }>(
    '/api/v1/multi-agent/workflows/:workflowId/agent-invocations/:invocationId',
    async (req, reply) => {
      try {
        const invocation = await multiAgentStore.readInvocation(req.params.workflowId, req.params.invocationId);
        if (!invocation) {
          return sendV1Error(reply, 404, 'invocation_not_found', 'Agent invocation not found');
        }
        return { invocation: sanitizeAgentInvocation(invocation) };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; invocationId: string }; Body: StartAgentInvocationBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/agent-invocations/:invocationId/start',
    async (req, reply) => {
      try {
        const invocation = await multiAgentStore.updateInvocation(req.params.workflowId, req.params.invocationId, {
          status: 'started',
        });
        return { invocation: sanitizeAgentInvocation(invocation) };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; invocationId: string }; Body: HookStartAgentInvocationBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/agent-invocations/:invocationId/hook-start',
    async (req, reply) => {
      try {
        const invocation = await multiAgentStore.attestInvocationStart(
          req.params.workflowId,
          req.params.invocationId,
          req.body,
        );
        return { invocation: sanitizeAgentInvocation(invocation) };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; invocationId: string }; Body: UpdateAgentInvocationBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/agent-invocations/:invocationId/result',
    async (req, reply) => {
      try {
        if (!isMultiAgentInvocationTerminalStatus(req.body.status)) {
          throw new MultiAgentCoordinationError(
            'invalid_invocation_status',
            'Agent invocation result status must be completed, failed, or cancelled.',
          );
        }
        const invocation = await multiAgentStore.updateInvocation(req.params.workflowId, req.params.invocationId, {
          status: req.body.status,
          result: req.body.result,
          error: req.body.error,
          threadId: req.body.threadId,
          actualSubagentThreadId: req.body.actualSubagentThreadId,
          parentThreadId: req.body.parentThreadId,
          headSha: req.body.headSha,
          evidenceRefs: req.body.evidenceRefs,
          evaluationRunId: req.body.evaluationRunId,
          readonlyPolicy: req.body.readonlyPolicy,
        });
        const taskGraph = invocation.role === 'planner' && invocation.status === 'completed'
          ? extractTaskGraphFromInvocationResult(invocation.result)
          : null;
        if (taskGraph) {
          const stored = await multiAgentStore.putTaskGraph(req.params.workflowId, taskGraph);
          return { invocation: sanitizeAgentInvocation(invocation), taskGraph: stored };
        }
        return { invocation: sanitizeAgentInvocation(invocation) };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { workflowId: string; invocationId: string }; Body: HookStopAgentInvocationBody }>(
    '/api/v1/multi-agent/workflows/:workflowId/agent-invocations/:invocationId/hook-stop',
    async (req, reply) => {
      try {
        const invocation = await multiAgentStore.attestInvocationStop(
          req.params.workflowId,
          req.params.invocationId,
          req.body,
        );
        return { invocation: sanitizeAgentInvocation(invocation) };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Body: AgentLoopReviewRoundBody }>(
    '/api/v1/agent-loop/review-rounds',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const environmentBinding = await resolveWorkbenchEnvironmentPackBinding(req.body);
        const task = await workbench.createReviewRound({
          ...req.body,
          environmentPackSnapshot: environmentBinding.environmentPackSnapshot,
          environmentPackSelection: environmentBinding.environmentPackSelection,
        } as AgentLoopReviewRoundBody);
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Body: AgentLoopWorktreeReviewRoundBody }>(
    '/api/v1/agent-loop/worktree-review-rounds',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const environmentBinding = await resolveWorkbenchEnvironmentPackBinding(req.body);
        const workspaceBinding = req.body.workspaceBinding
          || buildDefaultWorkspaceBinding(options?.workspaceRoot || kernel.projectPath || process.cwd(), kernel.projectPath || process.cwd());
        const projectPath = workspaceBinding.effectiveProjectPath || kernel.projectPath || process.cwd();
        const headSha = req.body.headSha?.trim() || readGitOutput(projectPath, ['rev-parse', 'HEAD']);
        const headRef = req.body.headRef?.trim() || readGitOutput(projectPath, ['branch', '--show-current']) || 'HEAD';
        const baseRef = req.body.baseRef?.trim() || 'HEAD~1';
        const rootTaskId = req.body.rootTaskId?.trim()
          || workspaceBinding.laneId
          || workspaceBinding.projectName
          || path.basename(projectPath);
        const repo = req.body.repo?.trim()
          || workspaceBinding.projectName
          || path.basename(projectPath);
        const changeRequestId = `${rootTaskId}:${headSha.slice(0, 12)}`;
        const task = await workbench.createReviewRound({
          rootTaskId,
          round: req.body.round ?? 1,
          maxRounds: req.body.maxRounds ?? 3,
          idempotencyKey: req.body.idempotencyKey || [
            'claude_review',
            'internal',
            repo,
            changeRequestId,
            headSha,
            `r${req.body.round ?? 1}`,
          ].join(':'),
          changeRequest: {
            scm: 'internal',
            repo,
            id: changeRequestId,
            type: 'internal_review',
            title: req.body.title || `Review ${repo} at ${headSha.slice(0, 12)}`,
            baseRef,
            headRef,
            headSha,
          },
          workspaceBinding,
          environmentPackSnapshot: environmentBinding.environmentPackSnapshot,
          environmentPackSelection: environmentBinding.environmentPackSelection,
          allowedScope: req.body.allowedScope,
          acceptanceCriteria: req.body.acceptanceCriteria,
          reviewFocus: req.body.reviewFocus,
          reviewInput: normalizeReviewInput(req.body),
          createdBy: req.body.createdBy || 'human',
          labels: req.body.labels,
        });
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Body: AgentLoopFixWorkItemBody }>(
    '/api/v1/agent-loop/fix-work-items',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.createFixWorkItem(req.body);
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Body: AgentLoopHumanReviewWorkItemBody }>(
    '/api/v1/agent-loop/human-review-work-items',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.createHumanReviewWorkItem(req.body);
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { expectedHeadSha: string; actualHeadSha: string } }>(
    '/api/v1/agent-loop/tasks/:id/stale',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const task = await workbench.markAgentLoopStale(req.params.id, req.body);
        if (!task) {
          return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
        }
        return { task };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/v1/agent-loop/tasks/:id/claude-review-runs',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
        const workflow = await loadWorkspaceTrackerWorkflow(workspaceRoot);
        const task = await workbench.readTask(req.params.id);
        if (!task) {
          return sendV1Error(reply, 404, 'task_not_found', 'Workbench task not found');
        }
        if (task.agentLoop?.kind !== 'claude_review') {
          return sendV1Error(reply, 400, 'not_claude_review_task', 'Workbench task is not a Claude review task');
        }
        const tracked = workbenchTaskToTrackedTaskForWorkflow(task, kernel.projectPath, {
          allowExternalClaudeReview: true,
        });
        const projectPath = tracked.repository?.executionPath || tracked.repository?.path || kernel.projectPath || process.cwd();
        const expectedHeadSha = task.agentLoop.headSha || task.agentLoop.changeRequest.headSha;
        if (expectedHeadSha) {
          const actualHeadSha = readGitOutput(projectPath, ['rev-parse', 'HEAD']);
          if (actualHeadSha !== expectedHeadSha) {
            const staleTask = await workbench.markAgentLoopStale(task.id, {
              expectedHeadSha,
              actualHeadSha,
            });
            return sendV1ErrorWithBody(reply, 409, 'head_sha_mismatch', 'Workbench task head sha no longer matches the worktree HEAD', {
              task: staleTask,
              expectedHeadSha,
              actualHeadSha,
            });
          }
        }
        const routing = workflow.resolveRouting(tracked);
        if (!routing || routing.runner !== 'claude-code') {
          return sendV1ErrorWithBody(reply, 409, 'not_claude_code_routed', 'Claude review task is not routed to the claude-code runtime', {
            workflow: workflowSummary(workflow),
            routing,
          });
        }
        const daemon = buildWorkbenchTrackerDaemon({
          kernel,
          workbench,
          workspaceRoot,
          importer: new SingleTrackedTaskImporter(tracked),
          workflow,
          runtimeRunners: options?.runtimeRunners,
        });
        const result = await daemon.runExplicitTask(tracked);
        const runId = result.runIds?.[tracked.shortIdentifier] || null;
        return {
          queued: false,
          runId,
          result,
        };
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: ReviewResult }>(
    '/api/v1/agent-loop/tasks/:id/review-result',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
      }

      try {
        return await workbench.completeAgentLoopReview(req.params.id, req.body);
      } catch (error) {
        return sendV1CaughtError(reply, error);
      }
    },
  );

  fastify.get('/api/v1/tracker/state', async (_req, reply) => {
    try {
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      const state = await FileTrackerDaemonStateStore.forWorkspace(workspaceRoot).load();
      const tasks = await (kernel as Partial<ExecutionKernel>).workbench?.listTasks?.();
      const listeners = buildTrackerListeners({
        workspaceRoot,
        apiPort: config.port,
        watching: state.watching ?? false,
      });
      const trackerWatchVisible = listeners.find((listener) => listener.id === 'tracker-watch')?.status === 'running';
      return {
        watching: Boolean((state.watching ?? false) && trackerWatchVisible),
        retries: state.retries,
        summary: buildTrackerStateSummary(tasks || []),
        listeners,
        recent: state.recent || [],
      };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.get('/api/v1/workflow', async (_req, reply) => {
    try {
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      return readTrackerWorkflowFile(workspaceRoot);
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.put<{ Body: WorkflowFileBody }>('/api/v1/workflow', async (req, reply) => {
    try {
      if (typeof req.body?.content !== 'string') {
        return sendV1Error(reply, 400, 'invalid_workflow', 'Workflow content is required.');
      }
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      const saved = await writeTrackerWorkflowFile(workspaceRoot, req.body.content);
      return {
        saved: true,
        path: saved.path,
        content: saved.content,
      };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.post('/api/v1/tracker/refresh', async (_req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      return sendV1Error(reply, 500, 'workbench_unavailable', 'Workbench service is unavailable');
    }

    try {
      const workspaceRoot = options?.workspaceRoot || kernel.projectPath || process.cwd();
      const workflow = await loadWorkspaceTrackerWorkflow(workspaceRoot);
      const daemon = buildWorkbenchTrackerDaemon({
        kernel,
        workbench,
        workspaceRoot,
        workflow,
        runtimeRunners: options?.runtimeRunners,
      });
      const result = await daemon.tick();
      return {
        queued: false,
        refreshedAt: new Date().toISOString(),
        result,
      };
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/workbench/tasks/:id/timeline', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    return { timeline: await workbench.readTimeline(req.params.id) };
  });

  fastify.get<{ Params: { id: string } }>('/api/workbench/tasks/:id/decisions', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    return { decisions: await workbench.readPendingDecisions(req.params.id) };
  });

  fastify.post<{
    Params: { id: string; decisionId: string };
    Body: { optionId?: string; message?: string };
  }>('/api/workbench/tasks/:id/decisions/:decisionId/resolve', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    try {
      const resolution = await workbench.resolveDecision(req.params.id, req.params.decisionId, {
        optionId: req.body?.optionId,
        message: req.body?.message,
      });
      return {
        task: resolution.task,
        decision: resolution.decision,
      };
    } catch (error) {
      reply.code(409);
      return { error: (error as Error).message };
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/workbench/tasks/:id/retry', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    const originalTask = await workbench.readTask(req.params.id);
    if (!originalTask) {
      reply.code(404);
      return { error: 'Workbench task not found' };
    }

    if (!canRetryWorkbenchTask(originalTask.status)) {
      reply.code(409);
      return { error: `Workbench task ${originalTask.id} cannot be retried from status ${originalTask.status}` };
    }

    const task = await launchWorkbenchFollowUpTask(workbench, originalTask);
    return { task };
  });

  fastify.post<{ Params: { id: string }; Body: WorkbenchTaskConfigurationBody }>(
    '/api/workbench/tasks/:id/configuration',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }

      const task = await workbench.readTask(req.params.id);
      if (!task) {
        reply.code(404);
        return { error: 'Workbench task not found' };
      }

      const requestedPackId = req.body.environmentPackId?.trim() || task.environmentPackSnapshot?.id;
      if (!requestedPackId) {
        reply.code(409);
        return { error: 'Task has no bound environment pack' };
      }

      const packs = await kernel.environmentPacks.listPacks();
      const pack = packs.find((item) => item.id === requestedPackId);
      if (!pack) {
        reply.code(404);
        return { error: `Environment pack not found: ${requestedPackId}` };
      }

      const switchingPack = requestedPackId !== task.environmentPackSnapshot?.id;
      const baseSelection = switchingPack
        ? createEnvironmentPackSelection(pack)
        : (task.environmentPackSelection || createEnvironmentPackSelection(pack));
      const nextSelection = {
        selectedSkills: req.body.selectedSkills ?? baseSelection.selectedSkills,
        selectedKnowledgeIds: req.body.selectedKnowledgeIds ?? baseSelection.selectedKnowledgeIds,
      };

      const invalidSkills = nextSelection.selectedSkills.filter((skill) => !pack.skills.includes(skill));
      const invalidKnowledge = nextSelection.selectedKnowledgeIds.filter((id) => !pack.knowledge.some((entry) => entry.id === id));
      if (invalidSkills.length > 0 || invalidKnowledge.length > 0) {
        reply.code(400);
        return {
          error: `Invalid task configuration. Unknown skills: ${invalidSkills.join(', ') || 'none'}. Unknown knowledge: ${invalidKnowledge.join(', ') || 'none'}.`,
        };
      }

      const updatedTask = await workbench.updateTaskConfiguration(
        req.params.id,
        createEnvironmentPackSelection(pack, nextSelection),
        toEnvironmentPackSnapshot(pack),
      );

      if (!updatedTask) {
        reply.code(404);
        return { error: 'Workbench task not found' };
      }

      kernel.taskManager.updateEnvironmentPackSelection?.(
        req.params.id,
        updatedTask.environmentPackSelection!,
        updatedTask.environmentPackSnapshot,
      );
      return { task: updatedTask };
    },
  );

  fastify.post<{ Params: { id: string }; Body: WorkbenchTaskBriefBody }>(
    '/api/workbench/tasks/:id/brief',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }

      const existingTask = await workbench.readTask(req.params.id);
      if (!existingTask) {
        reply.code(404);
        return { error: 'Workbench task not found' };
      }

      const nextTitle = (req.body.title ?? existingTask.title).trim();
      const nextGoal = (req.body.goal ?? existingTask.goal).trim();
      const adjustment = req.body.adjustment?.trim();

      if (!nextTitle) {
        reply.code(400);
        return { error: 'Task title is required' };
      }

      if (!nextGoal) {
        reply.code(400);
        return { error: 'Task goal is required' };
      }

      if (req.body.launchFollowUp && !canRetryWorkbenchTask(existingTask.status)) {
        reply.code(409);
        return { error: `Workbench task ${existingTask.id} cannot launch a follow-up pass from status ${existingTask.status}` };
      }

      if (
        nextTitle === existingTask.title
        && nextGoal === existingTask.goal
        && !adjustment
      ) {
        return { task: existingTask };
      }

      const updatedTask = await workbench.updateTaskBrief(req.params.id, {
        title: nextTitle,
        goal: nextGoal,
        adjustment,
      });

      if (!updatedTask) {
        reply.code(404);
        return { error: 'Workbench task not found' };
      }

      const description = buildWorkbenchTaskDescription(updatedTask.title, updatedTask.goal, adjustment);
      kernel.taskManager.updateDescription?.(req.params.id, description);
      const followUpTask = req.body.launchFollowUp
        ? await launchWorkbenchFollowUpTask(workbench, updatedTask, adjustment)
        : undefined;
      const responseTask = followUpTask
        ? updatedTask
        : await steerAdjustedWorkbenchTask(workbench, updatedTask, adjustment);

      return { task: responseTask, followUpTask };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/workbench/tasks/:id/brief/revert',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }

      try {
        const revertedTask = await workbench.revertLastTaskAdjustment(req.params.id);
        if (!revertedTask) {
          reply.code(404);
          return { error: 'Workbench task not found' };
        }

        const revertedDescription = `${revertedTask.title}: ${revertedTask.goal}`;
        kernel.taskManager.updateDescription?.(req.params.id, revertedDescription);
        return { task: revertedTask };
      } catch (error) {
        reply.code(409);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { id: string } }>('/api/workbench/tasks/:id/archive', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    try {
      const task = await workbench.archiveTask(req.params.id, {
        force: !kernel.getTask(req.params.id),
      });
      if (!task) {
        reply.code(404);
        return { error: 'Workbench task not found' };
      }
      return { task };
    } catch (error) {
      reply.code(409);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/workbench/tasks/:id/multi-agent-workflow', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    try {
      const bundle = await resolveTaskMultiAgentWorkflowBundle(workbench, multiAgentStore, req.params.id);
      if (!bundle) {
        return sendV1Error(reply, 404, 'workflow_not_found', 'Multi-agent workflow not found for task');
      }
      return sanitizeMultiAgentWorkflowBundle(bundle);
    } catch (error) {
      return sendV1CaughtError(reply, error);
    }
  });

  fastify.get<{
    Querystring: {
      taskId?: string;
      workspaceId?: string;
      projectId?: string;
      status?: ArtifactStatus;
      kind?: ArtifactKind;
      tag?: string;
      limit?: string;
      offset?: string;
      sort?: 'updatedAt.desc' | 'updatedAt.asc';
    };
  }>('/api/workbench/artifacts', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    return {
      artifacts: await workbench.listArtifacts({
        taskId: req.query.taskId,
        workspaceId: req.query.workspaceId,
        projectId: req.query.projectId,
        status: req.query.status,
        kind: req.query.kind,
        tag: req.query.tag,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        sort: req.query.sort,
      }),
    };
  });

  fastify.post<{ Body: CreateArtifactBody }>('/api/workbench/artifacts', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }
    if (!req.body?.taskId || !req.body.title || !req.body.kind || typeof req.body.content !== 'string') {
      reply.code(400);
      return { error: 'taskId, title, kind, and content are required' };
    }

    try {
      const artifact = await workbench.createArtifact({
        taskId: req.body.taskId,
        workspaceId: req.body.workspaceId,
        projectId: req.body.projectId,
        sessionId: req.body.sessionId,
        attemptId: req.body.attemptId,
        title: req.body.title,
        description: req.body.description,
        kind: req.body.kind,
        status: req.body.status,
        content: req.body.content,
        contentType: req.body.contentType || 'text/plain',
        extension: req.body.extension || 'txt',
        sourceEventIds: req.body.sourceEventIds,
        sourceEvidenceIds: req.body.sourceEvidenceIds,
        changedFiles: req.body.changedFiles,
        validationRefs: req.body.validationRefs,
        decisionIds: req.body.decisionIds,
        producedBy: req.body.producedBy,
        summary: req.body.summary,
        risks: req.body.risks,
        tags: req.body.tags,
      });
      return { artifact };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/workbench/tasks/:id/artifacts', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    return { artifacts: await workbench.listArtifacts({ taskId: req.params.id }) };
  });

  fastify.get<{ Params: { id: string } }>('/api/workbench/tasks/:id/runs', async (req, reply) => {
    try {
      const runStore = new FileAgentRunStore(resolveServerWorkspaceRoot(options, kernel));
      const runs = (await runStore.listRuns()).filter((run) => run.taskId === req.params.id);
      return { runs };
    } catch (error) {
      reply.code(500);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Params: { id: string; runId: string } }>('/api/workbench/tasks/:id/runs/:runId', async (req, reply) => {
    const runStore = new FileAgentRunStore(resolveServerWorkspaceRoot(options, kernel));
    const run = await runStore.readRun(req.params.runId).catch(() => null);
    if (!run || run.taskId !== req.params.id) {
      reply.code(404);
      return { error: 'Run not found' };
    }
    return { run };
  });

  fastify.get<{ Params: { id: string; runId: string } }>('/api/workbench/tasks/:id/runs/:runId/proof', async (req, reply) => {
    const proofStore = new FileRunProofStore(resolveServerWorkspaceRoot(options, kernel));
    const proof = await proofStore.readProof(req.params.runId).catch(() => null);
    if (!proof || proof.taskId !== req.params.id) {
      reply.code(404);
      return { error: 'Run proof not found' };
    }
    return { proof };
  });

  fastify.post<{ Params: { id: string; runId: string } }>(
    '/api/workbench/tasks/:id/runs/:runId/proof/regenerate',
    async (_req, reply) => {
      reply.code(501);
      return { error: 'Run proof regeneration is not implemented yet.' };
    },
  );

  fastify.post<{ Params: { id: string }; Body: GenerateTaskArtifactBody }>(
    '/api/workbench/tasks/:id/artifacts/generate',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }

      try {
        const artifact = await workbench.generateArtifactForTask(req.params.id, req.body?.template || 'task-review');
        return { artifact };
      } catch (error) {
        const status = error instanceof WorkbenchTaskError && error.code === 'task_not_found' ? 404 : 400;
        reply.code(status);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.get<{ Querystring: { path?: string } }>('/api/workbench/artifacts/preview', async (req, reply) => {
    if (!options?.enableLegacyPathArtifactPreview) {
      reply.code(410);
      return { error: 'Legacy path-based artifact preview is disabled. Use artifact-id preview routes instead.' };
    }
    const filePath = req.query.path;
    if (!filePath) {
      reply.code(400);
      return { error: 'path is required' };
    }

    const resolvedProjectRoot = path.resolve(kernel.projectPath);
    const resolvedFilePath = path.resolve(filePath);
    const relativePath = path.relative(resolvedProjectRoot, resolvedFilePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      reply.code(403);
      return { error: 'Artifact path must stay within the project root' };
    }

    try {
      assertPreviewExtensionAllowed(resolvedFilePath);
      const [rootRealPath, fileRealPath] = await Promise.all([
        fs.realpath(resolvedProjectRoot),
        fs.realpath(resolvedFilePath),
      ]);
      if (!isPathInside(rootRealPath, fileRealPath)) {
        reply.code(403);
        return { error: 'Artifact path must not escape the project root' };
      }
      const stat = await fs.stat(fileRealPath);
      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'Artifact preview path must be a file' };
      }
      if (stat.size > MAX_LEGACY_PREVIEW_BYTES) {
        reply.code(413);
        return { error: 'Artifact preview file is too large' };
      }
      const content = await fs.readFile(resolvedFilePath);
      reply.header('Deprecation', 'true');
      reply.header('Content-Type', getPreviewContentType(resolvedFilePath));
      reply.header('Content-Disposition', `inline; filename="${path.basename(resolvedFilePath)}"`);
      return reply.send(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.code(404);
        return { error: 'Artifact not found' };
      }
      if ((error as Error).message.startsWith('Unsupported artifact extension')) {
        reply.code(415);
        return { error: (error as Error).message };
      }
      if ((error as Error).message.includes('must stay within the project root')) {
        reply.code(403);
        return { error: (error as Error).message };
      }
      reply.code(500);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Params: { artifactId: string } }>('/api/workbench/artifacts/:artifactId', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    const artifact = await workbench.readArtifact(req.params.artifactId);
    if (!artifact) {
      reply.code(404);
      return { error: 'Artifact not found' };
    }
    return { artifact };
  });

  fastify.get<{ Params: { artifactId: string } }>('/api/workbench/artifacts/:artifactId/versions', async (req, reply) => {
    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    if (!workbench) {
      reply.code(500);
      return { error: 'Workbench service is unavailable' };
    }

    const artifact = await workbench.readArtifact(req.params.artifactId);
    if (!artifact) {
      reply.code(404);
      return { error: 'Artifact not found' };
    }
    return { versions: await workbench.listArtifactVersions(req.params.artifactId) };
  });

  fastify.post<{ Params: { artifactId: string }; Body: AppendArtifactVersionBody }>(
    '/api/workbench/artifacts/:artifactId/versions',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }
      if (typeof req.body?.content !== 'string') {
        reply.code(400);
        return { error: 'content is required' };
      }

      try {
        const artifact = await workbench.appendArtifactVersion({
          artifactId: req.params.artifactId,
          content: req.body.content,
          contentType: req.body.contentType || 'text/plain',
          extension: req.body.extension || 'txt',
          sourceEventIds: req.body.sourceEventIds,
          sourceEvidenceIds: req.body.sourceEvidenceIds,
          changedFiles: req.body.changedFiles,
          validationRefs: req.body.validationRefs,
          decisionIds: req.body.decisionIds,
          summary: req.body.summary,
        });
        return { artifact };
      } catch (error) {
        reply.code(404);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.get<{ Params: { artifactId: string; versionId: string } }>(
    '/api/workbench/artifacts/:artifactId/versions/:versionId/preview',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Artifact registry is unavailable' };
      }

      const payload = await workbench.readArtifactPreview(req.params.artifactId, req.params.versionId);
      if (!payload) {
        reply.code(404);
        return { error: 'Artifact preview not found' };
      }

      if (isMarkdownContentType(payload.version.contentType)) {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Content-Disposition', `inline; filename="v${payload.version.version}.html"`);
        return reply.send(renderMarkdownArtifactPreview(payload.content.toString('utf-8'), payload.artifact.title));
      }

      reply.header('Content-Type', payload.version.contentType);
      reply.header('Content-Disposition', `inline; filename="v${payload.version.version}${path.extname(payload.version.safeRelativePath)}"`);
      return reply.send(payload.content);
    },
  );

  fastify.post<{ Params: { artifactId: string }; Body: { actor?: string } }>(
    '/api/workbench/artifacts/:artifactId/accept',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }
      try {
        return { artifact: await workbench.acceptArtifact(req.params.artifactId, req.body?.actor) };
      } catch (error) {
        reply.code(404);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { artifactId: string }; Body: { reason?: string; actor?: string } }>(
    '/api/workbench/artifacts/:artifactId/reject',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }
      try {
        return { artifact: await workbench.rejectArtifact(req.params.artifactId, req.body?.reason || '', req.body?.actor) };
      } catch (error) {
        reply.code(400);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: AcceptTaskReviewBody }>(
    '/api/workbench/tasks/:id/review/accept',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }
      if (!req.body?.artifactId) {
        reply.code(400);
        return { error: 'artifactId is required' };
      }
      const artifact = await workbench.readArtifact(req.body.artifactId);
      if (!artifact || artifact.taskId !== req.params.id) {
        reply.code(404);
        return { error: 'Review artifact not found for task' };
      }
      try {
        const accepted = await workbench.acceptArtifact(req.body.artifactId, req.body.reviewer || 'api');
        const task = await workbench.readTask(req.params.id);
        return { artifact: accepted, task };
      } catch (error) {
        reply.code(400);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: RejectTaskReviewBody }>(
    '/api/workbench/tasks/:id/review/reject',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }
      if (!req.body?.artifactId) {
        reply.code(400);
        return { error: 'artifactId is required' };
      }
      if (!req.body.reason?.trim()) {
        reply.code(400);
        return { error: 'reason is required' };
      }
      const artifact = await workbench.readArtifact(req.body.artifactId);
      if (!artifact || artifact.taskId !== req.params.id) {
        reply.code(404);
        return { error: 'Review artifact not found for task' };
      }
      try {
        const rejected = await workbench.rejectArtifact(req.body.artifactId, req.body.reason, req.body.reviewer || 'api');
        const task = await workbench.readTask(req.params.id);
        return { artifact: rejected, task };
      } catch (error) {
        reply.code(400);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { artifactId: string }; Body: { actor?: string } }>(
    '/api/workbench/artifacts/:artifactId/archive',
    async (req, reply) => {
      const workbench = (kernel as Partial<ExecutionKernel>).workbench;
      if (!workbench) {
        reply.code(500);
        return { error: 'Workbench service is unavailable' };
      }
      try {
        return { artifact: await workbench.archiveArtifact(req.params.artifactId, req.body?.actor) };
      } catch (error) {
        reply.code(404);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.get('/api/environment-packs', async (_req, reply) => {
    const registry = (kernel as Partial<ExecutionKernel>).environmentPacks;
    if (!registry) {
      reply.code(500);
      return { error: 'Environment pack registry is unavailable' };
    }

    const [packs, activePack] = await Promise.all([
      registry.listPacks(),
      registry.getActivePack(),
    ]);

    return {
      packs,
      activePackId: activePack?.id || null,
    };
  });

  fastify.get('/api/environment-packs/dashboard', async (_req, reply) => {
    const registry = (kernel as Partial<ExecutionKernel>).environmentPacks;
    if (!registry) {
      reply.code(500);
      return { error: 'Environment pack registry is unavailable' };
    }

    const workbench = (kernel as Partial<ExecutionKernel>).workbench;
    const [packs, activePack, tasks] = await Promise.all([
      registry.listPacks(),
      registry.getActivePack(),
      workbench?.listTasks() || Promise.resolve([]),
    ]);

    return buildEnvironmentPackDashboard(
      options?.workspaceRoot || kernel.projectPath || process.cwd(),
      packs,
      activePack?.id || null,
      tasks,
    );
  });

  fastify.get('/api/environment-packs/active', async (_req, reply) => {
    const registry = (kernel as Partial<ExecutionKernel>).environmentPacks;
    if (!registry) {
      reply.code(500);
      return { error: 'Environment pack registry is unavailable' };
    }

    return {
      activePack: await registry.getActivePack(),
    };
  });

  fastify.post<{ Body: SwitchEnvironmentPackBody }>('/api/environment-packs/active', async (req, reply) => {
    const registry = (kernel as Partial<ExecutionKernel>).environmentPacks;
    if (!registry) {
      reply.code(500);
      return { error: 'Environment pack registry is unavailable' };
    }

    try {
      return {
        activePack: await registry.switchActivePack(req.body.packId),
      };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get('/api/skills/registry', async () => ({
    skills: await skillRegistry.listSkills(),
    generatedAt: new Date().toISOString(),
  }));

  fastify.post<{ Params: { id: string }; Body: SkillManifestMutationBody }>(
    '/api/skills/:id/draft',
    async (req, reply) => {
      try {
        return {
          skill: await skillRegistry.saveDraft(req.params.id, req.body),
        };
      } catch (error) {
        reply.code(400);
        return { error: (error as Error).message };
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: SkillManifestMutationBody }>(
    '/api/skills/:id/publish',
    async (req, reply) => {
      try {
        return {
          skill: await skillRegistry.publish(req.params.id, req.body),
        };
      } catch (error) {
        reply.code(400);
        return { error: (error as Error).message };
      }
    },
  );

  // Health
  fastify.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  fastify.get<{ Querystring: { rootPath?: string } }>('/api/workspace/status', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const readModel = new WorkspaceReadModel(resolveWorkspaceRoot(req.query.rootPath));
      return await readModel.readStatusView();
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Querystring: { rootPath?: string } }>('/api/workspace/board', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const readModel = new WorkspaceReadModel(resolveWorkspaceRoot(req.query.rootPath));
      return await readModel.readBoardView();
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Querystring: { rootPath?: string } }>('/api/workspace/report', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const readModel = new WorkspaceReadModel(resolveWorkspaceRoot(req.query.rootPath));
      return await readModel.readReportView();
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Querystring: { rootPath?: string } }>('/api/workspace/memory', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const readModel = new WorkspaceReadModel(resolveWorkspaceRoot(req.query.rootPath));
      const status = await readModel.readStatusView();
      return status.memory;
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Querystring: { rootPath?: string } }>('/api/workspace/decisions', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const readModel = new WorkspaceReadModel(resolveWorkspaceRoot(req.query.rootPath));
      const status = await readModel.readStatusView();
      return {
        apiVersion: status.apiVersion,
        schemaVersion: status.schemaVersion,
        decisions: status.state?.decisions || [],
        pending: (status.state?.decisions || []).filter((decision) => decision.status === 'pending'),
      };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.get<{ Querystring: { rootPath?: string } }>('/api/workspace/worktrees', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const readModel = new WorkspaceReadModel(resolveWorkspaceRoot(req.query.rootPath));
      const status = await readModel.readStatusView();
      return {
        apiVersion: status.apiVersion,
        schemaVersion: status.schemaVersion,
        worktrees: status.worktrees,
      };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.post<{
    Querystring: { rootPath?: string };
    Body: WorkspaceWorktreeMutationBody;
  }>('/api/workspace/worktrees/create', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const rootPath = resolveWorkspaceRoot(req.query.rootPath);
      const { orchestrator, settings, project } = await resolveWorkspaceProject(rootPath, req.body.projectName, req.body.sourceProjectPath);
      const manager = new WorkspaceWorktreeManager();
      const target = await manager.getExecutionTarget({
        workspaceName: settings.workspaceName,
        workspaceRoot: rootPath,
        projectName: project.projectName,
        sourceProjectPath: project.sourceProjectPath || project.projectPath,
        laneId: req.body.laneId,
        existingEffectiveProjectPath: project.effectiveProjectPath,
        existingWorktree: project.worktree,
        existingWorktreeLanes: project.worktreeLanes,
        policy: settings.worktreePolicy,
      });
      if (target.worktree) {
        await orchestrator.markProjectWorktreeReady(rootPath, project.projectName, {
          effectiveProjectPath: target.effectiveProjectPath,
          worktree: target.worktree,
        });
      }
      const readModel = new WorkspaceReadModel(rootPath);
      return await readModel.readStatusView();
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.post<{
    Querystring: { rootPath?: string };
    Body: WorkspaceWorktreeMutationBody;
  }>('/api/workspace/worktrees/use', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const rootPath = resolveWorkspaceRoot(req.query.rootPath);
      const { orchestrator, project } = await resolveWorkspaceProject(rootPath, req.body.projectName, req.body.sourceProjectPath);
      const readModel = new WorkspaceReadModel(rootPath);
      const status = await readModel.readStatusView();
      const entry = status.worktrees.entries.find((item) =>
        item.projectName === req.body.projectName
        && (!req.body.sourceProjectPath || item.sourceProjectPath === req.body.sourceProjectPath)
        && (item.laneId || 'primary') === (req.body.laneId || 'primary'),
      );
      if (!entry?.worktree) {
        throw new Error(`Managed worktree lane not found: ${req.body.projectName}/${req.body.laneId || 'primary'}`);
      }
      if (!entry.safeToActivate && !req.body.force) {
        throw new Error(`Worktree lane is not safe to activate without --force: ${entry.warnings.join(' | ')}`);
      }
      await orchestrator.activateProjectWorktreeLane(rootPath, project.projectName, {
        effectiveProjectPath: entry.effectiveProjectPath,
        worktree: entry.worktree,
      });
      return await readModel.readStatusView();
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.post<{
    Querystring: { rootPath?: string };
    Body: WorkspaceWorktreeMutationBody;
  }>('/api/workspace/worktrees/remove', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const rootPath = resolveWorkspaceRoot(req.query.rootPath);
      const { orchestrator, settings, project } = await resolveWorkspaceProject(rootPath, req.body.projectName, req.body.sourceProjectPath);
      const readModel = new WorkspaceReadModel(rootPath);
      const status = await readModel.readStatusView();
      const entry = status.worktrees.entries.find((item) =>
        item.projectName === req.body.projectName
        && (!req.body.sourceProjectPath || item.sourceProjectPath === req.body.sourceProjectPath)
        && (item.laneId || 'primary') === (req.body.laneId || 'primary'),
      );
      if (entry && !entry.safeToRemove && !req.body.force) {
        throw new Error(`Worktree lane is not safe to remove without --force: ${entry.warnings.join(' | ')}`);
      }
      const manager = new WorkspaceWorktreeManager();
      const removed = await manager.removeManagedWorktree({
        workspaceName: settings.workspaceName,
        workspaceRoot: rootPath,
        projectName: project.projectName,
        sourceProjectPath: project.sourceProjectPath || project.projectPath,
        laneId: req.body.laneId,
        existingWorktree: entry?.worktree || project.worktree,
        existingWorktreeLanes: project.worktreeLanes,
        policy: settings.worktreePolicy,
        force: Boolean(req.body.force),
      });
      if (removed.worktree) {
        await orchestrator.markProjectWorktreeRemoved(rootPath, project.projectName, {
          sourceProjectPath: removed.sourceProjectPath,
          worktree: removed.worktree,
        });
      }
      return await readModel.readStatusView();
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.post<{
    Params: { id: string };
    Querystring: { rootPath?: string };
    Body: ResolveWorkspaceDecisionBody;
  }>('/api/workspace/decisions/:id/resolve', async (req, reply) => {
    try {
      decorateWorkspaceApiReply(reply);
      const rootPath = resolveWorkspaceRoot(req.query.rootPath);
      const orchestrator = new WorkspaceOrchestrator();
      const status = await orchestrator.resolveDecision(rootPath, {
        decisionId: req.params.id,
        optionId: req.body?.optionId,
        message: req.body?.message,
      });
      return {
        apiVersion: WORKSPACE_PUBLIC_API_VERSION,
        schemaVersion: WORKSPACE_PUBLIC_SCHEMA_VERSION,
        decision: status.state?.decisions?.find((decision) => decision.id === req.params.id) || null,
        state: status.state,
      };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  await fastify.listen({ port: config.port, host: config.host });
  return fastify;
}

const COMMENT_INJECTION_STATES = new Set<WorkbenchTaskStatus>([
  'in_progress',
  'running',
  'waiting_for_user',
]);

function injectHumanCommentIntoActiveTask(
  kernel: ExecutionKernel,
  task: WorkbenchTaskRecord,
  body: { body: string; authorKind?: 'human' | 'agent' | 'system' },
): void {
  const authorKind = body.authorKind || 'human';
  const constraint = body.body?.trim();
  if (
    authorKind !== 'human'
    || !constraint
    || parseSlashCommand(constraint, authorKind)
    || !COMMENT_INJECTION_STATES.has(task.status)
  ) {
    return;
  }

  try {
    kernel.control(task.id, { type: 'inject_constraint', constraint });
  } catch {}
}

function hasOpenWorkbenchAttempt(task: WorkbenchTaskRecord): boolean {
  return Boolean(task.attempts?.some((attempt) => attempt.kernelTaskId && !attempt.finishedAt));
}

async function assertWorkspaceBindingInsideRoot(
  workspaceRoot: string,
  binding: TaskWorkspaceBinding,
): Promise<void> {
  const rootRealPath = await fs.realpath(workspaceRoot);
  const paths = [
    binding.effectiveProjectPath,
    binding.sourceProjectPath,
    binding.worktreePath,
  ].filter((item): item is string => Boolean(item));
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (!isPathInside(path.resolve(workspaceRoot), resolved)) {
      throw new WorkbenchTaskError('invalid_workspace_binding', `Workspace binding path must stay within workspace root: ${candidate}`);
    }
    const realCandidate = await fs.realpath(resolved).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkbenchTaskError('invalid_workspace_binding', `Workspace binding path does not exist: ${candidate}`);
      }
      throw error;
    });
    if (!isPathInside(rootRealPath, realCandidate)) {
      throw new WorkbenchTaskError('invalid_workspace_binding', `Workspace binding path must not escape workspace root: ${candidate}`);
    }
  }
}

function buildTrackerStateSummary(tasks: WorkbenchTaskRecord[]) {
  const summary = {
    activeCandidates: 0,
    activeRuns: 0,
    maintenance: 0,
    staleRunning: 0,
  };

  for (const task of tasks) {
    if (isWorkbenchTaskMaintenance(task)) {
      const hasOpenAttempt = Boolean(task.attempts?.some((attempt) => attempt.kernelTaskId && !attempt.finishedAt));
      if (!isWorkbenchTerminalStatus(task.status) || hasOpenAttempt) {
        summary.maintenance += 1;
      }
      continue;
    }
    const hasOpenAttempt = Boolean(task.attempts?.some((attempt) => attempt.kernelTaskId && !attempt.finishedAt));
    if (hasOpenAttempt) {
      summary.activeRuns += 1;
      continue;
    }
    if ((task.status === 'todo' || task.status === 'failed') && isWorkbenchTaskCodexDispatchable(task)) {
      summary.activeCandidates += 1;
      continue;
    }
    if (task.status === 'running' || task.status === 'in_progress') {
      summary.staleRunning += 1;
    }
  }

  return summary;
}

function buildTrackerListeners(input: {
  workspaceRoot: string;
  apiPort: number;
  watching: boolean;
}): TrackerListenerStatus[] {
  const processLines = readProcessLines();
  const tmuxSessions = readTmuxSessions();
  const dashboardPort = Number(process.env.TIK_DASHBOARD_PORT || 5173);
  const trackerProcess = findProcessLine(processLines, [
    'tracker watch',
    input.workspaceRoot,
  ]);
  const apiProcess = findProcessLine(processLines, [
    'serve',
    `--project ${input.workspaceRoot}`,
  ]);
  const dashboardProcess = findProcessLine(processLines, [
    '@tik/dashboard',
    `--port ${dashboardPort}`,
  ]) || findProcessLine(processLines, [
    'vite',
    `--port ${dashboardPort}`,
  ]);

  return [
    buildListenerStatus({
      id: 'tracker-watch',
      label: 'Tracker watch',
      expected: input.watching,
      processLine: trackerProcess,
      session: tmuxSessions.find((session) => session.includes('tik-tracker-watch')),
      requireProcessForRunning: true,
      fallbackDetail: input.watching
        ? 'Watch mode is marked active, but the local process was not visible.'
        : 'Watch mode is not marked active.',
    }),
    buildListenerStatus({
      id: 'api-server',
      label: 'API server',
      expected: true,
      processLine: apiProcess || findProcessByPort(input.apiPort),
      port: input.apiPort,
      session: tmuxSessions.find((session) => session.includes(`tik-api-${input.apiPort}`)),
      fallbackDetail: `API port ${input.apiPort} is expected for this server.`,
    }),
    buildListenerStatus({
      id: 'dashboard',
      label: 'Dashboard dev server',
      expected: false,
      processLine: dashboardProcess || findProcessByPort(dashboardPort),
      port: dashboardPort,
      session: tmuxSessions.find((session) => session.includes(`tik-dashboard-${dashboardPort}`)),
      fallbackDetail: `Dashboard dev server was not detected on port ${dashboardPort}.`,
    }),
  ];
}

function buildListenerStatus(input: {
  id: string;
  label: string;
  expected: boolean;
  fallbackDetail: string;
  processLine?: string | null;
  port?: number;
  session?: string;
  requireProcessForRunning?: boolean;
}): TrackerListenerStatus {
  const pid = input.processLine ? parseProcessPid(input.processLine) : undefined;
  const isRunning = input.requireProcessForRunning ? Boolean(pid) : Boolean(pid || input.session);
  const sessionName = input.session?.split(':')[0];
  const detailParts = [
    pid ? `pid ${pid}` : null,
    input.port ? `port ${input.port}` : null,
    sessionName ? `tmux ${sessionName}` : null,
  ].filter(Boolean);

  return {
    id: input.id,
    label: input.label,
    status: isRunning ? 'running' : input.expected ? 'expected' : 'stopped',
    detail: detailParts.length > 0 ? detailParts.join(' · ') : input.fallbackDetail,
    pid,
    port: input.port,
    session: sessionName,
  };
}

function readProcessLines(): string[] {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function readTmuxSessions(): string[] {
  const result = spawnSync('tmux', ['list-sessions'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function findProcessLine(lines: string[], requiredParts: string[]): string | null {
  const matches = lines.filter((line) => requiredParts.every((part) => line.includes(part)));
  return matches.find((line) => /^\d+\s+node\s+dist\/index\.js\b/.test(line))
    || matches.find((line) => /^\d+\s+node\b/.test(line) && line.includes('dist/index.js'))
    || matches.find((line) => /^\d+\s+node\b/.test(line))
    || matches[0]
    || null;
}

function findProcessByPort(port: number): string | null {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    return null;
  }
  const line = result.stdout.split('\n').find((item) => /^\S+\s+\d+\s+/.test(item));
  if (!line) {
    return null;
  }
  const [, pid] = line.trim().split(/\s+/);
  return pid ? `${pid} lsof:${port}` : line.trim();
}

function parseProcessPid(line: string): number | undefined {
  const match = line.trim().match(/^(\d+)/);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}

function getPreviewContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function assertPreviewExtensionAllowed(filePath: string): void {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (extension === 'log') {
    return;
  }
  normalizeArtifactExtension(extension);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMarkdownContentType(contentType: string): boolean {
  return /^text\/markdown\b/i.test(contentType) || /\bmarkdown\b/i.test(contentType);
}

function renderMarkdownArtifactPreview(markdown: string, title: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55;margin:0;padding:28px;color:#0f172a;background:#f8fafc;}',
    'main{max-width:860px;margin:0 auto;background:white;border:1px solid #e2e8f0;border-radius:12px;padding:28px;box-shadow:0 18px 45px rgba(15,23,42,.08);}',
    'h1,h2,h3{line-height:1.2;margin:1.2em 0 .5em;}h1{font-size:28px;margin-top:0;}h2{font-size:20px;border-top:1px solid #e2e8f0;padding-top:18px;}',
    'p,ul,ol,pre{margin:.7em 0;}li{margin:.25em 0;}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px;overflow:auto;}',
    'input[type=checkbox]{margin-right:8px;}',
    '</style>',
    '</head>',
    '<body>',
    `<main>${renderMarkdownSubset(markdown)}</main>`,
    '</body>',
    '</html>',
  ].join('');
}

function renderMarkdownSubset(markdown: string): string {
  const html: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph: string[] = [];
  let listOpen = false;
  let inCode = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      html.push(`<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(listItem[1])}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  closeList();
  return html.join('\n');
}

function renderInlineMarkdown(value: string): string {
  const checkbox = value.match(/^\[( |x|X)\]\s+(.+)$/);
  if (!checkbox) {
    return escapeHtml(value);
  }
  const checked = checkbox[1].toLowerCase() === 'x' ? ' checked' : '';
  return `<input type="checkbox" disabled${checked}>${escapeHtml(checkbox[2])}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDefaultWorkspaceBinding(workspaceRoot: string, projectPath: string): TaskWorkspaceBinding {
  return {
    workspaceRoot,
    workspaceName: path.basename(workspaceRoot),
    effectiveProjectPath: projectPath,
    projectName: path.basename(projectPath),
    sourceProjectPath: projectPath,
    worktreeKind: 'root',
  };
}

function readGitOutput(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`;
    throw new WorkbenchTaskError('git_unavailable', message);
  }
  return result.stdout.trim();
}

function normalizeReviewInput(
  body: Pick<
    AgentLoopWorktreeReviewRoundBody,
    'reviewInput' | 'reviewInputSource' | 'mergeRequestUrl' | 'fetchRemote' | 'fetchRef'
  >,
): NonNullable<AgentLoopPayload['reviewInput']> {
  const source = body.reviewInputSource || body.reviewInput?.source || (body.mergeRequestUrl ? 'merge_request' : 'local_diff');
  return {
    source,
    mergeRequestUrl: body.mergeRequestUrl || body.reviewInput?.mergeRequestUrl,
    fetchRemote: body.fetchRemote || body.reviewInput?.fetchRemote,
    fetchRef: body.fetchRef || body.reviewInput?.fetchRef,
  };
}

function buildWorkbenchTrackerDaemon(input: {
  kernel: ExecutionKernel;
  workbench: NonNullable<Partial<ExecutionKernel>['workbench']>;
  workspaceRoot: string;
  importer?: { listCandidateTasks(): Promise<TrackedTask[]> };
  workflow?: Awaited<ReturnType<typeof loadTrackerWorkflow>>;
  runtimeRunners?: Partial<Record<AgentRuntimeName, AgentRuntimeRunner>>;
}): TrackerDaemon {
  const worktreeManager = new WorkspaceWorktreeManager();
  const importer = input.importer
    || new WorkflowV2WorkbenchTaskImporter(input.workbench, input.kernel.projectPath);
  const agentRunStore = new FileAgentRunStore(input.workspaceRoot);
  return new TrackerDaemon({
    importer,
    stateStore: FileTrackerDaemonStateStore.forWorkspace(input.workspaceRoot),
    agentRunStore,
    runProofService: new RunProofService({
      proofStore: new FileRunProofStore(input.workspaceRoot),
      artifacts: new FileArtifactRegistry({ rootPath: input.workspaceRoot }),
    }),
    launcher: new WorkbenchTrackerLauncher(input.workbench, {
      workspaceRoot: input.workspaceRoot,
      defaultProjectPath: input.kernel.projectPath,
      workspaceName: path.basename(input.workspaceRoot),
      resolveExecutionTarget: async (targetInput) => {
        const target = await worktreeManager.getExecutionTarget({
          workspaceName: targetInput.workspaceName,
          workspaceRoot: targetInput.workspaceRoot,
          projectName: targetInput.projectName,
          sourceProjectPath: targetInput.sourceProjectPath,
          laneId: targetInput.laneId,
        });
        return {
          sourceProjectPath: target.sourceProjectPath,
          effectiveProjectPath: target.effectiveProjectPath,
          worktreeKind: target.worktree?.kind,
          worktreePath: target.worktree?.worktreePath,
        };
      },
      createKernelTask: (taskInput) => input.kernel.taskManager.create(taskInput),
      runTask: (task, runInput) => runWorkbenchKernelTaskInBackground(task, {
        taskId: runInput.workbenchTaskId,
        workbench: input.workbench,
        runTask: (kernelTask) => input.kernel.runTask(kernelTask as any, 'single'),
      }),
      isRunActive: (taskId) => Boolean(input.kernel.getSession?.(taskId)),
      stopTask: (taskId, reason) => {
        try {
          input.kernel.control(taskId, { type: 'stop', reason } as any);
        } catch {}
      },
    }),
    workspaceRoot: input.workspaceRoot,
    defaultProjectPath: input.kernel.projectPath,
    runtimeRunners: input.runtimeRunners || createDefaultRuntimeRunners(),
    workflow: input.workflow,
    maxConcurrentAgents: input.workflow?.config.polling.maxConcurrentAgents,
    pollIntervalMs: input.workflow?.config.polling.intervalMs,
    terminalStates: input.workflow?.config.tracker.terminalStates,
    workspaceHooks: input.workflow?.config.workspace.hooks,
    cleanupTerminalWorkspaces: input.workflow?.config.workspace.cleanupTerminal,
  });
}

async function loadWorkspaceTrackerWorkflow(workspaceRoot: string) {
  const workflowPath = await resolveTrackerWorkflowPath(workspaceRoot);
  return loadTrackerWorkflow(path.dirname(workflowPath), path.basename(workflowPath));
}

class SingleTrackedTaskImporter {
  constructor(private readonly task: TrackedTask) {}

  async listCandidateTasks(): Promise<TrackedTask[]> {
    return [this.task];
  }
}

function workbenchTaskToTrackedTaskForWorkflow(
  task: WorkbenchTaskRecord,
  defaultProjectPath: string,
  options: { allowExternalClaudeReview?: boolean } = {},
): TrackedTask {
  const identifier = task.identifier || task.shortIdentifier || task.id.slice(0, 8).toUpperCase();
  const latestOpenAttempt = (task.attempts || [])
    .filter((attempt) => attempt.kernelTaskId && !attempt.finishedAt)
    .sort((left, right) => left.attemptNumber - right.attemptNumber)
    .at(-1);
  return {
    id: task.id,
    shortIdentifier: identifier,
    title: task.title,
    description: task.description ?? task.goal,
    priority: task.priority ?? null,
    state: task.status,
    stateKind: isWorkflowV2CandidateStatus(task.status)
      && (options.allowExternalClaudeReview || !isWorkbenchTaskExternallyOwnedClaudeReview(task))
      ? 'active'
      : 'blocked',
    sourceUrl: task.sourceUrl,
    labels: task.labels || [],
    blockedBy: task.blockedBy || [],
    repository: {
      name: task.workspaceBinding?.projectName || path.basename(defaultProjectPath),
      path: task.workspaceBinding?.effectiveProjectPath || task.workspaceBinding?.sourceProjectPath || defaultProjectPath,
      executionPath: task.workspaceBinding?.effectiveProjectPath || task.workspaceBinding?.sourceProjectPath || defaultProjectPath,
      sourcePath: task.workspaceBinding?.sourceProjectPath || task.workspaceBinding?.effectiveProjectPath || defaultProjectPath,
      workspaceFile: task.workspaceBinding?.workspaceFile,
    },
    assignee: task.humanAssignee ?? task.assignee ?? null,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    activeKernelTaskId: latestOpenAttempt?.kernelTaskId || null,
    activeAttemptStartedAt: latestOpenAttempt?.startedAt || null,
    sourceKind: 'workbench',
    agentLoop: task.agentLoop,
    comments: task.comments,
    latestSummary: task.latestSummary,
  };
}

function isWorkflowV2CandidateStatus(status: WorkbenchTaskStatus): boolean {
  return status === 'todo'
    || status === 'retry'
    || status === 'in_progress'
    || status === 'running'
    || status === 'failed';
}

function resolveServerWorkspaceRoot(
  options: WorkspaceServerOptions | undefined,
  kernel: ExecutionKernel,
): string {
  return options?.workspaceRoot || kernel.projectPath;
}

function isRemoteBindHost(host: string | undefined): boolean {
  const normalized = (host || 'localhost').trim().toLowerCase();
  return normalized !== 'localhost'
    && normalized !== '127.0.0.1'
    && normalized !== '::1'
    && normalized !== '[::1]';
}

function isPublicApiRoute(method: string, url: string): boolean {
  if (method === 'OPTIONS') return true;
  const pathname = url.split('?')[0] || '/';
  return method === 'GET' && (pathname === '/api/health' || pathname === '/health');
}

function workflowV2SelectorSkipReason(
  workflow: Awaited<ReturnType<typeof loadTrackerWorkflow>>,
  task: TrackedTask,
): string | undefined {
  const selector = workflow.config.selector;
  if (!selector) return undefined;
  const labels = new Set(task.labels.map((label) => label.trim().toLowerCase()));
  for (const required of selector.includeLabels) {
    if (!labels.has(required.trim().toLowerCase())) {
      return `skipped, missing label ${required}`;
    }
  }
  for (const excluded of selector.excludeLabels) {
    if (labels.has(excluded.trim().toLowerCase())) {
      return `skipped, excluded label ${excluded}`;
    }
  }
  return undefined;
}

function workflowSummary(workflow: Awaited<ReturnType<typeof loadTrackerWorkflow>>) {
  return {
    version: workflow.version,
    path: workflow.path,
    workflowConfigHash: workflow.workflowConfigHash,
    workflowPromptHash: workflow.workflowPromptHash,
  };
}

const SENSITIVE_PAYLOAD_KEY_PARTS = new Set(['token', 'secret', 'password', 'passwd', 'credential']);

function sanitizeAgentInvocation(invocation: AgentInvocationRecord): AgentInvocationRecord {
  const { attestationToken: _attestationToken, ...publicInvocation } = invocation;
  return redactSensitiveObject(publicInvocation) as AgentInvocationRecord;
}

async function resolveTaskMultiAgentWorkflowBundle(
  workbench: { listTasks(): Promise<WorkbenchTaskRecord[]> },
  multiAgentStore: FileMultiAgentWorkflowStore,
  taskRef: string,
): Promise<MultiAgentWorkflowBundle | null> {
  const direct = await multiAgentStore.findBundleByWorkflowOrRootTaskId(taskRef);
  if (direct) {
    return direct;
  }

  const tasks = await workbench.listTasks();
  const task = tasks.find((item) =>
    item.id === taskRef
    || item.identifier === taskRef
    || item.shortIdentifier === taskRef
  );
  if (!task) {
    return null;
  }

  const candidates = [
    task.id,
    task.identifier,
    task.shortIdentifier,
    task.agentLoop?.rootTaskId,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidate of candidates) {
    const bundle = await multiAgentStore.findBundleByWorkflowOrRootTaskId(candidate);
    if (bundle) {
      return bundle;
    }
  }

  return null;
}

function sanitizeMultiAgentWorkflowBundle(bundle: MultiAgentWorkflowBundle): MultiAgentWorkflowBundle {
  return {
    ...bundle,
    workflow: redactSensitiveObject(bundle.workflow) as MultiAgentWorkflowBundle['workflow'],
    taskGraph: redactSensitiveObject(bundle.taskGraph) as MultiAgentWorkflowBundle['taskGraph'],
    contracts: redactSensitiveObject(bundle.contracts) as MultiAgentWorkflowBundle['contracts'],
    decisions: redactSensitiveObject(bundle.decisions) as MultiAgentWorkflowBundle['decisions'],
    evidence: redactSensitiveObject(bundle.evidence) as MultiAgentWorkflowBundle['evidence'],
    questionerOutputs: redactSensitiveObject(bundle.questionerOutputs) as MultiAgentWorkflowBundle['questionerOutputs'],
    invocations: bundle.invocations.map(sanitizeAgentInvocation),
    events: redactSensitiveObject(bundle.events) as MultiAgentWorkflowBundle['events'],
  };
}

function redactSensitiveObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    isSensitivePayloadKey(key) ? '[redacted]' : redactSensitiveObject(entry),
  ]));
}

function isSensitivePayloadKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase();
  const parts = normalized.split('_').filter(Boolean);
  return parts.some((part) => SENSITIVE_PAYLOAD_KEY_PARTS.has(part))
    || normalized.includes('api_key')
    || normalized.includes('private_key');
}

function sendV1Error(reply: any, statusCode: number, code: string, message: string) {
  reply.code(statusCode);
  return {
    error: {
      code,
      message,
    },
  };
}

function sendV1ErrorWithBody(
  reply: any,
  statusCode: number,
  code: string,
  message: string,
  body: Record<string, unknown>,
) {
  return {
    ...sendV1Error(reply, statusCode, code, message),
    ...body,
  };
}

function sendV1CaughtError(reply: any, error: unknown) {
  if (error instanceof MultiAgentCoordinationError) {
    const status = error.code.endsWith('_not_found')
      ? 404
      : error.code === 'invalid_id'
        || error.code === 'invalid_workflow'
        || error.code === 'invalid_task_graph'
        || error.code === 'invalid_subtask_patch'
        || error.code === 'invalid_invocation_status'
        ? 400
        : 409;
    return sendV1Error(reply, status, error.code, error.message);
  }

  if (error instanceof WorkbenchTaskError) {
    const status = error.code === 'task_not_found'
      ? 404
      : error.code === 'environment_pack_not_found'
        ? 404
        : error.code === 'invalid_comment' || error.code === 'invalid_environment_selection'
        ? 400
        : 409;
    return sendV1Error(reply, status, error.code, error.message);
  }

  return sendV1Error(reply, 500, 'internal_error', error instanceof Error ? error.message : String(error));
}

function readIfMatch(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function lastDecisionMatchesForPreflight(current: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined || expected === '*') {
    return true;
  }
  return current === expected;
}

const ALLOWED_SUBTASK_PATCH_KEYS = new Set([
  'status',
  'implementationHeadSha',
  'lastValidatedHeadSha',
  'lastReviewedHeadSha',
  'reviewRoundIds',
  'validationRunIds',
  'evidenceRefs',
  'blockerFindingIds',
  'fixRound',
]);

function sanitizeSubtaskPatch(input: UpdateSubtaskBody): Partial<SubtaskRunState> {
  const unknownKeys = Object.keys(input || {}).filter((key) => !ALLOWED_SUBTASK_PATCH_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new MultiAgentCoordinationError(
      'invalid_subtask_patch',
      `Unsupported subtask patch field${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`,
    );
  }
  return input;
}

function isMultiAgentInvocationTerminalStatus(
  status: AgentInvocationRecord['status'] | undefined,
): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function extractTaskGraphFromInvocationResult(result: Record<string, unknown> | undefined): TaskGraph | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const candidate = result.taskGraph && typeof result.taskGraph === 'object'
    ? result.taskGraph
    : result;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const graph = candidate as Partial<TaskGraph>;
  return typeof graph.workflowId === 'string'
    && typeof graph.version === 'number'
    && Array.isArray(graph.subtasks)
    ? graph as TaskGraph
    : null;
}
