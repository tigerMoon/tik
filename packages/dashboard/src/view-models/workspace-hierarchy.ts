import type { TaskWorkspaceBinding } from '@tik/shared';
import type { WorkbenchTaskResponse, WorkspaceStatusResponse } from '../api/client';

export type WorkspaceScopeKey = 'workspace' | `project:${string}`;

export interface WorkspaceProjectNode {
  key: WorkspaceScopeKey;
  name: string;
  path?: string;
  sourceProjectPath?: string;
  effectiveProjectPath?: string;
  taskCount: number;
  activeTaskCount: number;
  completedTaskCount: number;
  binding?: TaskWorkspaceBinding;
}

export interface WorkspaceHierarchy {
  workspace: {
    key: WorkspaceScopeKey;
    name: string;
    rootPath: string;
    workspaceFile?: string;
    taskCount: number;
    activeTaskCount: number;
    completedTaskCount: number;
  };
  projects: WorkspaceProjectNode[];
  defaultScopeKey: WorkspaceScopeKey;
}

export interface WorkspaceBindingOption {
  key: WorkspaceScopeKey;
  label: string;
  detail: string;
  kind: 'workspace' | 'project';
  taskCount: number;
  binding?: TaskWorkspaceBinding;
}

type HierarchyTask = Pick<WorkbenchTaskResponse, 'status' | 'workspaceBinding'>;

export function buildWorkspaceHierarchy(
  tasks: HierarchyTask[],
  workspaceStatus: WorkspaceStatusResponse | null,
  fallbackRootPath: string,
): WorkspaceHierarchy {
  const firstBinding = tasks.find((task) => task.workspaceBinding)?.workspaceBinding;
  const workspaceName = workspaceStatus?.settings?.workspaceName
    || firstBinding?.workspaceName
    || basename(fallbackRootPath)
    || 'Loading workspace';
  const workspaceRoot = workspaceStatus?.settings?.workspaceRoot
    || workspaceStatus?.rootPath
    || firstBinding?.workspaceRoot
    || fallbackRootPath;
  const workspaceFile = workspaceStatus?.settings?.workspaceFile || firstBinding?.workspaceFile;

  const projectMap = new Map<string, WorkspaceProjectNode>();

  for (const project of workspaceStatus?.settings?.projects || []) {
    const key = buildProjectScopeKey(project.name, project.path);
    projectMap.set(key, {
      key,
      name: project.name,
      path: project.path,
      sourceProjectPath: project.path,
      effectiveProjectPath: project.path,
      taskCount: 0,
      activeTaskCount: 0,
      completedTaskCount: 0,
      binding: {
        workspaceRoot,
        workspaceName,
        workspaceFile,
        projectName: project.name,
        sourceProjectPath: project.path,
        effectiveProjectPath: project.path,
        worktreeKind: 'root',
      },
    });
  }

  for (const entry of workspaceStatus?.memory?.projects || []) {
    const key = buildProjectScopeKey(entry.projectName, entry.projectPath);
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        key,
        name: entry.projectName,
        path: entry.projectPath,
        sourceProjectPath: entry.projectPath,
        effectiveProjectPath: entry.projectPath,
        taskCount: 0,
        activeTaskCount: 0,
        completedTaskCount: 0,
        binding: {
          workspaceRoot,
          workspaceName,
          workspaceFile,
          projectName: entry.projectName,
          sourceProjectPath: entry.projectPath,
          effectiveProjectPath: entry.projectPath,
          worktreeKind: 'root',
        },
      });
    }
  }

  for (const entry of workspaceStatus?.worktrees?.entries || []) {
    const key = buildProjectScopeKey(entry.projectName, entry.sourceProjectPath);
    const existing = projectMap.get(key);
    projectMap.set(key, {
      key,
      name: entry.projectName,
      path: entry.sourceProjectPath,
      sourceProjectPath: entry.sourceProjectPath,
      effectiveProjectPath: entry.effectiveProjectPath,
      taskCount: existing?.taskCount || 0,
      activeTaskCount: existing?.activeTaskCount || 0,
      completedTaskCount: existing?.completedTaskCount || 0,
      binding: {
        workspaceRoot,
        workspaceName,
        workspaceFile,
        projectName: entry.projectName,
        sourceProjectPath: entry.sourceProjectPath,
        effectiveProjectPath: entry.effectiveProjectPath,
        laneId: entry.laneId,
        worktreeKind: entry.kind,
        worktreePath: entry.worktree?.worktreePath,
      },
    });
  }

  const hasProjectBoundTasks = tasks.some((task) => !!task.workspaceBinding?.projectName);
  if (projectMap.size === 0 && !hasProjectBoundTasks && workspaceRoot) {
    const fallbackProjectName = basename(workspaceRoot);
    const key = buildProjectScopeKey(fallbackProjectName, workspaceRoot);
    projectMap.set(key, {
      key,
      name: fallbackProjectName,
      path: workspaceRoot,
      sourceProjectPath: workspaceRoot,
      effectiveProjectPath: workspaceRoot,
      taskCount: 0,
      activeTaskCount: 0,
      completedTaskCount: 0,
      binding: {
        workspaceRoot,
        workspaceName,
        workspaceFile,
        projectName: fallbackProjectName,
        sourceProjectPath: workspaceRoot,
        effectiveProjectPath: workspaceRoot,
        worktreeKind: 'root',
      },
    });
  }

  let workspaceTaskCount = 0;
  let workspaceActiveTaskCount = 0;
  let workspaceCompletedTaskCount = 0;

  for (const task of tasks) {
    const binding = task.workspaceBinding;
    workspaceTaskCount += 1;
    if (isActiveTaskStatus(task.status)) {
      workspaceActiveTaskCount += 1;
    }
    if (task.status === 'completed') {
      workspaceCompletedTaskCount += 1;
    }

    if (!binding?.projectName) {
      continue;
    }

    const key = buildProjectScopeKey(binding.projectName, binding.sourceProjectPath || binding.effectiveProjectPath);
    const existing = projectMap.get(key);
    const nextNode: WorkspaceProjectNode = existing || {
      key,
      name: binding.projectName,
      path: binding.sourceProjectPath || binding.effectiveProjectPath,
      sourceProjectPath: binding.sourceProjectPath,
      effectiveProjectPath: binding.effectiveProjectPath,
      taskCount: 0,
      activeTaskCount: 0,
      completedTaskCount: 0,
      binding,
    };
    nextNode.taskCount += 1;
    if (isActiveTaskStatus(task.status)) {
      nextNode.activeTaskCount += 1;
    }
    if (task.status === 'completed') {
      nextNode.completedTaskCount += 1;
    }
    nextNode.binding = {
      ...binding,
      workspaceRoot: binding.workspaceRoot || workspaceRoot,
      workspaceName: binding.workspaceName || workspaceName,
      workspaceFile: binding.workspaceFile || workspaceFile,
    };
    projectMap.set(key, nextNode);
  }

  const projects = Array.from(projectMap.values()).sort((left, right) => {
    if (right.taskCount !== left.taskCount) {
      return right.taskCount - left.taskCount;
    }
    return left.name.localeCompare(right.name);
  });

  return {
    workspace: {
      key: 'workspace',
      name: workspaceName,
      rootPath: workspaceRoot,
      workspaceFile,
      taskCount: workspaceTaskCount,
      activeTaskCount: workspaceActiveTaskCount,
      completedTaskCount: workspaceCompletedTaskCount,
    },
    projects,
    defaultScopeKey: 'workspace',
  };
}

