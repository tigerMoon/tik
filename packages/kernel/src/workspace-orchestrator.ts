import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  WorkspaceDecisionRequest,
  WorkspaceDecisionResolution,
  Workspace,
  WorkspaceProject,
  WorkspaceProjectWorktreeState,
  WorkspaceResolution,
  WorkspaceSettings,
  WorkspaceWorktreePolicyConfig,
  WorkspaceWorkflowPolicyConfig,
  WorkspaceSplitDemands,
  WorkspaceDemandSplitItem,
  WorkspaceState,
  WorkspacePhase,
  WorkflowSkillName,
  WorkflowSubtaskContract,
} from '@tik/shared';
import { generateId } from '@tik/shared';
import { buildWorkspaceEventProjection } from './workspace-event-projection.js';
import { WorkspaceEventStore } from './workspace-event-store.js';
import { WorkspaceMemoryStore } from './workspace-memory.js';
import type { WorkspaceDecisionSynthesisInput } from './workspace-decision-synthesizer.js';
import { getWorkflowSkillRouteByPhase } from './workflow-skill-routes.js';
import { synthesizeWorkspaceDecision } from './workspace-decision-synthesizer.js';
import { resolveWorkspaceWorkflowPolicy } from './workspace-policy-engine.js';

type WorkspaceProjectState = NonNullable<WorkspaceState['projects']>[number] & {
  clarifyTaskId?: string;
  specTaskId?: string;
  planTaskId?: string;
  aceTaskId?: string;
  executionMode?: 'native' | 'fallback';
  workflowContract?: WorkflowSubtaskContract;
  workflowSkillName?: WorkflowSkillName;
  workflowSkillPath?: string;
  blockerKind?: 'NEED_HUMAN' | 'REPLAN' | 'EXECUTION_FAILED';
  recommendedCommand?: string;
};
type LocalWorkspaceState = Omit<WorkspaceState, 'workspaceFeedback' | 'summary'> & {
  workspaceFeedback?: {
    required: boolean;
    reason?: string;
    affectedProjects?: string[];
    nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
    updatedAt: string;
  };
  summary?: {
    totalProjects: number;
    completedProjects: number;
    blockedProjects: number;
    failedProjects: number;
    clarifiedProjects?: number;
    pendingClarificationProjects?: number;
    needsHumanProjects: number;
    replanProjects: number;
    updatedAt: string;
  };
};

interface ResolveWorkspaceDecisionInput {
  decisionId: string;
  optionId?: string;
  message?: string;
}

interface BootstrapWorkspaceInput {
  resolution: WorkspaceResolution;
  demand: string;
  workflowPolicy?: WorkspaceWorkflowPolicyConfig;
}

interface WorkspaceStatusSnapshot {
  settings: WorkspaceSettings | null;
  state: LocalWorkspaceState | null;
  splitDemands: WorkspaceSplitDemands | null;
}

export class WorkspaceOrchestrator {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();
  private readonly lockTimeoutMs = 15_000;
  private readonly staleLockMs = 120_000;

  async bootstrap(input: BootstrapWorkspaceInput): Promise<WorkspaceStatusSnapshot> {
    const { resolution, demand, workflowPolicy } = input;
    if (!resolution.workspace) {
      throw new Error('Workspace orchestration requires a .code-workspace root.');
    }

    const workspaceDir = this.getWorkspaceDir(resolution.workspace.rootPath);
    await fs.mkdir(workspaceDir, { recursive: true });
    return this.withWorkspaceMutation(resolution.workspace.rootPath, async () => {
      const settings = this.buildSettings(resolution.workspace!, workflowPolicy);
      const splitDemands = this.buildSplitDemands(resolution, demand);
      const state = this.buildState(demand, splitDemands.items);

      await this.writeJson(path.join(workspaceDir, 'settings.json'), settings);
      await this.writeJson(path.join(workspaceDir, 'split-demands.json'), splitDemands);
      await this.writeJson(path.join(workspaceDir, 'state.json'), state);

      return { settings, state, splitDemands };
    });
  }

  async getStatus(rootPath: string): Promise<WorkspaceStatusSnapshot> {
    const workspaceDir = this.getWorkspaceDir(rootPath);
    const [settings, state, splitDemands] = await Promise.all([
      this.readJson<WorkspaceSettings>(path.join(workspaceDir, 'settings.json')),
      this.readJson<LocalWorkspaceState>(path.join(workspaceDir, 'state.json')),
      this.readJson<WorkspaceSplitDemands>(path.join(workspaceDir, 'split-demands.json')),
    ]);

    return { settings, state, splitDemands };
  }

