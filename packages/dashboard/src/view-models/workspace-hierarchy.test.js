import { describe, expect, it } from 'vitest';
import { buildTaskBindingLabel, buildWorkspaceBindingOptions, buildWorkspaceHierarchy, filterTasksByWorkspaceScope, } from './workspace-hierarchy.js';
function task(id, status, binding) {
    return {
        id,
        title: id,
        goal: id,
        status,
        createdAt: '2026-06-16T00:00:00.000Z',
        updatedAt: '2026-06-16T00:00:00.000Z',
        workspaceBinding: binding,
    };
}
describe('workspace hierarchy view model', () => {
    it('builds workspace and project nodes from task bindings', () => {
        const tasks = [
            task('workspace-task', 'running', {
                workspaceRoot: '/repo/ws',
                workspaceName: 'Design Workspace',
                effectiveProjectPath: '/repo/ws',
                worktreeKind: 'root',
            }),
            task('project-task', 'completed', {
                workspaceRoot: '/repo/ws',
                workspaceName: 'Design Workspace',
                projectName: 'dashboard',
                sourceProjectPath: '/repo/ws/dashboard',
                effectiveProjectPath: '/repo/ws/dashboard',
                worktreeKind: 'root',
            }),
        ];
        const hierarchy = buildWorkspaceHierarchy(tasks, null, '/repo/ws');
        expect(hierarchy.workspace).toMatchObject({
            name: 'Design Workspace',
            rootPath: '/repo/ws',
            taskCount: 2,
            activeTaskCount: 1,
            completedTaskCount: 1,
        });
        expect(hierarchy.projects).toHaveLength(1);
        expect(hierarchy.projects[0]).toMatchObject({
            name: 'dashboard',
            taskCount: 1,
            completedTaskCount: 1,
        });
    });
    it('keeps workspace status projects even before tasks exist', () => {
        const status = {
            rootPath: '/repo/ws',
            settings: {
                workspaceName: 'Linear-ish',
                workspaceRoot: '/repo/ws',
                workspaceFile: '/repo/ws/app.code-workspace',
                projects: [{ name: 'api', path: '/repo/ws/api' }],
            },
            state: null,
            memory: { projects: [] },
            worktrees: { entries: [] },
        };
        const hierarchy = buildWorkspaceHierarchy([], status, '/repo/ws');
        const options = buildWorkspaceBindingOptions(hierarchy);
        expect(hierarchy.workspace.name).toBe('Linear-ish');
        expect(hierarchy.projects.map((project) => project.name)).toEqual(['api']);
        expect(options.map((option) => option.kind)).toEqual(['workspace', 'project']);
        expect(options[1]?.binding).toMatchObject({
            workspaceName: 'Linear-ish',
            projectName: 'api',
            effectiveProjectPath: '/repo/ws/api',
        });
    });
    it('creates a fallback project for single-repo workspaces', () => {
        const hierarchy = buildWorkspaceHierarchy([], null, '/repo/tik');
        expect(hierarchy.workspace.name).toBe('tik');
        expect(hierarchy.projects).toHaveLength(1);
        expect(hierarchy.projects[0]).toMatchObject({
            name: 'tik',
            path: '/repo/tik',
            taskCount: 0,
        });
    });
    it('shows a loading workspace without creating a fake project before a root is known', () => {
        const hierarchy = buildWorkspaceHierarchy([], null, '');
        expect(hierarchy.workspace).toMatchObject({
            name: 'Loading workspace',
            rootPath: '',
            taskCount: 0,
        });
        expect(hierarchy.projects).toEqual([]);
    });
    it('filters tasks by selected project scope', () => {
        const tasks = [
            task('workspace-task', 'running', {
                workspaceRoot: '/repo/ws',
                workspaceName: 'ws',
                effectiveProjectPath: '/repo/ws',
            }),
            task('project-a', 'running', {
                workspaceRoot: '/repo/ws',
                workspaceName: 'ws',
                projectName: 'app',
                sourceProjectPath: '/repo/ws/app',
                effectiveProjectPath: '/repo/ws/app',
            }),
            task('project-b', 'running', {
                workspaceRoot: '/repo/ws',
                workspaceName: 'ws',
                projectName: 'api',
                sourceProjectPath: '/repo/ws/api',
                effectiveProjectPath: '/repo/ws/api',
            }),
        ];
        const hierarchy = buildWorkspaceHierarchy(tasks, null, '/repo/ws');
        const appScope = hierarchy.projects.find((project) => project.name === 'app')?.key;
        expect(filterTasksByWorkspaceScope(tasks, 'workspace').map((entry) => entry.id)).toEqual([
            'workspace-task',
            'project-a',
            'project-b',
        ]);
        expect(appScope).toBeDefined();
        expect(filterTasksByWorkspaceScope(tasks, appScope).map((entry) => entry.id)).toEqual(['project-a']);
    });
    it('labels project-bound tasks by project and workspace-bound tasks by workspace', () => {
        expect(buildTaskBindingLabel({
            workspaceRoot: '/repo/ws',
            workspaceName: 'ws',
            effectiveProjectPath: '/repo/ws',
        })).toBe('ws workspace');
        expect(buildTaskBindingLabel({
            workspaceRoot: '/repo/ws',
            workspaceName: 'ws',
            projectName: 'app',
            effectiveProjectPath: '/repo/ws/app',
        })).toBe('app');
    });
});
//# sourceMappingURL=workspace-hierarchy.test.js.map