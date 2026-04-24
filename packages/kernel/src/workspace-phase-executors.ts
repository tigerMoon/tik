import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentEvent,
  WorkspaceProjectWorktreeState,
  WorkflowExecutablePhase,
  WorkflowSubtaskResult,
  WorkflowSubtaskSpec,
} from '@tik/shared';
import { generateTaskId } from '@tik/shared';
import {
  collectCompletionEvidence,
  summarizeCompletionEvidence,
  type CompletionEvidence,
} from './workspace-completion-evidence.js';
import { WorkspaceContextAssembler } from './workspace-context-assembler.js';
import { WorkspacePolicyEngine } from './workspace-policy-engine.js';
import { WorkspaceSuperpowersClarifier } from './workspace-superpowers-clarifier.js';

export interface WorkspaceEngineProjectItem {
  projectName: string;
  projectPath: string;
  demand: string;
  reason?: string;
}

export interface WorkspaceEngineSnapshot {
  settings?: {
    workflowPolicy?: {
      profile?: import('@tik/shared').WorkspaceWorkflowPolicyProfile;
    } | null;
  } | null;
  state?: {
    createdAt?: string;
    currentPhase?: string;
    workspaceFeedback?: {
      required?: boolean;
      affectedProjects?: string[];
      nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
    };
    projects?: any[];
  } | null;
  splitDemands?: {
    items?: WorkspaceEngineProjectItem[];
  } | null;
}

export interface WorkspacePhaseProjectResult {
  projectName: string;
  status: 'completed' | 'blocked';
  summary: string;
  outputPath?: string;
  taskId?: string;
  executionMode?: 'native' | 'fallback';
  reused?: boolean;
  reasonLabel?: string;
}

export interface WorkspacePhaseOutcome {
  nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
  requiresFeedback?: boolean;
  completed?: boolean;
  projectResults: WorkspacePhaseProjectResult[];
}

export interface WorkspaceEventMonitorPort {
  onEvent(event: AgentEvent, context: WorkspaceSubtaskEventContext): void;
  onSubtaskRunning(record: { projectName: string; taskId: string }): void;
  onSubtaskFinished(record: { taskId: string }): void;
}

export interface WorkspaceSubtaskEventContext {
  taskId: string;
  projectName: string;
  projectPath: string;
  phase: WorkflowSubtaskSpec['phase'];
  contract: WorkflowSubtaskSpec['contract'];
  role: WorkflowSubtaskSpec['role'];
  skillName: WorkflowSubtaskSpec['skillName'];
}

export interface WorkspacePhaseReporter {
  onKickoff(title: string): void;
  onRunning(record: { projectName: string; skillName?: string; taskId: string; state: 'running'; summary?: string }): void;
  onTerminal(record: { projectName: string; skillName?: string; taskId: string; state: 'completed' | 'blocked' | 'failed'; summary?: string }): void;
  onProjectResult(result: WorkspacePhaseProjectResult): void;
  onInfo(message: string): void;
}

export interface WorkspacePhaseExecutorServices {
  orchestrator: any;
  contextAssembler: WorkspaceContextAssembler;
  policyEngine: WorkspacePolicyEngine;
  clarifier?: WorkspaceSuperpowersClarifier;
  eventStore?: {
    record(event: { level: 'workspace' | 'project'; kind: any; phase: any; projectName?: string; taskId?: string; message: string; metadata?: Record<string, unknown> }): void;
    count?(filter?: { phase?: WorkflowSubtaskSpec['phase']; projectName?: string; kind?: any }): number;
  };
  resolveWorkspaceSpecArtifact(projectPath: string, preferredPath: string): Promise<{ path?: string; ambiguous?: boolean; candidates: string[] }>;
  resolveWorkspacePlanArtifact(projectPath: string, options: { preferredPlanPath: string; preferredFeatureDir?: string | null }): Promise<{ path?: string; ambiguous?: boolean; candidates: string[] }>;
  buildWorkspaceSpecTargetPath(projectPath: string, projectName: string, demand: string): string;
  buildWorkspacePlanTargetPath(projectPath: string, projectName: string, demand: string): string;
  buildWorkspaceFeatureDir(projectPath: string, projectName: string, demand: string): string;
  workspaceFeatureDirForArtifact(artifactPath?: string | null): string | null;
  skillRuntimeFactory(): any;
  materializeWorkflowSkillDelegatedSpec(spec: WorkflowSubtaskSpec, runtime: any): Promise<WorkflowSubtaskSpec>;
  createSubtaskRuntime(
    provider: string,
    model: string | undefined,
    executionMode: 'single' | 'multi',
    onEvent?: (event: AgentEvent, context: WorkspaceSubtaskEventContext) => void | Promise<void>,
  ): any;
  createEventMonitor(provider: string): WorkspaceEventMonitorPort;
  createEventForwarder(monitor: WorkspaceEventMonitorPort): (event: AgentEvent, context: WorkspaceSubtaskEventContext) => void | Promise<void>;
  ensureWorkspaceExecutionTarget(input: {
    workspaceName: string;
    workspaceRoot: string;
    projectName: string;
    sourceProjectPath: string;
    existingEffectiveProjectPath?: string;
    existingWorktree?: WorkspaceProjectWorktreeState;
    existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
  }): Promise<{
    sourceProjectPath: string;
    effectiveProjectPath: string;
    worktree?: WorkspaceProjectWorktreeState;
  }>;
  resolvePhaseProvider(provider: string, phase: 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): string;
  resolveNativeRescueProvider(provider: string): string;
  runNativeWorkspaceArtifactRescue(spec: WorkflowSubtaskSpec, provider: string, model: string | undefined, summary: string): Promise<{ summary: string; outputPath?: string; executionMode?: 'native' }>;
  safeReadFile(filePath: string): Promise<string>;
  artifactWasMaterializedDuringWorkspaceRun(artifactPath: string, createdAt?: string): Promise<boolean>;
  isWorkspacePlanValid(planPath: string): Promise<boolean>;
  killWorkspaceTaskProcesses(taskIds: string[]): Promise<void>;
  captureGitChangedFiles(projectPath: string): Promise<Set<string>>;
}

interface WorkspaceResolvedExecutionTarget {
  sourceProjectPath: string;
  effectiveProjectPath: string;
  worktree?: WorkspaceProjectWorktreeState;
}

function remapArtifactPathToExecutionRoot(
  artifactPath: string | undefined,
  sourceProjectPath: string,
  effectiveProjectPath: string,
): string | undefined {
  if (!artifactPath) return undefined;
  if (artifactPath.startsWith(effectiveProjectPath)) return artifactPath;
  if (artifactPath.startsWith(sourceProjectPath)) {
    const relative = pathRelativeSafe(sourceProjectPath, artifactPath);
    return relative ? joinPathSafe(effectiveProjectPath, relative) : artifactPath;
  }
  return artifactPath;
}

function pathRelativeSafe(from: string, to: string): string | undefined {
  const relative = path.relative(from, to);
  if (!relative || relative.startsWith('..')) return undefined;
  return relative;
}

function joinPathSafe(root: string, relative: string): string {
  return path.join(root, relative);
}

async function ensureExecutionTarget(
  services: WorkspacePhaseExecutorServices,
  input: {
    workspaceName: string;
    workspaceRoot: string;
    item: WorkspaceEngineProjectItem;
    projectState?: {
      sourceProjectPath?: string;
      effectiveProjectPath?: string;
      worktree?: WorkspaceProjectWorktreeState;
      worktreeLanes?: WorkspaceProjectWorktreeState[];
    };
  },
): Promise<WorkspaceResolvedExecutionTarget> {
  return services.ensureWorkspaceExecutionTarget({
    workspaceName: input.workspaceName,
    workspaceRoot: input.workspaceRoot,
    projectName: input.item.projectName,
    sourceProjectPath: input.projectState?.sourceProjectPath || input.item.projectPath,
    existingEffectiveProjectPath: input.projectState?.effectiveProjectPath,
    existingWorktree: input.projectState?.worktree,
    existingWorktreeLanes: input.projectState?.worktreeLanes,
  });
}