  async markSpecifyResult(
    rootPath: string,
    projectName: string,
    specPath: string,
    summary: string,
    specTaskId?: string,
    executionMode?: 'native' | 'fallback',
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
      phase: 'PARALLEL_SPECIFY',
      status: 'completed',
      specPath,
      specTaskId,
      executionMode,
      summary,
    }));
  }

  async markClarifyResult(
    rootPath: string,
    projectName: string,
    clarificationPath: string,
    summary: string,
    clarifyTaskId?: string,
    clarificationStatus: WorkspaceProjectState['clarificationStatus'] = 'generated',
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
      phase: 'PARALLEL_CLARIFY',
      status: 'completed',
      clarificationPath,
      clarifyTaskId,
      clarificationStatus,
      summary,
    }));
  }

  async markClarifyBlocked(
    rootPath: string,
    projectName: string,
    clarificationPath: string,
    summary: string,
    clarifyTaskId?: string,
    clarificationStatus: WorkspaceProjectState['clarificationStatus'] = 'awaiting_decision',
    decision?: WorkspaceDecisionRequest,
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(
      rootPath,
      projectName,
      {
        phase: 'PARALLEL_CLARIFY',
        status: 'blocked',
        clarificationPath,
        clarifyTaskId,
        clarificationStatus,
        summary,
      },
      { decision },
    ));
  }

  async markPlanResult(
    rootPath: string,
    projectName: string,
    planPath: string,
    summary: string,
    planTaskId?: string,
    executionMode?: 'native' | 'fallback',
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
      phase: 'PARALLEL_PLAN',
      status: 'completed',
      planPath,
      planTaskId,
      executionMode,
      summary,
    }));
  }

  async markAceResult(
    rootPath: string,
    projectName: string,
    taskId: string,
    status: WorkspaceProjectState['status'],
    summary: string,
    executionMode?: 'native' | 'fallback',
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
      phase: 'PARALLEL_ACE',
      status,
      taskId,
      aceTaskId: taskId,
      executionMode,
      summary,
    }));
  }

  async markProjectInProgress(
    rootPath: string,
    projectName: string,
    phase: WorkspacePhase,
    summary?: string,
    taskId?: string,
    executionMode?: 'native' | 'fallback',
  ): Promise<WorkspaceStatusSnapshot> {
    const phaseTaskPatch = phase === 'PARALLEL_CLARIFY'
      ? { clarifyTaskId: taskId, taskId }
      : phase === 'PARALLEL_SPECIFY'
      ? { specTaskId: taskId, taskId }
      : phase === 'PARALLEL_PLAN'
        ? { planTaskId: taskId, taskId }
        : phase === 'PARALLEL_ACE'
          ? { aceTaskId: taskId, taskId }
          : taskId
            ? { taskId }
            : {};
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
      phase,
      status: 'in_progress',
      summary,
      executionMode,
      ...phaseTaskPatch,
    }));
  }

  async markProjectBlocked(
    rootPath: string,
    projectName: string,
    phase: WorkspacePhase,
    summary: string,
    taskId?: string,
  ): Promise<WorkspaceStatusSnapshot> {
    const phaseTaskPatch = phase === 'PARALLEL_CLARIFY'
      ? { clarifyTaskId: taskId, taskId }
      : phase === 'PARALLEL_SPECIFY'
      ? { specTaskId: taskId, taskId }
      : phase === 'PARALLEL_PLAN'
        ? { planTaskId: taskId, taskId }
        : phase === 'PARALLEL_ACE'
          ? { aceTaskId: taskId, taskId }
          : taskId
            ? { taskId }
            : {};
    return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
      phase,
      status: 'blocked',
      summary,
      ...phaseTaskPatch,
    }));
  }

  async markProjectWorktreeReady(
    rootPath: string,
    projectName: string,
    input: {
      effectiveProjectPath: string;
      worktree: WorkspaceProjectWorktreeState;
    },
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }
      const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
      if (!project) {
        throw new Error(`Workspace project not found: ${projectName}`);
      }
      return this.updateProjectState(rootPath, projectName, {
        worktreeLanes: this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree),
      });
    });
  }

  async markProjectWorktreeFailed(
    rootPath: string,
    projectName: string,
    input: {
      effectiveProjectPath?: string;
      worktree: WorkspaceProjectWorktreeState;
      summary: string;
    },
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }
      const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
      if (!project) {
        throw new Error(`Workspace project not found: ${projectName}`);
      }
      return this.updateProjectState(rootPath, projectName, {
        worktreeLanes: this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree),
        summary: input.summary,
      });
    });
  }

  async markProjectWorktreeRemoved(
    rootPath: string,
    projectName: string,
    input: {
      sourceProjectPath: string;
      worktree: WorkspaceProjectWorktreeState;
    },
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }
      const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
      if (!project) {
        throw new Error(`Workspace project not found: ${projectName}`);
      }
      const worktreeLanes = this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree);
      const removingActiveLane = normalizeLaneId(project.worktree?.laneId) === normalizeLaneId(input.worktree.laneId);
      return this.updateProjectState(rootPath, projectName, {
        effectiveProjectPath: removingActiveLane ? input.sourceProjectPath : project.effectiveProjectPath,
        worktree: removingActiveLane ? undefined : project.worktree,
        worktreeLanes,
      });
    });
  }

  async activateProjectWorktreeLane(
    rootPath: string,
    projectName: string,
    input: {
      effectiveProjectPath: string;
      worktree: WorkspaceProjectWorktreeState;
    },
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }
      const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
      if (!project) {
        throw new Error(`Workspace project not found: ${projectName}`);
      }
      return this.updateProjectState(rootPath, projectName, {
        effectiveProjectPath: input.effectiveProjectPath,
        worktree: input.worktree,
        worktreeLanes: this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree),
      });
    });
  }

  async recordFeedback(
    rootPath: string,
    reason: string,
    affectedProjects: string[],
    nextPhase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE' = 'PARALLEL_PLAN',
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }
      const now = new Date().toISOString();
      const nextState: LocalWorkspaceState = {
        ...snapshot.state,
        currentPhase: 'FEEDBACK_ITERATION',
        updatedAt: now,
        workspaceFeedback: {
          required: true,
          reason,
          affectedProjects,
          nextPhase,
          updatedAt: now,
        },
        decisions: this.resolvePendingDecisions(
          snapshot.state.decisions || [],
          affectedProjects,
          {
            status: 'resolved',
            message: reason,
            nextPhase,
            resolvedAt: now,
          },
        ),
        notes: [
          ...(snapshot.state.notes || []),
          `Workspace feedback recorded: ${reason}`,
        ],
        summary: this.computeSummary(snapshot.state.projects || [], now),
      };
      await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
      return {
        ...snapshot,
        state: nextState,
      };
    });
  }

  async clearFeedback(
    rootPath: string,
    nextPhase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE',
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }
      const now = new Date().toISOString();
      const nextState: LocalWorkspaceState = {
        ...snapshot.state,
        currentPhase: nextPhase,
        updatedAt: now,
        workspaceFeedback: {
          required: false,
          affectedProjects: [],
          updatedAt: now,
        },
        decisions: this.dismissStalePendingDecisions(snapshot.state.decisions || [], now),
        summary: this.computeSummary(snapshot.state.projects || [], now),
      };
      await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
      return {
        ...snapshot,
        state: nextState,
      };
    });
  }

  async resolveDecision(
    rootPath: string,
    input: ResolveWorkspaceDecisionInput,
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.state) {
        throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
      }

      const decisions = snapshot.state.decisions || [];
      const decision = decisions.find((item) => item.id === input.decisionId);
      if (!decision) {
        throw new Error(`Workspace decision not found: ${input.decisionId}`);
      }
      if (decision.status !== 'pending') {
        throw new Error(`Workspace decision is not pending: ${input.decisionId}`);
      }

      const option = input.optionId
        ? decision.options?.find((item) => item.id === input.optionId)
        : undefined;
      if (input.optionId && !option) {
        throw new Error(`Workspace decision option not found: ${input.optionId}`);
      }

      const now = new Date().toISOString();
      const nextPhase = option?.nextPhase || decision.phase;
      const affectedProjects = Array.from(new Set([
        ...(snapshot.state.workspaceFeedback?.affectedProjects || []),
        ...(decision.projectName ? [decision.projectName] : []),
      ]));
      const nextProjects = (snapshot.state.projects || []).map((project) => {
        if (decision.projectName && project.projectName !== decision.projectName) return project;
        return {
          ...project,
          ...(option?.artifactField && option.artifactPath
            ? { [option.artifactField]: option.artifactPath }
            : {}),
          clarificationStatus: decision.phase === 'PARALLEL_CLARIFY'
            ? 'resolved'
            : project.clarificationStatus,
          blockerKind: undefined,
          recommendedCommand: 'tik workspace next',
          updatedAt: now,
        };
      });

      const resolution: WorkspaceDecisionResolution = {
        status: 'resolved',
        optionId: option?.id,
        message: input.message,
        nextPhase,
        resolvedAt: now,
      };
      const feedbackReason = [
        `Decision resolved: ${decision.title}`,
        option ? `choice=${option.label}` : '',
        input.message ? `message=${input.message}` : '',
      ].filter(Boolean).join(' | ');

      const nextState: LocalWorkspaceState = {
        ...snapshot.state,
        currentPhase: 'FEEDBACK_ITERATION',
        updatedAt: now,
        projects: nextProjects,
        workspaceFeedback: {
          required: true,
          reason: feedbackReason,
          affectedProjects,
          nextPhase,
          updatedAt: now,
        },
        decisions: decisions.map((item) => item.id === decision.id
          ? {
            ...item,
            status: 'resolved',
            updatedAt: now,
            resolution,
          }
          : item),
        notes: [
          ...(snapshot.state.notes || []),
          feedbackReason,
        ],
        summary: this.computeSummary(nextProjects, now),
      };

      await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
      return {
        ...snapshot,
        state: nextState,
      };
    });
  }

  async updateWorkflowPolicy(
    rootPath: string,
    workflowPolicy: WorkspaceWorkflowPolicyConfig,
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.settings) {
        throw new Error('Workspace settings not initialized. Run workspace bootstrap first.');
      }
      const now = new Date().toISOString();
      const effectivePolicy = workflowPolicy.profile
        ? workflowPolicy
        : {
          ...(snapshot.settings.workflowPolicy || this.defaultWorkflowPolicy()),
          ...workflowPolicy,
        };
      const nextSettings: WorkspaceSettings = {
        ...snapshot.settings,
        updatedAt: now,
        workflowPolicy: resolveWorkspaceWorkflowPolicy(effectivePolicy),
      };
      await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'settings.json'), nextSettings);
      return {
        ...snapshot,
        settings: nextSettings,
      };
    });
  }

  async updateWorktreePolicy(
    rootPath: string,
    worktreePolicy: WorkspaceWorktreePolicyConfig,
  ): Promise<WorkspaceStatusSnapshot> {
    return this.withWorkspaceMutation(rootPath, async () => {
      const snapshot = await this.getStatus(rootPath);
      if (!snapshot.settings) {
        throw new Error('Workspace settings not initialized. Run workspace bootstrap first.');
      }
      const now = new Date().toISOString();
      const nextSettings: WorkspaceSettings = {
        ...snapshot.settings,
        updatedAt: now,
        worktreePolicy: {
          ...(snapshot.settings.worktreePolicy || this.defaultWorktreePolicy(rootPath)),
          ...worktreePolicy,
        },
      };
      await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'settings.json'), nextSettings);
      return {
        ...snapshot,
        settings: nextSettings,
      };
    });
  }

  private async withWorkspaceMutation<T>(rootPath: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(rootPath) || Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.withWorkspaceFileLock(rootPath, fn));
    this.mutationQueues.set(rootPath, run);
    try {
      return await run;
    } finally {
      if (this.mutationQueues.get(rootPath) === run) {
        this.mutationQueues.delete(rootPath);
      }
    }
  }

  private getWorkspaceDir(rootPath: string): string {
    return path.join(rootPath, '.workspace');
  }

  private getWorkspaceLockPath(rootPath: string): string {
    return path.join(this.getWorkspaceDir(rootPath), '.state.lock');
  }

  private buildSettings(workspace: Workspace, workflowPolicy?: WorkspaceWorkflowPolicyConfig): WorkspaceSettings {
    const now = new Date().toISOString();
    const effectivePolicy = workflowPolicy?.profile
      ? workflowPolicy
      : {
        ...this.defaultWorkflowPolicy(),
        ...(workflowPolicy || {}),
      };
    return {
      workspaceName: workspace.name,
      workspaceRoot: workspace.rootPath,
      workspaceFile: workspace.workspaceFile,
      createdAt: now,
      updatedAt: now,
      projects: workspace.projects,
      workflowPolicy: resolveWorkspaceWorkflowPolicy(effectivePolicy),
      worktreePolicy: this.defaultWorktreePolicy(workspace.rootPath),
    };
  }

  private defaultWorkflowPolicy(): WorkspaceWorkflowPolicyConfig {
    return {
      profile: 'balanced',
      phaseBudgetsMs: {
        PARALLEL_CLARIFY: 120_000,
        PARALLEL_SPECIFY: 300_000,
        PARALLEL_PLAN: 300_000,
        PARALLEL_ACE: 600_000,
      },
      maxFeedbackRetriesPerPhase: {
        PARALLEL_CLARIFY: 1,
        PARALLEL_SPECIFY: 1,
        PARALLEL_PLAN: 1,
        PARALLEL_ACE: 2,
      },
      enableNativeArtifactRescue: true,
      enableAceEvidencePromotion: true,
    };
  }

  private defaultWorktreePolicy(rootPath: string): WorkspaceWorktreePolicyConfig {
    return {
      mode: 'managed',
      defaultBranchStrategy: 'auto-create',
      defaultRetention: 'retain',
      nonGitStrategy: 'source',
      worktreeRoot: path.join(rootPath, '.workspace', 'worktrees'),
    };
  }

  private buildSplitDemands(resolution: WorkspaceResolution, demand: string): WorkspaceSplitDemands {
    const workspace = resolution.workspace!;
    const selected = this.selectProjects(workspace.projects, demand, resolution.projectPath);
    const createdAt = new Date().toISOString();
    return {
      demand,
      createdAt,
      items: selected.map((selection) => ({
        projectName: selection.project.name,
        projectPath: selection.project.path,
        demand,
        reason: selection.reason,
        status: 'pending',
      })),
    };
  }

  private buildState(demand: string, items: WorkspaceDemandSplitItem[]): LocalWorkspaceState {
    const now = new Date().toISOString();
    return {
      currentPhase: 'PARALLEL_CLARIFY',
      demand,
      activeProjectNames: items.map((item) => item.projectName),
      createdAt: now,
      updatedAt: now,
      projects: items.map((item) => ({
        projectName: item.projectName,
        projectPath: item.projectPath,
        sourceProjectPath: item.projectPath,
        effectiveProjectPath: item.projectPath,
        worktreeLanes: [],
        phase: 'PARALLEL_CLARIFY',
        status: 'pending',
        clarificationStatus: 'skipped',
        updatedAt: now,
      })),
      decisions: [],
      workspaceFeedback: {
        required: false,
        affectedProjects: [],
        updatedAt: now,
      },
      summary: this.computeSummary(items.map((item) => ({
        projectName: item.projectName,
        projectPath: item.projectPath,
        sourceProjectPath: item.projectPath,
        effectiveProjectPath: item.projectPath,
        worktreeLanes: [],
        phase: 'PARALLEL_CLARIFY',
        status: 'pending',
        clarificationStatus: 'skipped',
        updatedAt: now,
      })), now),
      notes: [
        'Phase 0 initialized by Tik Workspace Orchestrator MVP.',
        'Next step: run project-level clarification gating before specification.',
      ],
    };
  }

  private selectProjects(
    projects: WorkspaceProject[],
    demand: string,
    activeProjectPath: string,
  ): Array<{ project: WorkspaceProject; reason: string }> {
    const loweredDemand = demand.toLowerCase();
    const analyses = projects.map((project) => this.analyzeProjectMention(project, loweredDemand));
    const directMatches = analyses
      .filter((analysis) => analysis.directScore > 0)
      .sort((left, right) => right.directScore - left.directScore || right.mentionCount - left.mentionCount);

    if (directMatches.length > 0) {
      const topScore = directMatches[0]!.directScore;
      const selected = directMatches.filter((analysis) => analysis.directScore === topScore);
      return selected.map((analysis) => ({
        project: analysis.project,
        reason: analysis.reason,
      }));
    }

    const explicitMatches = analyses.filter((analysis) => analysis.mentionCount > 0);
    if (explicitMatches.length === 1) {
      const match = explicitMatches[0]!;
      return [{
        project: match.project,
        reason: match.reason,
      }];
    }

    if (explicitMatches.length > 1) {
      const activeExplicitMatch = explicitMatches.find((analysis) => (
        analysis.project.path === activeProjectPath || activeProjectPath.startsWith(analysis.project.path)
      ));
      if (activeExplicitMatch) {
        return [{
          project: activeExplicitMatch.project,
          reason: `Multiple project tokens matched, but only ${activeExplicitMatch.project.name} is the active project; defaulted conservatively to the active project.`,
        }];
      }
    }

    const activeProject = projects.find((project) => project.path === activeProjectPath)
      || projects.find((project) => activeProjectPath.startsWith(project.path))
      || projects[0];

    if (!activeProject) {
      return [];
    }

    return [{
      project: activeProject,
      reason: `No explicit project token matched; defaulted to active project ${activeProject.name}`,
    }];
  }

  private analyzeProjectMention(
    project: WorkspaceProject,
    loweredDemand: string,
  ): { project: WorkspaceProject; mentionCount: number; directScore: number; reason: string } {
    const tokens = Array.from(new Set([project.name, path.basename(project.path)]
      .map((value) => value.toLowerCase())
      .filter(Boolean)));

    let mentionCount = 0;
    let directScore = 0;
    let supportScore = 0;

    for (const token of tokens) {
      if (!loweredDemand.includes(token)) continue;
      mentionCount += 1;

      const escaped = escapeRegExp(token);
      if (new RegExp(`(?:给|在|对|替换|修改|移除|删除|重构|新增|增加|改造|迁移|实现|收敛|治理|推进|修复|调整)\\s*${escaped}`, 'iu').test(loweredDemand)) {
        directScore += 3;
      }
      if (new RegExp(`${escaped}(?:项目|仓库|模块)?[^\\n，。,；;]{0,12}(?:需要|需|进行|做|改|修改|替换|移除|删除|重构|新增|增加|改造|迁移|实现|收敛|治理|推进|修复|调整)`, 'iu').test(loweredDemand)) {
        directScore += 2;
      }
      if (new RegExp(`(?:为|通过|调用|依赖|接入|使用|同步|对接)\\s*${escaped}[^\\n，。,；;]{0,12}(?:接口|服务|rpc|feign|契约|能力|数据源)`, 'iu').test(loweredDemand)) {
        supportScore += 2;
      }
      if (new RegExp(`${escaped}[^\\n，。,；;]{0,12}(?:接口|服务|rpc|feign|契约|能力|数据源|外部接口)`, 'iu').test(loweredDemand)) {
        supportScore += 1;
      }
    }

    const effectiveDirectScore = Math.max(0, directScore - supportScore);
    const reason = effectiveDirectScore > 0
      ? `Matched project ownership cues in demand: ${project.name}`
      : mentionCount > 0
        ? `Mentioned in demand but only as a dependency/reference: ${project.name}`
        : `No explicit project token matched: ${project.name}`;

    return {
      project,
      mentionCount,
      directScore: effectiveDirectScore,
      reason,
    };
  }

  private async writeJson(filePath: string, payload: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async updateProjectState(
    rootPath: string,
    projectName: string,
    patch: Partial<WorkspaceProjectState>,
    options?: {
      decision?: WorkspaceDecisionRequest;
    },
  ): Promise<WorkspaceStatusSnapshot> {
    const snapshot = await this.getStatus(rootPath);
    if (!snapshot.state) {
      throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
    }

    const now = new Date().toISOString();
    const projects = snapshot.state.projects || [];
    const nextProjects = projects.map((project) => {
      if (project.projectName !== projectName) return project;
      const nextProject = {
        ...project,
        ...patch,
        updatedAt: now,
      };
      return {
        ...nextProject,
        ...this.deriveProjectControlPlane(nextProject),
      };
    });

    const nextPhase = this.computeCurrentPhase(nextProjects, snapshot.state.currentPhase);
    const nextNotes = this.computeNotes(nextPhase, snapshot.state.notes || []);

    const nextState: LocalWorkspaceState = {
      ...snapshot.state,
      currentPhase: nextPhase,
      updatedAt: now,
      projects: nextProjects,
      notes: nextNotes,
      summary: this.computeSummary(nextProjects, now),
    };

    const blockedOrFailedProjects = nextProjects.filter(
      (project) => project.status === 'blocked' || project.status === 'failed',
    );
    if (nextPhase === 'FEEDBACK_ITERATION' && blockedOrFailedProjects.length > 0) {
      const seededDecisions = options?.decision
        ? this.upsertDecisionRequest(snapshot.state.decisions || [], options.decision)
        : (snapshot.state.decisions || []);
      const failedPhase = patch.phase ?? blockedOrFailedProjects[0]?.phase ?? snapshot.state.currentPhase;
      nextState.workspaceFeedback = {
        required: true,
        reason: patch.summary || blockedOrFailedProjects[0]?.summary || 'Workspace phase requires feedback.',
        affectedProjects: blockedOrFailedProjects.map((project) => project.projectName),
        nextPhase: failedPhase === 'PARALLEL_ACE'
          ? 'PARALLEL_ACE'
          : failedPhase === 'PARALLEL_CLARIFY'
            ? 'PARALLEL_CLARIFY'
          : failedPhase === 'PARALLEL_PLAN'
            ? 'PARALLEL_PLAN'
            : 'PARALLEL_SPECIFY',
        updatedAt: now,
      };
      nextState.decisions = await this.reconcileDecisionRequests(
        rootPath,
        snapshot,
        seededDecisions,
        blockedOrFailedProjects,
        now,
      );
    } else if (snapshot.state.workspaceFeedback?.required) {
      nextState.workspaceFeedback = {
        required: false,
        affectedProjects: [],
        updatedAt: now,
      };
      nextState.decisions = this.dismissStalePendingDecisions(snapshot.state.decisions || [], now);
    } else {
      nextState.decisions = this.dismissResolvedProjectDecisions(
        snapshot.state.decisions || [],
        nextProjects,
        now,
      );
    }

    const nextSplitDemands = snapshot.splitDemands
      ? {
          ...snapshot.splitDemands,
          items: snapshot.splitDemands.items.map((item) => {
            if (item.projectName !== projectName) return item;
            return {
              ...item,
              status: patch.status === 'completed'
                ? 'completed'
                : patch.status === 'in_progress'
                  ? 'in_progress'
                  : patch.status === 'blocked'
                    ? 'blocked'
                    : patch.status === 'failed'
                      ? 'blocked'
                    : item.status,
            };
          }),
        }
      : null;

    await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
    if (nextSplitDemands) {
      await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'split-demands.json'), nextSplitDemands);
    }
    return {
      ...snapshot,
      state: nextState,
      splitDemands: nextSplitDemands,
    };
  }

  private computeCurrentPhase(
    projects: WorkspaceProjectState[],
    currentPhase: WorkspacePhase,
  ): WorkspacePhase {
    if (projects.length === 0) return currentPhase;
    if (projects.some((project) => project.status === 'blocked')) {
      return 'FEEDBACK_ITERATION';
    }
    if (projects.some((project) => project.status === 'failed')) {
      return 'FEEDBACK_ITERATION';
    }
    if (projects.every((project) => project.phase === 'PARALLEL_ACE' && project.status === 'completed')) {
      return 'COMPLETED';
    }
    if (projects.every((project) => project.phase === 'PARALLEL_PLAN' && project.status === 'completed')) {
      return 'PARALLEL_ACE';
    }
    if (projects.every((project) => project.phase === 'PARALLEL_SPECIFY' && project.status === 'completed')) {
      return 'PARALLEL_PLAN';
    }
    if (projects.every((project) => project.phase === 'PARALLEL_CLARIFY' && project.status === 'completed')) {
      return 'PARALLEL_SPECIFY';
    }
    return currentPhase;
  }

  private computeNotes(nextPhase: WorkspacePhase, notes: string[]): string[] {
    const filtered = notes.filter((note) => !note.startsWith('Next step:'));
    const nextStep = nextPhase === 'PARALLEL_CLARIFY'
      ? 'Next step: run project-level clarification gating and decision synthesis.'
      : nextPhase === 'PARALLEL_SPECIFY'
      ? 'Next step: fan out project-level specify tasks.'
        : nextPhase === 'PARALLEL_PLAN'
          ? 'Next step: validate or regenerate project plan.md files.'
          : nextPhase === 'PARALLEL_ACE'
            ? 'Next step: fan out project-level ACE execution tasks.'
            : nextPhase === 'FEEDBACK_ITERATION'
            ? 'Next step: review pending workspace decisions or feedback and choose which phase to resume.'
            : 'Next step: workspace flow is complete.';
    return [...filtered, nextStep];
  }

  private deriveProjectControlPlane(project: WorkspaceProjectState): Pick<WorkspaceProjectState, 'workflowContract' | 'workflowRole' | 'workflowSkillName' | 'workflowSkillPath' | 'blockerKind' | 'recommendedCommand'> {
    const route = project.phase === 'PARALLEL_CLARIFY' || project.phase === 'PARALLEL_SPECIFY' || project.phase === 'PARALLEL_PLAN' || project.phase === 'PARALLEL_ACE'
      ? getWorkflowSkillRouteByPhase(project.phase)
      : undefined;
    const workflowContract = route?.contract;
    const workflowRole = route?.role;
    const workflowSkillName = route?.skillName;
    const workflowSkillPath = route?.skillPath;

    const looksLikeTimeout = !!project.summary && /timed out|did not finish within/i.test(project.summary);
    const blockerKind = project.status === 'blocked'
      ? project.phase === 'PARALLEL_PLAN'
        ? 'REPLAN'
        : looksLikeTimeout
          ? 'EXECUTION_FAILED'
          : 'NEED_HUMAN'
      : project.status === 'failed'
        ? project.phase === 'PARALLEL_ACE'
          ? 'EXECUTION_FAILED'
          : 'EXECUTION_FAILED'
        : undefined;

    const recommendedCommand = project.status === 'blocked' || project.status === 'failed'
      ? 'tik workspace decisions'
      : project.status === 'completed'
        ? project.phase === 'PARALLEL_CLARIFY'
          ? 'tik workspace next'
          : project.phase === 'PARALLEL_SPECIFY'
          ? 'tik workspace next'
          : project.phase === 'PARALLEL_PLAN'
            ? 'tik workspace next'
            : project.phase === 'PARALLEL_ACE'
              ? 'tik workspace report'
              : 'tik workspace status'
        : project.status === 'in_progress'
          ? 'tik workspace status'
          : project.phase === 'PARALLEL_CLARIFY'
            ? 'tik workspace next'
            : project.phase === 'PARALLEL_SPECIFY'
            ? 'tik workspace next'
            : project.phase === 'PARALLEL_PLAN'
              ? 'tik workspace next'
              : project.phase === 'PARALLEL_ACE'
                ? 'tik workspace next'
                : 'tik workspace status';

    return {
      workflowContract,
      workflowRole,
      workflowSkillName,
      workflowSkillPath,
      blockerKind,
      recommendedCommand,
    };
  }

  private upsertProjectWorktreeLane(
    active: WorkspaceProjectWorktreeState | undefined,
    lanes: WorkspaceProjectWorktreeState[] | undefined,
    worktree: WorkspaceProjectWorktreeState,
  ): WorkspaceProjectWorktreeState[] {
    const laneId = normalizeLaneId(worktree.laneId);
    const next = [...(lanes || []), ...(active ? [active] : [])];
    const deduped = next.filter((lane, index, all) => (
      all.findIndex((candidate) => normalizeLaneId(candidate.laneId) === normalizeLaneId(lane.laneId)) === index
    ));
    const index = deduped.findIndex((lane) => normalizeLaneId(lane.laneId) === laneId);
    const normalized = {
      ...worktree,
      laneId,
    };
    if (index >= 0) {
      deduped[index] = normalized;
    } else {
      deduped.push(normalized);
    }
    return deduped;
  }

  private async reconcileDecisionRequests(
    rootPath: string,
    snapshot: WorkspaceStatusSnapshot,
    decisions: WorkspaceDecisionRequest[],
    blockedProjects: WorkspaceProjectState[],
    now: string,
  ): Promise<WorkspaceDecisionRequest[]> {
    const next = [...decisions];
    for (const project of blockedProjects) {
      const existing = next.find((decision) =>
        decision.status === 'pending'
        && decision.projectName === project.projectName
        && decision.phase === this.toDecisionPhase(project.phase),
      );
      if (existing) continue;
      next.push(await this.buildDecisionRequest(rootPath, snapshot, project, now));
    }
    return next;
  }

  private upsertDecisionRequest(
    decisions: WorkspaceDecisionRequest[],
    decision: WorkspaceDecisionRequest,
  ): WorkspaceDecisionRequest[] {
    const next = [...decisions];
    const existingIndex = next.findIndex((item) => (
      item.id === decision.id
      || (
        item.status === 'pending'
        && item.projectName === decision.projectName
        && item.phase === decision.phase
      )
    ));
    if (existingIndex >= 0) {
      next[existingIndex] = decision;
      return next;
    }
    next.push(decision);
    return next;
  }

  private resolvePendingDecisions(
    decisions: WorkspaceDecisionRequest[],
    affectedProjects: string[],
    resolution: WorkspaceDecisionResolution,
  ): WorkspaceDecisionRequest[] {
    const affected = new Set(affectedProjects);
    return decisions.map((decision) => (
      decision.status === 'pending'
      && (affected.size === 0 || (decision.projectName && affected.has(decision.projectName)))
        ? {
          ...decision,
          status: resolution.status,
          updatedAt: resolution.resolvedAt,
          resolution,
        }
        : decision
    ));
  }

  private dismissStalePendingDecisions(
    decisions: WorkspaceDecisionRequest[],
    now: string,
  ): WorkspaceDecisionRequest[] {
    return decisions.map((decision) => (
      decision.status === 'pending'
        ? {
          ...decision,
          status: 'dismissed',
          updatedAt: now,
          resolution: {
            status: 'dismissed',
            resolvedAt: now,
            message: 'Dismissed after workspace feedback loop advanced.',
          },
        }
        : decision
    ));
  }

  private dismissResolvedProjectDecisions(
    decisions: WorkspaceDecisionRequest[],
    projects: WorkspaceProjectState[],
    now: string,
  ): WorkspaceDecisionRequest[] {
    const stillBlocked = new Set(
      projects
        .filter((project) => project.status === 'blocked' || project.status === 'failed')
        .map((project) => `${project.projectName}:${this.toDecisionPhase(project.phase)}`),
    );
    return decisions.map((decision) => (
      decision.status === 'pending'
      && decision.projectName
      && !stillBlocked.has(`${decision.projectName}:${decision.phase}`)
        ? {
          ...decision,
          status: 'dismissed',
          updatedAt: now,
          resolution: {
            status: 'dismissed',
            resolvedAt: now,
            message: 'Dismissed because the project is no longer blocked in this phase.',
          },
        }
        : decision
    ));
  }

  private async buildDecisionRequest(
    rootPath: string,
    snapshot: WorkspaceStatusSnapshot,
    project: WorkspaceProjectState,
    now: string,
  ): Promise<WorkspaceDecisionRequest> {
    return synthesizeWorkspaceDecision(await this.buildDecisionSynthesisInput(rootPath, snapshot, project), now);
  }

  private async buildDecisionSynthesisInput(
    rootPath: string,
    snapshot: WorkspaceStatusSnapshot,
    project: WorkspaceProjectState,
  ): Promise<WorkspaceDecisionSynthesisInput> {
    const eventStore = new WorkspaceEventStore({
      persistPath: path.join(this.getWorkspaceDir(rootPath), 'events.jsonl'),
    });
    const projection = buildWorkspaceEventProjection(eventStore.snapshot());
    const memoryStore = new WorkspaceMemoryStore(rootPath);
    const memory = await memoryStore.load();
    const recentProjectEvents = projection.recent
      .filter((event) => event.projectName === project.projectName)
      .slice(-4)
      .map((event) => `${event.phase} ${event.kind}: ${event.message}`);
    const recentWorkspaceEvents = projection.recent
      .slice(-4)
      .map((event) => `${event.projectName ? `${event.projectName} / ` : ''}${event.phase} ${event.kind}: ${event.message}`);
    const knownArtifacts = [project.clarificationPath, project.specPath, project.planPath].filter((item): item is string => Boolean(item));
    const clarificationExcerpt = await this.readArtifactExcerpt(project.clarificationPath);
    const specExcerpt = await this.readArtifactExcerpt(project.specPath);
    const planExcerpt = await this.readArtifactExcerpt(project.planPath);

    return {
      projectName: project.projectName,
      phase: this.toDecisionPhase(project.phase),
      blockerKind: project.blockerKind,
      summary: project.summary,
      demand: snapshot.state?.demand,
      workflowContract: project.workflowContract,
      workflowRole: project.workflowRole,
      workflowSkillName: project.workflowSkillName,
      specPath: project.specPath,
      planPath: project.planPath,
      workflowProfile: snapshot.settings?.workflowPolicy?.profile,
      recentProjectEvents,
      recentWorkspaceEvents,
      projectKnownArtifacts: knownArtifacts,
      sessionNextAction: memory?.session.nextAction || project.recommendedCommand,
      specExcerpt: clarificationExcerpt ? [clarificationExcerpt, specExcerpt].filter(Boolean).join('\n\n') : specExcerpt,
      planExcerpt,
    };
  }

  private toDecisionPhase(phase: WorkspacePhase): 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE' {
    return phase === 'PARALLEL_CLARIFY'
      ? 'PARALLEL_CLARIFY'
      : phase === 'PARALLEL_PLAN'
      ? 'PARALLEL_PLAN'
      : phase === 'PARALLEL_ACE'
        ? 'PARALLEL_ACE'
        : 'PARALLEL_SPECIFY';
  }

  private computeSummary(projects: WorkspaceProjectState[], updatedAt: string) {
    return {
      totalProjects: projects.length,
      completedProjects: projects.filter((project) => project.status === 'completed').length,
      blockedProjects: projects.filter((project) => project.status === 'blocked').length,
      failedProjects: projects.filter((project) => project.status === 'failed').length,
      clarifiedProjects: projects.filter((project) => Boolean(project.clarificationPath) && project.clarificationStatus !== 'awaiting_decision').length,
      pendingClarificationProjects: projects.filter((project) => Boolean(project.clarificationPath) && project.clarificationStatus === 'awaiting_decision').length,
      needsHumanProjects: projects.filter((project) => project.blockerKind === 'NEED_HUMAN').length,
      replanProjects: projects.filter((project) => project.blockerKind === 'REPLAN').length,
      updatedAt,
    };
  }

  private async readArtifactExcerpt(artifactPath?: string): Promise<string | undefined> {
    if (!artifactPath) return undefined;
    try {
      const content = await fs.readFile(artifactPath, 'utf-8');
      return content.slice(0, 1200);
    } catch {
      return undefined;
    }
  }

  private async withWorkspaceFileLock<T>(rootPath: string, fn: () => Promise<T>): Promise<T> {
    const workspaceDir = this.getWorkspaceDir(rootPath);
    const lockPath = this.getWorkspaceLockPath(rootPath);
    await fs.mkdir(workspaceDir, { recursive: true });
    const startedAt = Date.now();

    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }));
          return await fn();
        } finally {
          await handle.close().catch(() => undefined);
          await fs.unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') {
          throw error;
        }
        await this.maybeClearStaleWorkspaceLock(lockPath);
        if (Date.now() - startedAt > this.lockTimeoutMs) {
          throw new Error(`Timed out waiting for workspace state lock: ${lockPath}`);
        }
        await sleep(25);
      }
    }
  }

  private async maybeClearStaleWorkspaceLock(lockPath: string): Promise<void> {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > this.staleLockMs) {
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch {
      // The lock may already be gone; ignore and retry.
    }
  }
}

function normalizeLaneId(value?: string): string {
  return (value || 'primary').trim() || 'primary';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
