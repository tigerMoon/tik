import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cleanupManagedTrackerWorkspace, isManagedTrackerWorktreePath, } from '../src/tracker-workspace-cleanup.js';
describe('tracker workspace cleanup safety', () => {
    it('only treats direct children under the workspace worktrees root as managed worktrees', () => {
        const workspaceRoot = path.resolve('/tmp/tik-workspace');
        expect(isManagedTrackerWorktreePath(workspaceRoot, path.join(workspaceRoot, '.workspace', 'worktrees', 'service-a--tik-1'))).toBe(true);
        expect(isManagedTrackerWorktreePath(workspaceRoot, path.join(workspaceRoot, '.workspace', 'worktrees'))).toBe(false);
        expect(isManagedTrackerWorktreePath(workspaceRoot, path.join(workspaceRoot, '.workspace', 'worktrees', '..', '..', '..', 'victim'))).toBe(false);
        expect(isManagedTrackerWorktreePath(workspaceRoot, path.join(workspaceRoot, '.workspace', 'worktrees-evil', 'service-a'))).toBe(false);
    });
    it('does not remove path-traversal candidates that merely contain the worktrees segment', async () => {
        const workspaceRoot = path.resolve('/tmp/tik-workspace');
        const remove = vi.fn();
        const removed = await cleanupManagedTrackerWorkspace({
            workspaceRoot,
            worktreePath: path.join(workspaceRoot, '.workspace', 'worktrees', '..', '..', '..', 'victim'),
            remove,
        });
        expect(removed).toBe(false);
        expect(remove).not.toHaveBeenCalled();
    });
    it('removes normalized managed worktree children with recursive force semantics', async () => {
        const workspaceRoot = path.resolve('/tmp/tik-workspace');
        const worktreePath = path.join(workspaceRoot, '.workspace', 'worktrees', 'service-a--tik-1');
        const remove = vi.fn();
        const removed = await cleanupManagedTrackerWorkspace({
            workspaceRoot,
            worktreePath,
            remove,
        });
        expect(removed).toBe(true);
        expect(remove).toHaveBeenCalledWith(path.resolve(worktreePath), { recursive: true, force: true });
    });
});
//# sourceMappingURL=tracker-workspace-cleanup.test.js.map