import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function isManagedTrackerWorktreePath(workspaceRoot: string, worktreePath: string): boolean {
  const expectedRoot = path.resolve(workspaceRoot, '.workspace', 'worktrees');
  const resolved = path.resolve(worktreePath);
  const relative = path.relative(expectedRoot, resolved);

  return !!relative
    && !relative.startsWith('..')
    && !path.isAbsolute(relative);
}

export async function cleanupManagedTrackerWorkspace(input: {
  workspaceRoot: string;
  worktreePath?: string;
  remove?: typeof fs.rm;
}): Promise<boolean> {
  if (!input.worktreePath || !isManagedTrackerWorktreePath(input.workspaceRoot, input.worktreePath)) {
    return false;
  }

  const remove = input.remove || fs.rm;
  await remove(path.resolve(input.worktreePath), { recursive: true, force: true });
  return true;
}
