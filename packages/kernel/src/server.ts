/**
 * API Server
 *
 * Fastify-based HTTP server for Tik.
 * Provides REST API + SSE for CLI and Dashboard.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CreateTaskInput,
  ControlCommand,
  ExecutionMode,
  SkillManifestMutationInput,
  TaskWorkspaceBinding,
  WorkbenchTaskRecord,
} from '@tik/shared';
import {
  canRetryWorkbenchTask,
  createEnvironmentPackSelection,
  toEnvironmentPackSnapshot,
} from '@tik/shared';
import type { ExecutionKernel } from './execution-kernel.js';
import type { CreateTaskInputV2 } from './execution-kernel.js';
import { WorkspaceReadModel, WORKSPACE_PUBLIC_API_VERSION, WORKSPACE_PUBLIC_SCHEMA_VERSION } from './workspace-public-api.js';
import { WorkspaceOrchestrator } from './workspace-orchestrator.js';
import { WorkspaceWorktreeManager } from './workspace-worktree-manager.js';
import { buildEnvironmentPackDashboard } from './environment-pack-dashboard.js';
import { SkillManifestRegistry } from './skill-manifest-registry.js';

export interface ServerConfig {
  port: number;
  host: string;
}

export interface WorkspaceServerOptions {
  workspaceRoot?: string;
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
  workspaceBinding?: TaskWorkspaceBinding;
}

interface WorkbenchTaskBriefBody {
  title?: string;
  goal?: string;
  adjustment?: string;
  launchFollowUp?: boolean;
}

interface SkillManifestMutationBody extends SkillManifestMutationInput {}

export async function createServer(
  kernel: ExecutionKernel,
  config: ServerConfig = { port: 3000, host: 'localhost' },
  options?: WorkspaceServerOptions,
) {
  const { default: Fastify } = await import('fastify');
  const fastify = Fastify({ logger: false });
  const skillRegistry = new SkillManifestRegistry(options?.workspaceRoot || kernel.projectPath || process.cwd());

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
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { reply.send(); }
  });

  // Create task (async — runs in background, returns task immediately)
  fastify.post<{ Body: CreateTaskInputV2 }>('/api/tasks', async (req) => {
    const activePack = await kernel.environmentPacks.getActivePack();
    const task = kernel.taskManager.create({
      ...req.body,
      environmentPackSnapshot: req.body.environmentPackSnapshot
        || (activePack ? toEnvironmentPackSnapshot(activePack) : undefined),
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

    const requestedPackId = req.body.environmentPackId?.trim();
    const activePack = await kernel.environmentPacks.getActivePack();
    const packs = requestedPackId
      ? await kernel.environmentPacks.listPacks()
      : [];
    const boundPack = requestedPackId
      ? packs.find((item) => item.id === requestedPackId) || null
      : activePack;

    if (requestedPackId && !boundPack) {
      reply.code(404);
      return { error: `Environment pack not found: ${requestedPackId}` };
    }

    const requestedSelection = {
      selectedSkills: req.body.selectedSkills,
      selectedKnowledgeIds: req.body.selectedKnowledgeIds,
    };
    const environmentPackSnapshot = boundPack
      ? toEnvironmentPackSnapshot(boundPack)
      : undefined;
    const environmentPackSelection = boundPack
      ? createEnvironmentPackSelection(boundPack, requestedSelection)
      : undefined;

    if (boundPack) {
      const invalidSkills = (req.body.selectedSkills || []).filter((skill) => !boundPack.skills.includes(skill));
      const invalidKnowledge = (req.body.selectedKnowledgeIds || []).filter((id) => !boundPack.knowledge.some((entry) => entry.id === id));
      if (invalidSkills.length > 0 || invalidKnowledge.length > 0) {
        reply.code(400);
        return {
          error: `Invalid task configuration. Unknown skills: ${invalidSkills.join(', ') || 'none'}. Unknown knowledge: ${invalidKnowledge.join(', ') || 'none'}.`,
        };
      }
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
      environmentPackSnapshot,
      environmentPackSelection,
      workspaceBinding,
    });
    const task = await workbench.createTask({
      ...req.body,
      environmentPackSnapshot,
      environmentPackSelection,
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

  fastify.get<{ Querystring: { path?: string } }>('/api/workbench/artifacts/preview', async (req, reply) => {
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
      const content = await fs.readFile(resolvedFilePath);
      reply.header('Content-Type', getPreviewContentType(resolvedFilePath));
      reply.header('Content-Disposition', `inline; filename="${path.basename(resolvedFilePath)}"`);
      return reply.send(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.code(404);
        return { error: 'Artifact not found' };
      }
      reply.code(500);
      return { error: (error as Error).message };
    }
  });

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