export function filterTasksByWorkspaceScope<T extends HierarchyTask>(
  tasks: T[],
  scopeKey: WorkspaceScopeKey,
): T[] {
  if (scopeKey === 'workspace') {
    return tasks;
  }

  return tasks.filter((task) => {
    const binding = task.workspaceBinding;
    if (!binding?.projectName) {
      return false;
    }
    return buildProjectScopeKey(binding.projectName, binding.sourceProjectPath || binding.effectiveProjectPath) === scopeKey;
  });
}

export function buildWorkspaceBindingOptions(hierarchy: WorkspaceHierarchy): WorkspaceBindingOption[] {
  return [
    {
      key: 'workspace',
      label: hierarchy.workspace.name,
      detail: compactPath(hierarchy.workspace.rootPath),
      kind: 'workspace',
      taskCount: hierarchy.workspace.taskCount,
      binding: {
        workspaceRoot: hierarchy.workspace.rootPath,
        workspaceName: hierarchy.workspace.name,
        workspaceFile: hierarchy.workspace.workspaceFile,
        effectiveProjectPath: hierarchy.workspace.rootPath,
        worktreeKind: 'root',
      },
    },
    ...hierarchy.projects.map((project) => ({
      key: project.key,
      label: project.name,
      detail: compactPath(project.effectiveProjectPath || project.path || project.sourceProjectPath || ''),
      kind: 'project' as const,
      taskCount: project.taskCount,
      binding: project.binding,
    })),
  ];
}

export function resolveWorkspaceBindingOption(
  options: WorkspaceBindingOption[],
  scopeKey: WorkspaceScopeKey,
): WorkspaceBindingOption {
  return options.find((option) => option.key === scopeKey) || options[0]!;
}

export function buildProjectScopeKey(projectName: string, projectPath?: string): WorkspaceScopeKey {
  const pathToken = projectPath ? `:${projectPath}` : '';
  return `project:${projectName}${pathToken}`;
}

export function buildTaskBindingLabel(binding: TaskWorkspaceBinding | undefined): string {
  if (!binding) {
    return 'Workspace';
  }
  if (binding.projectName) {
    return binding.projectName;
  }
  return `${binding.workspaceName || 'Workspace'} workspace`;
}

function isActiveTaskStatus(status: WorkbenchTaskResponse['status']): boolean {
  return status === 'running' || status === 'verifying' || status === 'waiting_for_user' || status === 'new';
}

function basename(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || value;
}

function compactPath(value: string): string {
  if (!value) {
    return 'No path';
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length <= 3) {
    return value;
  }
  return `.../${parts.slice(-3).join('/')}`;
}