function feedbackRetryCount(
  eventStore: WorkspacePhaseExecutorServices['eventStore'],
  phase: WorkflowExecutablePhase,
  projectNames: string[],
): number {
  if (!eventStore?.count) return 0;
  return Math.max(
    0,
    ...projectNames.map((projectName) => eventStore.count?.({
      phase,
      projectName,
      kind: 'feedback.recorded',
    }) || 0),
  );
}

async function maybeRecordFeedback(
  services: WorkspacePhaseExecutorServices,
  args: { rootPath: string; phase: WorkflowExecutablePhase; reason: string; projectNames: string[]; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const retryCount = feedbackRetryCount(services.eventStore, args.phase, args.projectNames);
  if (!services.policyEngine.shouldEscalateFeedback({ phase: args.phase, retryCount })) {
    services.eventStore?.record({
      level: 'workspace',
      kind: 'phase.blocked',
      phase: args.phase,
      message: `${args.phase} hit feedback retry budget; manual intervention required.`,
      metadata: {
        retryCount,
        affectedProjects: args.projectNames,
        ...(args.metadata || {}),
      },
    });
    return false;
  }
  await services.orchestrator.recordFeedback(args.rootPath, args.reason, args.projectNames, args.phase);
  services.eventStore?.record({
    level: 'workspace',
    kind: 'feedback.recorded',
    phase: args.phase,
    message: args.reason,
    metadata: {
      retryCount: retryCount + 1,
      affectedProjects: args.projectNames,
      ...(args.metadata || {}),
    },
  });
  return true;
}

function projectStateByName(snapshot: WorkspaceEngineSnapshot): Map<string, any> {
  return new Map(((snapshot.state?.projects || []) as any[]).map((project) => [project.projectName, project]));
}

function recordArtifactCompletion(
  services: WorkspacePhaseExecutorServices,
  args: {
    phase: WorkflowExecutablePhase;
    projectName: string;
    taskId?: string;
    artifactPath: string;
    summary: string;
    metadata?: Record<string, unknown>;
  },
): void {
  services.eventStore?.record({
    level: 'project',
    kind: 'artifact.detected',
    phase: args.phase,
    projectName: args.projectName,
    taskId: args.taskId,
    message: args.artifactPath,
    metadata: {
      artifactPath: args.artifactPath,
      ...(args.metadata || {}),
    },
  });
  services.eventStore?.record({
    level: 'project',
    kind: 'phase.completed',
    phase: args.phase,
    projectName: args.projectName,
    taskId: args.taskId,
    message: args.summary,
    metadata: {
      artifactPath: args.artifactPath,
      ...(args.metadata || {}),
    },
  });
}

function slugifyClarificationProject(projectName: string): string {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

async function buildClarificationArtifactPath(
  workspaceRoot: string,
  projectName: string,
): Promise<string> {
  const projectDir = path.join(workspaceRoot, '.workspace', 'clarifications', slugifyClarificationProject(projectName));
  await fs.mkdir(projectDir, { recursive: true });
  const entries = await fs.readdir(projectDir).catch(() => []);
  const attempts = entries
    .map((entry) => entry.match(/^clarify-(\d+)\.md$/)?.[1])
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const nextAttempt = (attempts.length > 0 ? Math.max(...attempts) : 0) + 1;
  return path.join(projectDir, `clarify-${nextAttempt}.md`);
}

export class WorkspaceClarifyPhaseExecutor {
  constructor(private readonly services: WorkspacePhaseExecutorServices) {}

  async run(args: {
    resolution: { workspace: { rootPath: string; workspaceFile: string } };
    snapshot: WorkspaceEngineSnapshot;
    items: WorkspaceEngineProjectItem[];
    provider: string;
    model?: string;
    autoAdvance: boolean;
    reporter: WorkspacePhaseReporter;
  }): Promise<WorkspacePhaseOutcome> {
    args.reporter.onKickoff('Parallel Clarify');
    this.services.eventStore?.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_CLARIFY',
      message: 'Clarify phase started.',
    });
    const clarifier = this.services.clarifier ?? new WorkspaceSuperpowersClarifier();
    const stateByName = projectStateByName(args.snapshot);
    const splitByName = new Map((args.snapshot.splitDemands?.items || []).map((item) => [item.projectName, item]));
    const phaseResults: WorkspacePhaseProjectResult[] = [];

    for (const item of args.items) {
      const projectState = stateByName.get(item.projectName);
      const artifactPath = await buildClarificationArtifactPath(args.resolution.workspace.rootPath, item.projectName);
      const clarifyTaskId = generateTaskId();
      const effectiveProjectPath = projectState?.effectiveProjectPath || projectState?.projectPath || item.projectPath;
      const clarification = await clarifier.clarify({
        projectName: item.projectName,
        projectPath: effectiveProjectPath,
        demand: item.demand,
        phase: 'PARALLEL_CLARIFY',
        workflowProfile: args.snapshot.settings?.workflowPolicy?.profile,
        splitReason: splitByName.get(item.projectName)?.reason,
        summary: projectState?.summary,
        specPath: projectState?.specPath,
        planPath: projectState?.planPath,
        sessionNextAction: projectState?.recommendedCommand,
        specExcerpt: projectState?.clarificationPath ? await this.services.safeReadFile(projectState.clarificationPath).catch(() => '') : undefined,
      }, new Date().toISOString());

      await fs.writeFile(artifactPath, clarification.artifactBody, 'utf-8');
      this.services.eventStore?.record({
        level: 'project',
        kind: 'artifact.detected',
        phase: 'PARALLEL_CLARIFY',
        projectName: item.projectName,
        taskId: clarifyTaskId,
        message: artifactPath,
        metadata: {
          artifactPath,
          method: clarification.method,
          category: clarification.category,
          needsHumanDecision: clarification.needsClarification,
        },
      });

      if (clarification.needsClarification && clarification.decision) {
        await this.services.orchestrator.markClarifyBlocked(
          args.resolution.workspace.rootPath,
          item.projectName,
          artifactPath,
          clarification.summary,
          clarifyTaskId,
          'awaiting_decision',
          clarification.decision,
        );
        this.services.eventStore?.record({
          level: 'project',
          kind: 'phase.blocked',
          phase: 'PARALLEL_CLARIFY',
          projectName: item.projectName,
          taskId: clarifyTaskId,
          message: clarification.summary,
          metadata: {
            decisionKind: clarification.decision.kind,
            recommendedOptionId: clarification.decision.recommendedOptionId,
            nextPhase: clarification.recommendedNextPhase,
          },
        });
        phaseResults.push({
          projectName: item.projectName,
          status: 'blocked',
          summary: clarification.summary,
          outputPath: artifactPath,
          taskId: clarifyTaskId,
          executionMode: 'native',
          reasonLabel: '(clarification required)',
        });
      } else {
        await this.services.orchestrator.markClarifyResult(
          args.resolution.workspace.rootPath,
          item.projectName,
          artifactPath,
          clarification.summary,
          clarifyTaskId,
          clarification.category === 'skip' ? 'skipped' : 'generated',
        );
        this.services.eventStore?.record({
          level: 'project',
          kind: 'phase.completed',
          phase: 'PARALLEL_CLARIFY',
          projectName: item.projectName,
          taskId: clarifyTaskId,
          message: clarification.summary,
          metadata: {
            artifactPath,
            method: clarification.method,
            category: clarification.category,
            nextPhase: clarification.recommendedNextPhase,
          },
        });
        phaseResults.push({
          projectName: item.projectName,
          status: 'completed',
          summary: clarification.summary,
          outputPath: artifactPath,
          taskId: clarifyTaskId,
          executionMode: 'native',
        });
      }
    }

    const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
    const advancedPhase = advancedSnapshot.state?.currentPhase;
    return {
      completed: advancedPhase === 'COMPLETED',
      requiresFeedback: advancedPhase === 'FEEDBACK_ITERATION',
      nextPhase: advancedPhase === 'PARALLEL_CLARIFY' || advancedPhase === 'PARALLEL_SPECIFY' || advancedPhase === 'PARALLEL_PLAN' || advancedPhase === 'PARALLEL_ACE'
        ? advancedPhase
        : undefined,
      projectResults: phaseResults,
    };
  }
}

