import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  WorkspacePhase,
  WorkspaceSettings,
  WorkspaceSplitDemands,
  WorkspaceState,
  WorkspaceWorkflowPolicyConfig,
} from '@tik/shared';
import type { WorkspaceEventProjection } from './workspace-event-projection.js';

export interface WorkspaceSessionMemory {
  workspaceName?: string;
  rootPath: string;
  demand?: string;
  currentPhase?: WorkspacePhase;
  workflowProfile?: WorkspaceWorkflowPolicyConfig['profile'];
  completedProjects: string[];
  blockedProjects: string[];
  failedProjects: string[];
  recentEvents: string[];
  nextAction?: string;
  updatedAt: string;
}

export interface WorkspaceProjectMemory {
  projectName: string;
  projectPath: string;
  phase?: WorkspacePhase;
  status?: string;
  workflowRole?: string;
  workflowContract?: string;
  workflowSkillName?: string;
  executionMode?: 'native' | 'fallback';
  knownArtifacts: string[];
  recentEvents: string[];
  summary?: string;
  blockerKind?: string;
  recommendedCommand?: string;
  updatedAt: string;
}

export interface WorkspaceMemorySnapshot {
  session: WorkspaceSessionMemory;
  projects: WorkspaceProjectMemory[];
}

export interface WorkspaceMemoryRefreshInput {
  rootPath: string;
  settings: WorkspaceSettings | null;
  state: WorkspaceState | null;
  splitDemands: WorkspaceSplitDemands | null;
  projection: WorkspaceEventProjection;
}

export class WorkspaceMemoryStore {
  constructor(private readonly rootPath: string) {}

  async refresh(input: Omit<WorkspaceMemoryRefreshInput, 'rootPath'>): Promise<WorkspaceMemorySnapshot> {
    const snapshot = this.buildSnapshot({
      rootPath: this.rootPath,
      ...input,
    });
    const memoryDir = this.getMemoryDir();
    const projectDir = path.join(memoryDir, 'projects');
    await fs.mkdir(projectDir, { recursive: true });
    await this.writeIfChanged(path.join(memoryDir, 'session.json'), JSON.stringify(snapshot.session, null, 2));
    const activeProjectFiles = new Set(snapshot.projects.map((project) => this.projectFileName(project.projectName)));
    const existingEntries = await fs.readdir(projectDir);
    await Promise.all(existingEntries
      .filter((entry) => entry.endsWith('.json') && !activeProjectFiles.has(entry))
      .map((entry) => fs.rm(path.join(projectDir, entry), { force: true })));
    await Promise.all(snapshot.projects.map(async (project) => {
      await this.writeIfChanged(
        path.join(projectDir, this.projectFileName(project.projectName)),
        JSON.stringify(project, null, 2),
      );
    }));
    return snapshot;
  }

  async load(): Promise<WorkspaceMemorySnapshot | null> {
    const memoryDir = this.getMemoryDir();
    try {
      const [sessionContent, projectEntries] = await Promise.all([
        fs.readFile(path.join(memoryDir, 'session.json'), 'utf-8'),
        fs.readdir(path.join(memoryDir, 'projects')),
      ]);
      const projects = await Promise.all(projectEntries
        .filter((entry) => entry.endsWith('.json'))
        .sort()
        .map(async (entry) => JSON.parse(
          await fs.readFile(path.join(memoryDir, 'projects', entry), 'utf-8'),
        ) as WorkspaceProjectMemory));
      return {
        session: JSON.parse(sessionContent) as WorkspaceSessionMemory,
        projects,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async loadOrBuild(input: Omit<WorkspaceMemoryRefreshInput, 'rootPath'>): Promise<WorkspaceMemorySnapshot> {
    const existing = await this.load();
    if (existing) return existing;
    return this.refresh(input);
  }

  private buildSnapshot(input: WorkspaceMemoryRefreshInput): WorkspaceMemorySnapshot {
    const projects = (input.state?.projects || []).map((project) => {
      const projection = input.projection.projects.find((entry) => entry.projectName === project.projectName);
      const knownArtifacts = [project.specPath, project.planPath].filter((entry): entry is string => Boolean(entry));
      return {
        projectName: project.projectName,
        projectPath: project.projectPath,
        phase: project.phase,
        status: project.status,
        workflowRole: project.workflowRole,
        workflowContract: project.workflowContract,
        workflowSkillName: project.workflowSkillName,
        executionMode: project.executionMode,
        knownArtifacts,
        recentEvents: projection?.lastMessage ? [projection.lastMessage] : [],
        summary: project.summary,
        blockerKind: project.blockerKind,
        recommendedCommand: project.recommendedCommand,
        updatedAt: project.updatedAt,
      } satisfies WorkspaceProjectMemory;
    });
    const currentPhase = input.state?.currentPhase;
    const nextAction = currentPhase === 'COMPLETED'
      ? 'tik workspace report'
      : input.state?.workspaceFeedback?.required
        ? `tik workspace feedback --message "<feedback>" --next-phase ${input.state.workspaceFeedback.nextPhase || 'PARALLEL_PLAN'}`
        : 'tik workspace next --provider codex';
    return {
      session: {
        workspaceName: input.settings?.workspaceName,
        rootPath: input.rootPath,
        demand: input.state?.demand || input.splitDemands?.demand,
        currentPhase,
        workflowProfile: input.settings?.workflowPolicy?.profile,
        completedProjects: projects.filter((project) => project.status === 'completed').map((project) => project.projectName),
        blockedProjects: projects.filter((project) => project.status === 'blocked').map((project) => project.projectName),
        failedProjects: projects.filter((project) => project.status === 'failed').map((project) => project.projectName),
        recentEvents: input.projection.recent.map((event) =>
          `${event.projectName ? `${event.projectName} / ` : ''}${event.phase} ${event.kind}: ${event.message}`,
        ),
        nextAction,
        updatedAt: input.state?.updatedAt || input.settings?.updatedAt || new Date().toISOString(),
      },
      projects,
    };
  }

  private getMemoryDir(): string {
    return path.join(this.rootPath, '.workspace', 'memory');
  }

  private projectFileName(projectName: string): string {
    return `${projectName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}.json`;
  }

  private async writeIfChanged(filePath: string, content: string): Promise<void> {
    try {
      const existing = await fs.readFile(filePath, 'utf-8');
      if (existing === content) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await fs.writeFile(filePath, content, 'utf-8');
  }
}
