import * as path from 'node:path';
import type { WorkspaceDecisionRequest, WorkspaceSettings, WorkspaceSplitDemands, WorkspaceState } from '@tik/shared';
import { WorkspaceEventStore } from './workspace-event-store.js';
import { buildWorkspaceEventProjection, type WorkspaceEventProjection } from './workspace-event-projection.js';
import {
  WorkspaceMemoryStore,
  type WorkspaceProjectMemory,
  type WorkspaceMemorySnapshot,
} from './workspace-memory.js';
import { WorkspaceOrchestrator } from './workspace-orchestrator.js';
import { WorkspaceWorktreeManager, type WorkspaceManagedWorktreeEntry } from './workspace-worktree-manager.js';

export const WORKSPACE_PUBLIC_API_VERSION = '2026-04-07';
export const WORKSPACE_PUBLIC_SCHEMA_VERSION = 2;

export interface WorkspaceManagedWorktreeView extends WorkspaceManagedWorktreeEntry {
  projectPhase?: NonNullable<WorkspaceState['projects']>[number]['phase'];
  projectStatus?: NonNullable<WorkspaceState['projects']>[number]['status'];
}

export interface WorkspaceWorktreesView {
  mode: NonNullable<WorkspaceSettings['worktreePolicy']>['mode'] | 'managed';
  root: string;
  nonGitStrategy: NonNullable<WorkspaceSettings['worktreePolicy']>['nonGitStrategy'] | 'source';
  entries: WorkspaceManagedWorktreeView[];
}

export interface WorkspacePublicSnapshot {
  apiVersion: string;
  schemaVersion: number;
  rootPath: string;
  settings: WorkspaceSettings | null;
  state: WorkspaceState | null;
  splitDemands: WorkspaceSplitDemands | null;
  projection: WorkspaceEventProjection;
  memory: WorkspaceMemorySnapshot;
  worktrees: WorkspaceWorktreesView;
}

export interface WorkspaceStatusView extends WorkspacePublicSnapshot {}

export interface WorkspaceBoardView {
  apiVersion: string;
  schemaVersion: number;
  rootPath: string;
  phase: WorkspaceState['currentPhase'] | 'WORKSPACE_SPLIT';
  healthy: Array<NonNullable<WorkspaceState['projects']>[number]>;
  blocked: Array<NonNullable<WorkspaceState['projects']>[number]>;
  feedbackRequired: boolean;
  pendingDecisions: WorkspaceDecisionRequest[];
  projection: WorkspaceEventProjection;
  memory: WorkspaceMemorySnapshot;
}

export interface WorkspaceReportView extends WorkspacePublicSnapshot {
  eventCount: number;
}

export class WorkspaceReadModel {
  private readonly orchestrator: WorkspaceOrchestrator;
  private readonly memoryStore: WorkspaceMemoryStore;
  private readonly worktreeManager: WorkspaceWorktreeManager;

  constructor(
    private readonly rootPath: string,
    options?: {
      orchestrator?: WorkspaceOrchestrator;
      memoryStore?: WorkspaceMemoryStore;
    },
  ) {
    this.orchestrator = options?.orchestrator ?? new WorkspaceOrchestrator();
    this.memoryStore = options?.memoryStore ?? new WorkspaceMemoryStore(rootPath);
    this.worktreeManager = new WorkspaceWorktreeManager();
  }

  async load(): Promise<WorkspacePublicSnapshot> {
    const snapshot = await this.orchestrator.getStatus(this.rootPath);
    const eventStore = new WorkspaceEventStore({
      persistPath: path.join(this.rootPath, '.workspace', 'events.jsonl'),
    });
    const projection = buildWorkspaceEventProjection(eventStore.snapshot());
    const hasWorkspaceState = Boolean(snapshot.settings || snapshot.state || snapshot.splitDemands || projection.totalEvents > 0);
    const memory = hasWorkspaceState
      ? await this.memoryStore.refresh({
        settings: snapshot.settings,
        state: snapshot.state,
        splitDemands: snapshot.splitDemands,
        projection,
      })
      : await this.memoryStore.load() ?? this.buildEmptyMemorySnapshot();
    const worktrees = await this.buildWorktreesView(snapshot.settings, snapshot.state);
    return {
      apiVersion: WORKSPACE_PUBLIC_API_VERSION,
      schemaVersion: WORKSPACE_PUBLIC_SCHEMA_VERSION,
      rootPath: this.rootPath,
      settings: snapshot.settings,
      state: snapshot.state,
      splitDemands: snapshot.splitDemands,
      projection,
      memory,
      worktrees,
    };
  }