export class WorkspaceSpecifyPhaseExecutor {
  constructor(private readonly services: WorkspacePhaseExecutorServices) {}

  async run(args: {
    resolution: { workspace: { rootPath: string; workspaceFile: string } };
    snapshot: WorkspaceEngineSnapshot;
    items: WorkspaceEngineProjectItem[];
    provider: string;
    model?: string;
    autoAdvance: boolean;
    reporter: WorkspacePhaseReporter;
  }): Promise<WorkspacePhaseOutcome> {
    const phaseProvider = this.services.resolvePhaseProvider(args.provider, 'PARALLEL_SPECIFY');
    args.reporter.onKickoff('Parallel Specify');
    this.services.eventStore?.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_SPECIFY',
      message: 'Specify phase started.',
    });
    const skillRuntime = this.services.skillRuntimeFactory();
    const monitor = this.services.createEventMonitor(phaseProvider);
    const runtime = this.services.createSubtaskRuntime(
      phaseProvider,
      args.model,
      'single',
      this.services.createEventForwarder(monitor),
    );
    const supervisor = new (await import('./subtask-supervisor.js')).WorkflowSubtaskSupervisor(runtime);
    const plans: Array<{
      item: WorkspaceEngineProjectItem;
      executionTarget?: WorkspaceResolvedExecutionTarget;
      existingSpecPath?: string;
      specFeatureDir?: string | null;
      spec?: WorkflowSubtaskSpec;
    }> = [];
    const stateByName = projectStateByName(args.snapshot);
    for (const item of args.items) {
      const projectState = stateByName.get(item.projectName);
      let executionTarget: WorkspaceResolvedExecutionTarget;
      try {
        executionTarget = await ensureExecutionTarget(this.services, {
          workspaceName: path.basename(args.resolution.workspace.workspaceFile, '.code-workspace'),
          workspaceRoot: args.resolution.workspace.rootPath,
          item,
          projectState,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.services.orchestrator.markProjectBlocked(
          args.resolution.workspace.rootPath,
          item.projectName,
          'PARALLEL_SPECIFY',
          `Unable to prepare execution path: ${message}`,
          projectState?.specTaskId,
        );
        plans.push({ item });
        continue;
      }
      const expectedSpecPath = remapArtifactPathToExecutionRoot(
        projectState?.specPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspaceSpecTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const specResolution = await this.services.resolveWorkspaceSpecArtifact(executionTarget.effectiveProjectPath, expectedSpecPath);
      if (specResolution.ambiguous) {
        await this.services.orchestrator.markProjectBlocked(
          args.resolution.workspace.rootPath,
          item.projectName,
          'PARALLEL_SPECIFY',
          `Multiple feature specs found; unable to choose automatically: ${specResolution.candidates.join(', ')}`,
          projectState?.specTaskId,
        );
        plans.push({ item, executionTarget });
        continue;
      }
      if (specResolution.path) {
        plans.push({
          item,
          executionTarget,
          existingSpecPath: specResolution.path,
          specFeatureDir: this.services.workspaceFeatureDirForArtifact(specResolution.path),
        });
        continue;
      }
      const rawSpec = this.services.contextAssembler.buildSpecifySubtaskSpec({
        projectName: item.projectName,
        projectPath: executionTarget.effectiveProjectPath,
        sourceProjectPath: executionTarget.sourceProjectPath,
        effectiveProjectPath: executionTarget.effectiveProjectPath,
        demand: item.demand,
        workspaceRoot: args.resolution.workspace.rootPath,
        workspaceFile: args.resolution.workspace.workspaceFile,
        targetSpecPath: expectedSpecPath,
      });
      plans.push({
        item,
        executionTarget,
        spec: await this.services.materializeWorkflowSkillDelegatedSpec(rawSpec, skillRuntime),
      });
    }

    const executableSpecs = plans.filter((plan): plan is typeof plan & { spec: WorkflowSubtaskSpec } => Boolean(plan.spec)).map((plan) => plan.spec);
    const prepared = executableSpecs.length > 0 ? supervisor.prepare(executableSpecs) : { handles: [], records: [] };
    const resultMap = new Map<string, WorkflowSubtaskResult>();
    const phaseResults: WorkspacePhaseProjectResult[] = [];
    if (prepared.handles.length > 0) {
      try {
        const executed = await Promise.race([
          supervisor.executePrepared(prepared, async (record: any) => {
            if (record.state === 'running') {
              args.reporter.onRunning(record);
              monitor.onSubtaskRunning(record);
              this.services.eventStore?.record({
                level: 'project',
                kind: 'subtask.started',
                phase: 'PARALLEL_SPECIFY',
                projectName: record.projectName,
                taskId: record.taskId,
                message: 'Specify delegated subtask started.',
              });
              await this.services.orchestrator.markProjectInProgress(
                args.resolution.workspace.rootPath,
                record.projectName,
                'PARALLEL_SPECIFY',
                'Delegating sdd-specify skill task.',
                record.taskId,
              );
              return;
            }
            monitor.onSubtaskFinished(record);
            args.reporter.onTerminal(record);
          }),
          new Promise<WorkflowSubtaskResult[]>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Specify phase timed out after ${Math.floor(this.services.policyEngine.getPhaseBudgetMs('PARALLEL_SPECIFY') / 1000)}s.`)),
              this.services.policyEngine.getPhaseBudgetMs('PARALLEL_SPECIFY'),
            ).unref();
          }),
        ]);
        for (const result of executed) resultMap.set(result.projectName, result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await supervisor.cancelPrepared(prepared);
        for (const record of prepared.records) monitor.onSubtaskFinished({ taskId: record.taskId });
        await this.services.killWorkspaceTaskProcesses(prepared.records.map((record: any) => record.taskId));
        const blockedProjects: string[] = [];
        for (const plan of plans) {
          if (plan.existingSpecPath) {
            await this.services.orchestrator.markSpecifyResult(args.resolution.workspace.rootPath, plan.item.projectName, plan.existingSpecPath, 'Reused existing workspace spec.', undefined);
            recordArtifactCompletion(this.services, {
              phase: 'PARALLEL_SPECIFY',
              projectName: plan.item.projectName,
              artifactPath: plan.existingSpecPath,
              summary: 'Reused existing workspace spec.',
              metadata: { reused: true },
            });
            phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary: 'Reused existing workspace spec.', outputPath: plan.existingSpecPath, reused: true });
            continue;
          }
          if (!plan.spec) continue;
          const record = prepared.records.find((entry: any) => entry.projectName === plan.item.projectName);
          try {
            const rescueOutcome = await this.services.runNativeWorkspaceArtifactRescue(
              plan.spec,
              this.services.resolveNativeRescueProvider(phaseProvider),
              args.model,
              `Recovered target spec after delegated specify timeout: ${reason}`,
            );
            const rescuedSpecPath = (await this.services.resolveWorkspaceSpecArtifact(
              plan.executionTarget?.effectiveProjectPath || plan.item.projectPath,
              plan.spec.inputs.targetSpecPath || this.services.buildWorkspaceSpecTargetPath(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
            )).path;
            if (!rescuedSpecPath) throw new Error('Native rescue completed without writing the target spec artifact.');
            await this.services.orchestrator.markSpecifyResult(
              args.resolution.workspace.rootPath,
              plan.item.projectName,
              rescuedSpecPath,
              rescueOutcome.summary || 'Recovered workspace spec via native artifact rescue.',
              record?.taskId,
              'native',
            );
            recordArtifactCompletion(this.services, {
              phase: 'PARALLEL_SPECIFY',
              projectName: plan.item.projectName,
              taskId: record?.taskId,
              artifactPath: rescuedSpecPath,
              summary: rescueOutcome.summary || 'Recovered workspace spec via native artifact rescue.',
              metadata: { source: 'native-rescue' },
            });
            phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary: rescueOutcome.summary || 'Recovered workspace spec via native artifact rescue.', outputPath: rescuedSpecPath, taskId: record?.taskId, executionMode: 'native' });
          } catch (rescueError) {
            const rescueMessage = rescueError instanceof Error ? rescueError.message : String(rescueError);
            blockedProjects.push(plan.item.projectName);
            await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, plan.item.projectName, 'PARALLEL_SPECIFY', `Specify timed out and native rescue did not produce target spec: ${rescueMessage}`, record?.taskId);
            phaseResults.push({ projectName: plan.item.projectName, status: 'blocked', summary: `Specify timed out and native rescue did not produce target spec: ${rescueMessage}`, outputPath: plan.spec.inputs.targetSpecPath, taskId: record?.taskId, reasonLabel: '(native rescue failed, blocked)' });
          }
        }
        if (blockedProjects.length > 0) {
          await maybeRecordFeedback(this.services, {
            rootPath: args.resolution.workspace.rootPath,
            phase: 'PARALLEL_SPECIFY',
            reason: `Specify timed out before producing workspace specs: ${reason}`,
            projectNames: blockedProjects,
          });
          return { requiresFeedback: true, projectResults: phaseResults };
        }
        const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
        const advancedPhase = advancedSnapshot.state?.currentPhase;
        return {
          completed: advancedPhase === 'COMPLETED',
          nextPhase: advancedPhase === 'PARALLEL_PLAN' || advancedPhase === 'PARALLEL_ACE' || advancedPhase === 'PARALLEL_SPECIFY' ? advancedPhase : undefined,
          projectResults: phaseResults,
        };
      }
    }

    const planByName = new Map(plans.map((plan) => [plan.item.projectName, plan] as const));
    for (const plan of plans) {
      if (plan.existingSpecPath) {
        const materializedDuringRun = await this.services.artifactWasMaterializedDuringWorkspaceRun(plan.existingSpecPath, args.snapshot.state?.createdAt);
        const summary = materializedDuringRun ? 'Detected workspace spec already materialized during the current run.' : 'Reused existing workspace spec.';
        await this.services.orchestrator.markSpecifyResult(args.resolution.workspace.rootPath, plan.item.projectName, plan.existingSpecPath, summary, undefined, materializedDuringRun ? 'native' : undefined);
        recordArtifactCompletion(this.services, {
          phase: 'PARALLEL_SPECIFY',
          projectName: plan.item.projectName,
          artifactPath: plan.existingSpecPath,
          summary,
          metadata: { reused: !materializedDuringRun },
        });
        phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary, outputPath: plan.existingSpecPath, reused: !materializedDuringRun, executionMode: materializedDuringRun ? 'native' : undefined });
        continue;
      }
      const phaseTask = resultMap.get(plan.item.projectName);
      if (!phaseTask) continue;
      const nativeSpecPath = (await this.services.resolveWorkspaceSpecArtifact(
        plan.executionTarget?.effectiveProjectPath || plan.item.projectPath,
        this.services.buildWorkspaceSpecTargetPath(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
      )).path;
      if (nativeSpecPath) {
        const summary = phaseTask.summary || 'Skill-delegated workspace subtask produced spec.md.';
        await this.services.orchestrator.markSpecifyResult(args.resolution.workspace.rootPath, plan.item.projectName, nativeSpecPath, summary, phaseTask.taskId, 'native');
        recordArtifactCompletion(this.services, {
          phase: 'PARALLEL_SPECIFY',
          projectName: plan.item.projectName,
          taskId: phaseTask.taskId,
          artifactPath: nativeSpecPath,
          summary,
          metadata: { source: 'delegated-skill' },
        });
        phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary, outputPath: nativeSpecPath, taskId: phaseTask.taskId, executionMode: 'native' });
        continue;
      }
      const rescuePlan = planByName.get(plan.item.projectName);
      let blockedSummary = `Skill-delegated specify task completed without producing a feature spec under .specify/specs/{feature}/spec.md (task status: ${phaseTask.status}).`;
      if (rescuePlan?.spec && this.services.policyEngine.shouldRunNativeArtifactRescue({ phase: 'PARALLEL_SPECIFY', artifactState: 'missing', timedOut: false, delegatedStatus: phaseTask.status })) {
        try {
          const rescueOutcome = await this.services.runNativeWorkspaceArtifactRescue(
            rescuePlan.spec,
            this.services.resolveNativeRescueProvider(phaseProvider),
            args.model,
            `Recovered target spec after delegated specify completed without artifact (task status: ${phaseTask.status}).`,
          );
          const rescuedSpecPath = (await this.services.resolveWorkspaceSpecArtifact(
            plan.executionTarget?.effectiveProjectPath || plan.item.projectPath,
            rescuePlan.spec.inputs.targetSpecPath || this.services.buildWorkspaceSpecTargetPath(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
          )).path;
          if (rescuedSpecPath) {
            await this.services.orchestrator.markSpecifyResult(args.resolution.workspace.rootPath, plan.item.projectName, rescuedSpecPath, rescueOutcome.summary || 'Recovered workspace spec via native artifact rescue.', phaseTask.taskId, 'native');
            recordArtifactCompletion(this.services, {
              phase: 'PARALLEL_SPECIFY',
              projectName: plan.item.projectName,
              taskId: phaseTask.taskId,
              artifactPath: rescuedSpecPath,
              summary: rescueOutcome.summary || 'Recovered workspace spec via native artifact rescue.',
              metadata: { source: 'native-rescue' },
            });
            phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary: rescueOutcome.summary || 'Recovered workspace spec via native artifact rescue.', outputPath: rescuedSpecPath, taskId: phaseTask.taskId, executionMode: 'native' });
            continue;
          }
        } catch (rescueError) {
          const rescueMessage = rescueError instanceof Error ? rescueError.message : String(rescueError);
          blockedSummary = `${blockedSummary} Native rescue also failed: ${rescueMessage}`;
        }
      }
      await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, plan.item.projectName, 'PARALLEL_SPECIFY', blockedSummary, phaseTask.taskId);
      phaseResults.push({ projectName: plan.item.projectName, status: 'blocked', summary: blockedSummary, outputPath: `${plan.executionTarget?.effectiveProjectPath || plan.item.projectPath}/.specify/specs/{feature}/spec.md`, taskId: phaseTask.taskId, executionMode: 'native', reasonLabel: '(missing feature spec, blocked)' });
    }
    const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
    const advancedPhase = advancedSnapshot.state?.currentPhase;
    return {
      completed: advancedPhase === 'COMPLETED',
      requiresFeedback: advancedPhase === 'FEEDBACK_ITERATION',
      nextPhase: advancedPhase === 'PARALLEL_SPECIFY' || advancedPhase === 'PARALLEL_PLAN' || advancedPhase === 'PARALLEL_ACE' ? advancedPhase : undefined,
      projectResults: phaseResults,
    };
  }
}

export class WorkspacePlanPhaseExecutor {
  constructor(private readonly services: WorkspacePhaseExecutorServices) {}

  async run(args: {
    resolution: { workspace: { rootPath: string; workspaceFile: string } };
    snapshot: WorkspaceEngineSnapshot;
    items: WorkspaceEngineProjectItem[];
    provider: string;
    model?: string;
    autoAdvance: boolean;
    reporter: WorkspacePhaseReporter;
  }): Promise<WorkspacePhaseOutcome> {
    const phaseProvider = this.services.resolvePhaseProvider(args.provider, 'PARALLEL_PLAN');
    args.reporter.onKickoff('Parallel Plan');
    this.services.eventStore?.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_PLAN',
      message: 'Plan phase started.',
    });
    const skillRuntime = this.services.skillRuntimeFactory();
    const monitor = this.services.createEventMonitor(phaseProvider);
    const runtime = this.services.createSubtaskRuntime(phaseProvider, args.model, 'single', this.services.createEventForwarder(monitor));
    const supervisor = new (await import('./subtask-supervisor.js')).WorkflowSubtaskSupervisor(runtime);
    const plans: Array<{
      item: WorkspaceEngineProjectItem;
      executionTarget?: WorkspaceResolvedExecutionTarget;
      specPath?: string | null;
      specFeatureDir?: string | null;
      existingPlan?: string;
      reused?: boolean;
      spec?: WorkflowSubtaskSpec;
    }> = [];
    const stateByName = projectStateByName(args.snapshot);
    for (const item of args.items) {
      const projectState = stateByName.get(item.projectName);
      let executionTarget: WorkspaceResolvedExecutionTarget;
      try {
        executionTarget = await ensureExecutionTarget(this.services, {
          workspaceName: path.basename(args.resolution.workspace.workspaceFile, '.code-workspace'),
          workspaceRoot: args.resolution.workspace.rootPath,
          item,
          projectState,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.services.orchestrator.markProjectBlocked(
          args.resolution.workspace.rootPath,
          item.projectName,
          'PARALLEL_PLAN',
          `Unable to prepare execution path: ${message}`,
          projectState?.planTaskId,
        );
        plans.push({ item });
        continue;
      }
      const expectedSpecPath = remapArtifactPathToExecutionRoot(
        projectState?.specPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspaceSpecTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const expectedPlanPath = remapArtifactPathToExecutionRoot(
        projectState?.planPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspacePlanTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const specResolution = await this.services.resolveWorkspaceSpecArtifact(executionTarget.effectiveProjectPath, expectedSpecPath);
      if (specResolution.ambiguous) {
        await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, item.projectName, 'PARALLEL_PLAN', `Multiple feature specs found; unable to choose automatically: ${specResolution.candidates.join(', ')}`, projectState?.planTaskId);
        plans.push({ item, executionTarget });
        continue;
      }
      const specPath = specResolution.path;
      const specFeatureDir = this.services.workspaceFeatureDirForArtifact(specPath);
      const planResolution = await this.services.resolveWorkspacePlanArtifact(executionTarget.effectiveProjectPath, {
        preferredPlanPath: expectedPlanPath,
        preferredFeatureDir: specFeatureDir || this.services.buildWorkspaceFeatureDir(executionTarget.effectiveProjectPath, item.projectName, item.demand),
      });
      if (planResolution.ambiguous) {
        await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, item.projectName, 'PARALLEL_PLAN', `Multiple feature plans found; unable to choose automatically: ${planResolution.candidates.join(', ')}`, projectState?.planTaskId);
        plans.push({ item, executionTarget, specPath, specFeatureDir });
        continue;
      }
      const existingPlan = planResolution.path;
      if (existingPlan && await this.services.isWorkspacePlanValid(existingPlan)) {
        plans.push({ item, executionTarget, specPath, specFeatureDir, existingPlan, reused: true });
        continue;
      }
      const rawSpec = this.services.contextAssembler.buildPlanSubtaskSpec({
        projectName: item.projectName,
        projectPath: executionTarget.effectiveProjectPath,
        sourceProjectPath: executionTarget.sourceProjectPath,
        effectiveProjectPath: executionTarget.effectiveProjectPath,
        demand: item.demand,
        specContent: await this.services.safeReadFile(specPath || ''),
        workspaceRoot: args.resolution.workspace.rootPath,
        workspaceFile: args.resolution.workspace.workspaceFile,
        specPath: specPath || undefined,
        targetPlanPath: expectedPlanPath,
      });
      plans.push({ item, executionTarget, specPath, specFeatureDir, spec: await this.services.materializeWorkflowSkillDelegatedSpec(rawSpec, skillRuntime) });
    }

    const executableSpecs = plans.filter((plan): plan is typeof plan & { spec: WorkflowSubtaskSpec } => Boolean(plan.spec)).map((plan) => plan.spec);
    const prepared = executableSpecs.length > 0 ? supervisor.prepare(executableSpecs) : { handles: [], records: [] };
    const resultMap = new Map<string, WorkflowSubtaskResult>();
    const phaseResults: WorkspacePhaseProjectResult[] = [];
    if (prepared.handles.length > 0) {
      try {
        const executed = await Promise.race([
          supervisor.executePrepared(prepared, async (record: any) => {
            if (record.state === 'running') {
              args.reporter.onRunning(record);
              monitor.onSubtaskRunning(record);
              this.services.eventStore?.record({
                level: 'project',
                kind: 'subtask.started',
                phase: 'PARALLEL_PLAN',
                projectName: record.projectName,
                taskId: record.taskId,
                message: 'Plan delegated subtask started.',
              });
              const existingPlan = plans.find((plan) => plan.item.projectName === record.projectName)?.existingPlan;
              await this.services.orchestrator.markProjectInProgress(args.resolution.workspace.rootPath, record.projectName, 'PARALLEL_PLAN', existingPlan ? 'Delegating sdd-plan skill repair task.' : 'Delegating sdd-plan skill task.', record.taskId);
              return;
            }
            monitor.onSubtaskFinished(record);
            args.reporter.onTerminal(record);
          }),
          new Promise<WorkflowSubtaskResult[]>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Plan phase timed out after ${Math.floor(this.services.policyEngine.getPhaseBudgetMs('PARALLEL_PLAN') / 1000)}s.`)),
              this.services.policyEngine.getPhaseBudgetMs('PARALLEL_PLAN'),
            ).unref();
          }),
        ]);
        for (const result of executed) resultMap.set(result.projectName, result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await supervisor.cancelPrepared(prepared);
        for (const record of prepared.records) monitor.onSubtaskFinished({ taskId: record.taskId });
        await this.services.killWorkspaceTaskProcesses(prepared.records.map((record: any) => record.taskId));
        const blockedProjects: string[] = [];
        for (const plan of plans) {
          if (plan.existingPlan && plan.reused) {
            await this.services.orchestrator.markPlanResult(args.resolution.workspace.rootPath, plan.item.projectName, plan.existingPlan, 'Reused existing valid workspace plan.', undefined);
            recordArtifactCompletion(this.services, {
              phase: 'PARALLEL_PLAN',
              projectName: plan.item.projectName,
              artifactPath: plan.existingPlan,
              summary: 'Reused existing valid workspace plan.',
              metadata: { reused: true },
            });
            phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary: 'Reused existing valid workspace plan.', outputPath: plan.existingPlan, reused: true });
            continue;
          }
          if (!plan.spec) continue;
          const record = prepared.records.find((entry: any) => entry.projectName === plan.item.projectName);
          try {
            const rescueOutcome = await this.services.runNativeWorkspaceArtifactRescue(plan.spec, this.services.resolveNativeRescueProvider(phaseProvider), args.model, `Recovered target plan after delegated plan timeout: ${reason}`);
            const rescuedPlanPath = (await this.services.resolveWorkspacePlanArtifact(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, {
              preferredPlanPath: plan.spec.inputs.targetPlanPath || this.services.buildWorkspacePlanTargetPath(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
              preferredFeatureDir: plan.specFeatureDir || this.services.buildWorkspaceFeatureDir(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
            })).path;
            if (!rescuedPlanPath || !await this.services.isWorkspacePlanValid(rescuedPlanPath)) {
              throw new Error('Native rescue completed without writing a valid target plan artifact.');
            }
            await this.services.orchestrator.markPlanResult(args.resolution.workspace.rootPath, plan.item.projectName, rescuedPlanPath, rescueOutcome.summary || 'Recovered workspace plan via native artifact rescue.', record?.taskId, 'native');
            recordArtifactCompletion(this.services, {
              phase: 'PARALLEL_PLAN',
              projectName: plan.item.projectName,
              taskId: record?.taskId,
              artifactPath: rescuedPlanPath,
              summary: rescueOutcome.summary || 'Recovered workspace plan via native artifact rescue.',
              metadata: { source: 'native-rescue' },
            });
            phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary: rescueOutcome.summary || 'Recovered workspace plan via native artifact rescue.', outputPath: rescuedPlanPath, taskId: record?.taskId, executionMode: 'native' });
          } catch (rescueError) {
            const rescueMessage = rescueError instanceof Error ? rescueError.message : String(rescueError);
            blockedProjects.push(plan.item.projectName);
            await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, plan.item.projectName, 'PARALLEL_PLAN', `Plan timed out and native rescue did not produce a valid target plan: ${rescueMessage}`, record?.taskId);
            phaseResults.push({ projectName: plan.item.projectName, status: 'blocked', summary: `Plan timed out and native rescue did not produce a valid target plan: ${rescueMessage}`, outputPath: plan.spec.inputs.targetPlanPath, taskId: record?.taskId, reasonLabel: '(native rescue failed, blocked)' });
          }
        }
        if (blockedProjects.length > 0) {
          await maybeRecordFeedback(this.services, {
            rootPath: args.resolution.workspace.rootPath,
            phase: 'PARALLEL_PLAN',
            reason: `Plan timed out before producing valid workspace plans: ${reason}`,
            projectNames: blockedProjects,
          });
          return { requiresFeedback: true, projectResults: phaseResults };
        }
        const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
        const advancedPhase = advancedSnapshot.state?.currentPhase;
        return { completed: advancedPhase === 'COMPLETED', nextPhase: advancedPhase === 'PARALLEL_SPECIFY' || advancedPhase === 'PARALLEL_PLAN' || advancedPhase === 'PARALLEL_ACE' ? advancedPhase : undefined, projectResults: phaseResults };
      }
    }

    for (const plan of plans) {
      if (plan.existingPlan && plan.reused) {
        const materializedDuringRun = await this.services.artifactWasMaterializedDuringWorkspaceRun(plan.existingPlan, args.snapshot.state?.createdAt);
        const summary = materializedDuringRun ? 'Detected workspace plan already materialized during the current run.' : 'Reused existing valid workspace plan.';
        await this.services.orchestrator.markPlanResult(args.resolution.workspace.rootPath, plan.item.projectName, plan.existingPlan, summary, undefined, materializedDuringRun ? 'native' : undefined);
        recordArtifactCompletion(this.services, {
          phase: 'PARALLEL_PLAN',
          projectName: plan.item.projectName,
          artifactPath: plan.existingPlan,
          summary,
          metadata: { reused: !materializedDuringRun },
        });
        phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary, outputPath: plan.existingPlan, reused: !materializedDuringRun, executionMode: materializedDuringRun ? 'native' : undefined });
        continue;
      }
      const phaseTask = resultMap.get(plan.item.projectName);
      if (!phaseTask) continue;
      const nativePlanPath = (await this.services.resolveWorkspacePlanArtifact(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, {
        preferredPlanPath: this.services.buildWorkspacePlanTargetPath(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
        preferredFeatureDir: plan.specFeatureDir || this.services.buildWorkspaceFeatureDir(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
      })).path;
      if (nativePlanPath && await this.services.isWorkspacePlanValid(nativePlanPath)) {
        const summary = phaseTask.summary || 'Skill-delegated workspace subtask produced plan.md.';
        await this.services.orchestrator.markPlanResult(args.resolution.workspace.rootPath, plan.item.projectName, nativePlanPath, summary, phaseTask.taskId, 'native');
        recordArtifactCompletion(this.services, {
          phase: 'PARALLEL_PLAN',
          projectName: plan.item.projectName,
          taskId: phaseTask.taskId,
          artifactPath: nativePlanPath,
          summary,
          metadata: { source: 'delegated-skill' },
        });
        phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary, outputPath: nativePlanPath, taskId: phaseTask.taskId, executionMode: 'native' });
        continue;
      }
      let blockedSummary = `Skill-delegated plan task completed without producing a valid feature plan under .specify/specs/{feature}/plan.md (task status: ${phaseTask.status}).`;
      if (plan.spec && this.services.policyEngine.shouldRunNativeArtifactRescue({ phase: 'PARALLEL_PLAN', artifactState: nativePlanPath ? 'invalid' : 'missing', timedOut: false, delegatedStatus: phaseTask.status })) {
        try {
          const rescueOutcome = await this.services.runNativeWorkspaceArtifactRescue(plan.spec, this.services.resolveNativeRescueProvider(phaseProvider), args.model, `Recovered target plan after delegated plan completed without valid artifact (task status: ${phaseTask.status}).`);
          const rescuedPlanPath = (await this.services.resolveWorkspacePlanArtifact(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, {
            preferredPlanPath: plan.spec.inputs.targetPlanPath || this.services.buildWorkspacePlanTargetPath(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
            preferredFeatureDir: plan.specFeatureDir || this.services.buildWorkspaceFeatureDir(plan.executionTarget?.effectiveProjectPath || plan.item.projectPath, plan.item.projectName, plan.item.demand),
          })).path;
          if (rescuedPlanPath && await this.services.isWorkspacePlanValid(rescuedPlanPath)) {
            await this.services.orchestrator.markPlanResult(args.resolution.workspace.rootPath, plan.item.projectName, rescuedPlanPath, rescueOutcome.summary || 'Recovered workspace plan via native artifact rescue.', phaseTask.taskId, 'native');
            recordArtifactCompletion(this.services, {
              phase: 'PARALLEL_PLAN',
              projectName: plan.item.projectName,
              taskId: phaseTask.taskId,
              artifactPath: rescuedPlanPath,
              summary: rescueOutcome.summary || 'Recovered workspace plan via native artifact rescue.',
              metadata: { source: 'native-rescue' },
            });
            phaseResults.push({ projectName: plan.item.projectName, status: 'completed', summary: rescueOutcome.summary || 'Recovered workspace plan via native artifact rescue.', outputPath: rescuedPlanPath, taskId: phaseTask.taskId, executionMode: 'native' });
            continue;
          }
        } catch (rescueError) {
          const rescueMessage = rescueError instanceof Error ? rescueError.message : String(rescueError);
          blockedSummary = `${blockedSummary} Native rescue also failed: ${rescueMessage}`;
        }
      }
      await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, plan.item.projectName, 'PARALLEL_PLAN', blockedSummary, phaseTask.taskId);
      phaseResults.push({ projectName: plan.item.projectName, status: 'blocked', summary: blockedSummary, outputPath: `${plan.executionTarget?.effectiveProjectPath || plan.item.projectPath}/.specify/specs/{feature}/plan.md`, taskId: phaseTask.taskId, executionMode: 'native', reasonLabel: nativePlanPath ? '(template-like, blocked)' : '(missing feature plan, blocked)' });
    }
    const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
    const advancedPhase = advancedSnapshot.state?.currentPhase;
    return { completed: advancedPhase === 'COMPLETED', requiresFeedback: advancedPhase === 'FEEDBACK_ITERATION', nextPhase: advancedPhase === 'PARALLEL_SPECIFY' || advancedPhase === 'PARALLEL_PLAN' || advancedPhase === 'PARALLEL_ACE' ? advancedPhase : undefined, projectResults: phaseResults };
  }
}

