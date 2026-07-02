import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '@tik/kernel';
import { WorkbenchService } from '@tik/kernel';
import { WorkbenchStore } from '@tik/kernel';
import { buildTaskImporterFromCli } from '../src/tracker-importer.js';
const tempDirs = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('buildTaskImporterFromCli', () => {
    it('requires a workflow v2 definition when importing workbench tasks', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-cli-tracker-'));
        tempDirs.push(root);
        const workbench = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        expect(() => buildTaskImporterFromCli({
            workspaceRoot: root,
            workbench,
        })).toThrow(/Workflow v2 is required/i);
    });
    it('rejects Linear as a runtime tracker source for daemon commands', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-cli-tracker-'));
        tempDirs.push(root);
        const workbench = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        expect(() => buildTaskImporterFromCli({
            workspaceRoot: root,
            workflow: {
                version: 2,
                workflowConfigHash: 'config-hash',
                workflowPromptHash: 'prompt-hash',
                config: {
                    tracker: {
                        kind: 'linear',
                        activeStates: ['Todo'],
                        terminalStates: ['Done'],
                    },
                    polling: {
                        intervalMs: 30_000,
                        maxConcurrentAgents: 1,
                    },
                    workspace: {
                        root: '.tik/workspaces',
                        cleanupTerminal: false,
                        hooks: {
                            afterCreate: [],
                            beforeRun: [],
                            afterRun: [],
                            beforeRemove: [],
                        },
                    },
                    agent: {
                        timeoutMs: 1_000,
                    },
                },
                promptTemplate: 'Implement {{ task.shortIdentifier }}.',
                renderPrompt(task) {
                    return `Implement ${task.shortIdentifier}.`;
                },
                resolveRouting() {
                    return { runner: 'codex', mode: 'codex_app_server', matchedSource: 'default' };
                },
            },
            workbench,
        })).toThrow(/Linear runtime import is no longer supported/i);
    });
    it('uses workflow v2 workbench importing so environment review labels can be routed', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-cli-tracker-'));
        tempDirs.push(root);
        const workbench = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        await workbench.createTask({
            id: 'review-task',
            shortIdentifier: 'TIK-101',
            title: 'Review workspace changes',
            goal: 'Review the current worktree.',
            status: 'todo',
            labels: ['needs-claude-review'],
            environmentPackSnapshot: {
                id: 'base-engineering',
                name: 'Base Engineering',
                version: '0.1.0',
                taskLabels: [{
                        value: 'needs-claude-review',
                        label: 'Claude review',
                        action: 'claude_code_review',
                        description: 'Review with Claude Code.',
                        aliases: ['claude-review'],
                    }],
            },
        }, 'review-task');
        const importer = buildTaskImporterFromCli({
            workspaceRoot: root,
            workflow: {
                version: 2,
                config: {
                    tracker: {
                        kind: 'json',
                        activeStates: ['todo'],
                        terminalStates: ['completed'],
                    },
                    polling: {
                        intervalMs: 30_000,
                        maxConcurrentAgents: 1,
                    },
                    workspace: {
                        root: '.tik/workspaces',
                        cleanupTerminal: false,
                        hooks: {
                            afterCreate: [],
                            beforeRun: [],
                            afterRun: [],
                            beforeRemove: [],
                        },
                    },
                    agent: {
                        timeoutMs: 1_000,
                    },
                },
                promptTemplate: 'Review {{ task.shortIdentifier }}.',
                renderPrompt(task) {
                    return `Review ${task.shortIdentifier}.`;
                },
            },
            workbench,
        });
        await expect(importer.listCandidateTasks()).resolves.toEqual([
            expect.objectContaining({
                id: 'review-task',
                shortIdentifier: 'TIK-101',
                labels: ['needs-claude-review'],
            }),
        ]);
    });
});
//# sourceMappingURL=tracker-importer.test.js.map