  async readStatusView(): Promise<WorkspaceStatusView> {
    return this.load();
  }

  async readBoardView(): Promise<WorkspaceBoardView> {
    const view = await this.load();
    const projects = (view.state?.projects || []);
    return {
      apiVersion: view.apiVersion,
      schemaVersion: view.schemaVersion,
      rootPath: this.rootPath,
      phase: view.state?.currentPhase || 'WORKSPACE_SPLIT',
      healthy: projects.filter((project) => !project.blockerKind),
      blocked: projects.filter((project) => Boolean(project.blockerKind)),
      feedbackRequired: Boolean(view.state?.workspaceFeedback?.required),
      pendingDecisions: (view.state?.decisions || []).filter((decision) => decision.status === 'pending'),
      projection: view.projection,
      memory: view.memory,
    };
  }

  async readReportView(): Promise<WorkspaceReportView> {
    const view = await this.load();
    return {
      ...view,
      eventCount: view.projection.totalEvents,
    };
  }

  private buildEmptyMemorySnapshot(): WorkspaceMemorySnapshot {
    return {
      session: {
        rootPath: this.rootPath,
        completedProjects: [],
        blockedProjects: [],
        failedProjects: [],
        recentEvents: [],
        updatedAt: new Date().toISOString(),
      },
      projects: [] satisfies WorkspaceProjectMemory[],
    };
  }

  private async buildWorktreesView(
    settings: WorkspaceSettings | null,
    state: WorkspaceState | null,
  ): Promise<WorkspaceWorktreesView> {
    const policy = settings?.worktreePolicy;
    const entries = settings && state?.projects?.length
      ? await this.worktreeManager.listManagedWorktrees({
        workspaceName: settings.workspaceName,
        workspaceRoot: this.rootPath,
        projects: state.projects.map((project) => ({
          projectName: project.projectName,
          sourceProjectPath: project.sourceProjectPath || project.projectPath,
          effectiveProjectPath: project.effectiveProjectPath,
          worktree: project.worktree,
          worktreeLanes: project.worktreeLanes,
        })),
        policy,
      })
      : [];
    const projectIndex = new Map((state?.projects || []).map((project) => [project.sourceProjectPath || project.projectPath, project]));
    const enrichedEntries: WorkspaceManagedWorktreeView[] = entries.map((entry) => {
      const project = projectIndex.get(entry.sourceProjectPath);
      const warnings = [...entry.warnings];
      let safeToActivate = entry.safeToActivate;
      let safeToRemove = entry.safeToRemove;
      if (project?.status === 'in_progress' && !entry.active) {
        safeToActivate = false;
        warnings.push('Project is currently in progress on another active lane.');
      }
      if (entry.active && project?.status === 'in_progress') {
        safeToRemove = false;
        warnings.push('Active lane is currently executing.');
      }
      if ((entry.dirtyFileCount || 0) > 0) {
        safeToRemove = false;
      }
      return {
        ...entry,
        warnings: Array.from(new Set(warnings)),
        safeToActivate,
        safeToRemove,
        projectPhase: project?.phase,
        projectStatus: project?.status,
      };
    });
    return {
      mode: policy?.mode || 'managed',
      root: policy?.worktreeRoot || path.join(this.rootPath, '.workspace', 'worktrees'),
      nonGitStrategy: policy?.nonGitStrategy || 'source',
      entries: enrichedEntries,
    };
  }
}
