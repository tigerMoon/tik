import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    if (options.optional) return '';
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function resolveProjectPath(value) {
  return path.resolve(value || process.cwd());
}

export function findWorkspaceRoot(projectPath) {
  let current = projectPath;
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, '.tik')) || existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return projectPath || os.homedir();
}

export function buildWorkspaceBinding(projectPath, options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || findWorkspaceRoot(projectPath));
  const repo = options.repo || path.basename(projectPath);
  return {
    workspaceRoot,
    workspaceName: options.workspaceName || path.basename(workspaceRoot),
    projectName: repo,
    sourceProjectPath: options.sourcePath ? path.resolve(options.sourcePath) : projectPath,
    effectiveProjectPath: projectPath,
    laneId: options.lane || 'codex-multi-agent-workflow',
    worktreeKind: options.worktreeKind || 'root',
  };
}