export class WorkspaceAcePhaseExecutor {
  constructor(private readonly services: WorkspacePhaseExecutorServices) {}

  async run(args: {
    resolution: { workspace: { rootPath: string; workspaceFile: string } };
    snapshot: WorkspaceEngineSnapshot;
    items: WorkspaceEngineProjectItem[];
    provider: string;
    model?: string;
    autoAdvance: boolean;
    reporter: WorkspacePhaseReporter;
  }): Promise<WorkspacePhaseOutcome> {
    const phaseProvider = this.services.resolvePhaseProvider(args.provider, 'PARALLEL_ACE');
    this.services.eventStore?.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_ACE',
      message: 'ACE phase started.',
    });
    const stateByName = projectStateByName(args.snapshot);
    const executionTargets = new Map<string, WorkspaceResolvedExecutionTarget>();
    const projectsMissingPlan: string[] = [];
    const executionPathBlockedProjects: string[] = [];
    const preflightResults: WorkspacePhaseProjectResult[] = [];
    const preconvergedProjects: Array<{ item: WorkspaceEngineProjectItem; evidence: CompletionEvidence }> = [];
    for (const item of args.items) {
      const projectState = stateByName.get(item.projectName);
      let executionTarget: WorkspaceResolvedExecutionTarget;
      try {
        executionTarget = await ensureExecutionTarget(this.services, {
          workspaceName: path.basename(args.resolution.workspace.workspaceFile, '.code-workspace'),
          workspaceRoot: args.resolution.workspace.rootPath,
          item,
          projectState,
        });
        executionTargets.set(item.projectName, executionTarget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        executionPathBlockedProjects.push(item.projectName);
        await this.services.orchestrator.markProjectBlocked(
          args.resolution.workspace.rootPath,
          item.projectName,
          'PARALLEL_ACE',
          `Unable to prepare execution path: ${message}`,
          projectState?.aceTaskId,
        );
        preflightResults.push({
          projectName: item.projectName,
          status: 'blocked',
          summary: `Unable to prepare execution path: ${message}`,
        });
        continue;
      }
      const expectedSpecPath = remapArtifactPathToExecutionRoot(
        projectState?.specPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspaceSpecTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const expectedPlanPath = remapArtifactPathToExecutionRoot(
        projectState?.planPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspacePlanTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const specResolution = await this.services.resolveWorkspaceSpecArtifact(executionTarget.effectiveProjectPath, expectedSpecPath);
      if (specResolution.ambiguous) {
        projectsMissingPlan.push(item.projectName);
        continue;
      }
      const specPath = specResolution.path;
      const aceSpec = this.services.contextAssembler.buildAceSubtaskSpec({
        projectName: item.projectName,
        projectPath: executionTarget.effectiveProjectPath,
        sourceProjectPath: executionTarget.sourceProjectPath,
        effectiveProjectPath: executionTarget.effectiveProjectPath,
        demand: item.demand,
        specContent: await this.services.safeReadFile(specPath || ''),
        planContent: '',
      });
      const planResolution = await this.services.resolveWorkspacePlanArtifact(executionTarget.effectiveProjectPath, {
        preferredPlanPath: expectedPlanPath,
        preferredFeatureDir: this.services.workspaceFeatureDirForArtifact(specPath) || this.services.buildWorkspaceFeatureDir(executionTarget.effectiveProjectPath, item.projectName, item.demand),
      });
      if (planResolution.ambiguous) {
        projectsMissingPlan.push(item.projectName);
        continue;
      }
      const planPath = planResolution.path;
      if (!planPath || !(await this.services.isWorkspacePlanValid(planPath))) {
        projectsMissingPlan.push(item.projectName);
      }
      const evidence = collectCompletionEvidence(await this.services.captureGitChangedFiles(executionTarget.effectiveProjectPath), aceSpec.inputs.executionContract);
      if (evidence) preconvergedProjects.push({ item, evidence });
    }
    if (executionPathBlockedProjects.length > 0) {
      await maybeRecordFeedback(this.services, {
        rootPath: args.resolution.workspace.rootPath,
        phase: 'PARALLEL_ACE',
        reason: 'One or more projects could not prepare an isolated execution path before ACE execution.',
        projectNames: executionPathBlockedProjects,
      });
      return {
        requiresFeedback: true,
        projectResults: preflightResults,
      };
    }
    if (projectsMissingPlan.length > 0) {
      await maybeRecordFeedback(this.services, {
        rootPath: args.resolution.workspace.rootPath,
        phase: 'PARALLEL_PLAN',
        reason: 'One or more projects are missing a valid plan.md before ACE execution.',
        projectNames: projectsMissingPlan,
      });
      return {
        requiresFeedback: true,
        projectResults: [
          ...preflightResults,
          ...projectsMissingPlan.map((projectName): WorkspacePhaseProjectResult => ({
          projectName,
          status: 'blocked',
          summary: 'One or more projects are missing a valid plan.md before ACE execution.',
          })),
        ],
      };
    }
    if (preconvergedProjects.length === args.items.length) {
      const results: WorkspacePhaseProjectResult[] = [];
      for (const entry of preconvergedProjects) {
        const taskId = generateTaskId();
        await this.services.orchestrator.markProjectInProgress(args.resolution.workspace.rootPath, entry.item.projectName, 'PARALLEL_ACE', 'Detected implementation artifacts matching the ACE execution contract.', taskId, 'native');
        const summary = summarizeCompletionEvidence(entry.evidence);
        await this.services.orchestrator.markAceResult(args.resolution.workspace.rootPath, entry.item.projectName, taskId, 'completed', summary, 'native');
        this.services.eventStore?.record({
          level: 'project',
          kind: 'phase.completed',
          phase: 'PARALLEL_ACE',
          projectName: entry.item.projectName,
          taskId,
          message: summary,
          metadata: { evidence: entry.evidence },
        });
        results.push({ projectName: entry.item.projectName, status: 'completed', summary, taskId, executionMode: 'native' });
      }
      return { completed: true, projectResults: results };
    }

    args.reporter.onKickoff('Parallel ACE');
    const skillRuntime = this.services.skillRuntimeFactory();
    const monitor = this.services.createEventMonitor(phaseProvider);
    let eventsEnabled = true;
    const runtime = this.services.createSubtaskRuntime(phaseProvider, args.model, 'multi', async (event, context) => {
      if (!eventsEnabled) return;
      await this.services.createEventForwarder(monitor)(event, context);
    });
    const supervisor = new (await import('./subtask-supervisor.js')).WorkflowSubtaskSupervisor(runtime);
    const specs: WorkflowSubtaskSpec[] = [];
    for (const item of args.items) {
      const projectState = stateByName.get(item.projectName);
      const executionTarget = executionTargets.get(item.projectName)!;
      const expectedSpecPath = remapArtifactPathToExecutionRoot(
        projectState?.specPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspaceSpecTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const expectedPlanPath = remapArtifactPathToExecutionRoot(
        projectState?.planPath,
        executionTarget.sourceProjectPath,
        executionTarget.effectiveProjectPath,
      ) || this.services.buildWorkspacePlanTargetPath(executionTarget.effectiveProjectPath, item.projectName, item.demand);
      const specPath = (await this.services.resolveWorkspaceSpecArtifact(executionTarget.effectiveProjectPath, expectedSpecPath)).path;
      const planPath = (await this.services.resolveWorkspacePlanArtifact(executionTarget.effectiveProjectPath, {
        preferredPlanPath: expectedPlanPath,
        preferredFeatureDir: this.services.workspaceFeatureDirForArtifact(specPath) || this.services.buildWorkspaceFeatureDir(executionTarget.effectiveProjectPath, item.projectName, item.demand),
      })).path;
      const rawSpec = this.services.contextAssembler.buildAceSubtaskSpec({
        projectName: item.projectName,
        projectPath: executionTarget.effectiveProjectPath,
        sourceProjectPath: executionTarget.sourceProjectPath,
        effectiveProjectPath: executionTarget.effectiveProjectPath,
        demand: item.demand,
        specContent: await this.services.safeReadFile(specPath || ''),
        planContent: await this.services.safeReadFile(planPath || ''),
        workspaceRoot: args.resolution.workspace.rootPath,
        workspaceFile: args.resolution.workspace.workspaceFile,
        specPath: specPath || undefined,
        planPath: planPath || undefined,
      });
      specs.push(await this.services.materializeWorkflowSkillDelegatedSpec(rawSpec, skillRuntime));
    }
    const prepared = supervisor.prepare(specs);
    let executed: WorkflowSubtaskResult[];
    try {
      executed = await Promise.race([
        supervisor.executePrepared(prepared, async (record: any) => {
          if (!eventsEnabled) return;
          if (record.state === 'running') {
            args.reporter.onRunning(record);
            monitor.onSubtaskRunning(record);
            this.services.eventStore?.record({
              level: 'project',
              kind: 'subtask.started',
              phase: 'PARALLEL_ACE',
              projectName: record.projectName,
              taskId: record.taskId,
              message: 'ACE delegated subtask started.',
            });
            await this.services.orchestrator.markProjectInProgress(args.resolution.workspace.rootPath, record.projectName, 'PARALLEL_ACE', 'Running project-level ACE task.', record.taskId);
            return;
          }
          monitor.onSubtaskFinished(record);
          args.reporter.onTerminal(record);
        }),
        new Promise<WorkflowSubtaskResult[]>((_, reject) => {
          setTimeout(
            () => reject(new Error(`ACE phase timed out after ${Math.floor(this.services.policyEngine.getPhaseBudgetMs('PARALLEL_ACE') / 1000)}s.`)),
            this.services.policyEngine.getPhaseBudgetMs('PARALLEL_ACE'),
          ).unref();
        }),
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      eventsEnabled = false;
      await supervisor.cancelPrepared(prepared);
      for (const record of prepared.records) monitor.onSubtaskFinished({ taskId: record.taskId });
      await this.services.killWorkspaceTaskProcesses(prepared.records.map((record: any) => record.taskId));
      const blockedProjects: string[] = [];
      const phaseResults: WorkspacePhaseProjectResult[] = [];
      for (const item of args.items) {
        const record = prepared.records.find((entry: any) => entry.projectName === item.projectName);
        const executionTarget = executionTargets.get(item.projectName);
        const aceSpec = this.services.contextAssembler.buildAceSubtaskSpec({
          projectName: item.projectName,
          projectPath: executionTarget?.effectiveProjectPath || item.projectPath,
          sourceProjectPath: executionTarget?.sourceProjectPath || item.projectPath,
          effectiveProjectPath: executionTarget?.effectiveProjectPath || item.projectPath,
          demand: item.demand,
          specContent: '',
          planContent: '',
        });
        const evidence = collectCompletionEvidence(await this.services.captureGitChangedFiles(executionTarget?.effectiveProjectPath || item.projectPath), aceSpec.inputs.executionContract);
        if (this.services.policyEngine.shouldPromoteAceTimeoutToCompleted(evidence)) {
          const summary = summarizeCompletionEvidence(evidence!);
          const taskId = record?.taskId || generateTaskId();
          await this.services.orchestrator.markProjectInProgress(args.resolution.workspace.rootPath, item.projectName, 'PARALLEL_ACE', 'Detected implementation artifacts matching the ACE execution contract after timeout.', taskId, 'native');
          await this.services.orchestrator.markAceResult(args.resolution.workspace.rootPath, item.projectName, taskId, 'completed', summary, 'native');
          this.services.eventStore?.record({
            level: 'project',
            kind: 'phase.recovered',
            phase: 'PARALLEL_ACE',
            projectName: item.projectName,
            taskId,
            message: summary,
            metadata: { evidence },
          });
          phaseResults.push({ projectName: item.projectName, status: 'completed', summary, taskId, executionMode: 'native' });
          continue;
        }
        blockedProjects.push(item.projectName);
        await this.services.orchestrator.markProjectBlocked(args.resolution.workspace.rootPath, item.projectName, 'PARALLEL_ACE', `ACE timed out: ${reason}`, record?.taskId);
        phaseResults.push({ projectName: item.projectName, status: 'blocked', summary: `ACE timed out: ${reason}`, taskId: record?.taskId });
      }
      if (blockedProjects.length > 0) {
        await maybeRecordFeedback(this.services, {
          rootPath: args.resolution.workspace.rootPath,
          phase: 'PARALLEL_ACE',
          reason: `ACE timed out before convergence: ${reason}`,
          projectNames: blockedProjects,
        });
        return { requiresFeedback: true, projectResults: phaseResults };
      }
      const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
      return { completed: advancedSnapshot.state?.currentPhase === 'COMPLETED', projectResults: phaseResults };
    }

    const resultMap = new Map(executed.map((result) => [result.projectName, result]));
    const failedProjects: string[] = [];
    const phaseResults: WorkspacePhaseProjectResult[] = [];
    for (const item of args.items) {
      const result = resultMap.get(item.projectName);
      if (!result) continue;
      const mappedStatus = result.status === 'failed' ? 'failed' : result.status === 'cancelled' ? 'blocked' : 'completed';
      await this.services.orchestrator.markAceResult(args.resolution.workspace.rootPath, item.projectName, result.taskId, mappedStatus, result.summary, mappedStatus === 'completed' ? 'native' : undefined);
      if (mappedStatus === 'failed' || mappedStatus === 'blocked') failedProjects.push(item.projectName);
      this.services.eventStore?.record({
        level: 'project',
        kind: mappedStatus === 'completed' ? 'phase.completed' : 'phase.blocked',
        phase: 'PARALLEL_ACE',
        projectName: item.projectName,
        taskId: result.taskId,
        message: result.summary,
      });
      phaseResults.push({ projectName: item.projectName, status: mappedStatus === 'completed' ? 'completed' : 'blocked', summary: result.summary, taskId: result.taskId, executionMode: 'native' });
    }
    if (failedProjects.length > 0) {
      await maybeRecordFeedback(this.services, {
        rootPath: args.resolution.workspace.rootPath,
        phase: 'PARALLEL_ACE',
        reason: 'One or more project ACE tasks did not converge. Review blockers and decide whether to rerun ACE or replan.',
        projectNames: failedProjects,
      });
    }
    const advancedSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
    const advancedPhase = advancedSnapshot.state?.currentPhase;
    return { completed: advancedPhase === 'COMPLETED', requiresFeedback: advancedPhase === 'FEEDBACK_ITERATION', nextPhase: advancedPhase === 'PARALLEL_SPECIFY' || advancedPhase === 'PARALLEL_PLAN' || advancedPhase === 'PARALLEL_ACE' ? advancedPhase : undefined, projectResults: phaseResults };
  }
}
