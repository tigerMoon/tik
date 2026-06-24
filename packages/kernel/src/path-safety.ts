import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function safeResolve(contextCwd: string, requestedPath: string): Promise<string> {
  if (!requestedPath || !requestedPath.trim()) {
    throw new Error('Path is required.');
  }

  if (path.isAbsolute(requestedPath)) {
    throw new Error(`Refusing absolute paths outside the workspace: ${requestedPath}`);
  }

  const cwd = path.resolve(contextCwd);
  const normalized = requestedPath.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) {
    throw new Error(`Refusing parent traversal outside the workspace: ${requestedPath}`);
  }

  const resolved = path.resolve(cwd, requestedPath);
  if (!isWithin(cwd, resolved)) {
    throw new Error(`Refusing path outside the workspace: ${requestedPath}`);
  }

  const realParent = await fs.realpath(path.dirname(resolved)).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return nearestExistingRealpath(cwd, path.dirname(resolved));
  });
  const realCwd = await fs.realpath(cwd);
  if (!isWithin(realCwd, realParent)) {
    throw new Error(`Refusing symlink escape outside the workspace: ${requestedPath}`);
  }

  const basename = path.basename(resolved);
  return path.join(realParent, basename);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingRealpath(root: string, targetDir: string): Promise<string> {
  let current = path.resolve(targetDir);
  const resolvedRoot = path.resolve(root);

  while (isWithin(resolvedRoot, current)) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error(`Refusing path outside the workspace: ${targetDir}`);
}
