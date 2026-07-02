import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@tik/shared';
import { EventBus } from '../src/event-bus.js';
import { FileArtifactRegistry } from '../src/artifacts/artifact-registry.js';
import { TaskManager } from '../src/task-manager.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';
const tempDirs = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function readDecisionStatuses(root, taskId) {
    const indexPath = path.join(root, '.tik', 'workbench', 'index.json');
    const raw = await fs.readFile(indexPath, 'utf-8');
    const index = JSON.parse(raw);
    return index.decisions
        .filter((decision) => decision.taskId === taskId)
        .map((decision) => decision.status);
}
describe('WorkbenchService', () => {
    it('creates a summary timeline item from raw kernel events and requests decisions only for high-risk actions', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({ title: 'Audit auth flow', goal: 'Inspect and update auth behavior' });
        const task = (await service.listTasks())[0];
        eventBus.emit({
            id: 'evt-1',
            type: EventType.TASK_STARTED,
            taskId: task.id,
            payload: { status: 'executing', previousStatus: 'planning' },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-2',
            type: EventType.TOOL_RESULT,
            taskId: task.id,
            payload: { toolName: 'read_file', output: 'auth.ts', durationMs: 12, success: true },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-3',
            type: EventType.TOOL_CALLED,
            taskId: task.id,
            payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-4',
            type: EventType.TOOL_CALLED,
            taskId: task.id,
            payload: { toolName: 'read_file', toolType: 'read', input: { path: 'src/auth.ts' } },
            timestamp: Date.now(),
        });
        const timeline = await service.readTimeline(task.id);
        const decisions = await service.readPendingDecisions(task.id);
        expect(timeline.some((item) => item.kind === 'summary')).toBe(true);
        expect(decisions).toHaveLength(1);
        expect(decisions[0]?.title).toContain('High-risk action');
        expect(decisions[0]?.title).not.toContain('read_file');
    });
    it('records raw evidence entries for tool results so the task pane has inspectable output', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({
            rootPath: root,
            eventBus,
            store,
            artifacts: new FileArtifactRegistry({ rootPath: root }),
        });
        await service.createTask({ title: 'Snake game', goal: 'Build an H5 playable snake game' }, 'task-raw');
        await fs.writeFile(path.join(root, 'mock-app.html'), '<h1>Snake</h1>', 'utf-8');
        eventBus.emit({
            id: 'evt-raw-1',
            type: EventType.TOOL_RESULT,
            taskId: 'task-raw',
            payload: {
                toolName: 'write_file',
                output: 'Written 319 bytes',
                durationMs: 8,
                success: true,
                filesModified: [path.join(root, 'mock-app.html')],
            },
            timestamp: Date.now(),
        });
        const timeline = await service.readTimeline('task-raw');
        const rawItem = timeline.find((item) => item.kind === 'raw');
        const [task] = await service.listTasks();
        const artifacts = await service.listArtifacts({ taskId: 'task-raw' });
        expect(rawItem?.body).toContain('write_file');
        expect(rawItem?.body).toContain(path.join(root, 'mock-app.html'));
        expect(rawItem?.body).toContain('Written 319 bytes');
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]).toMatchObject({
            taskId: 'task-raw',
            status: 'previewable',
            sourceEventIds: ['evt-raw-1'],
        });
        expect(task?.evidenceSummary).toMatchObject({
            rawEventCount: 1,
            modifiedFileCount: 1,
            previewableArtifactCount: 1,
            latestPreviewableArtifactPath: path.join(root, 'mock-app.html'),
            latestPreviewableArtifactCreatedAt: expect.any(String),
            latestArtifactId: artifacts[0]?.id,
            latestArtifactVersionId: artifacts[0]?.latestVersionId,
            artifactCount: 1,
            needsReviewArtifactCount: 0,
            acceptedArtifactCount: 0,
            latestToolName: 'write_file',
            hasErrorEvidence: false,
        });
    });
    it('keeps completed tasks with review artifacts in review until the artifact is accepted', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({
            rootPath: root,
            eventBus,
            store,
            artifacts: new FileArtifactRegistry({ rootPath: root }),
        });
        await service.createTask({ title: 'Review gate', goal: 'Wait for artifact acceptance' }, 'task-review-gate');
        const artifact = await service.createArtifact({
            taskId: 'task-review-gate',
            title: 'Task Review: Review gate',
            kind: 'report',
            content: '# Review gate',
            contentType: 'text/markdown',
            extension: 'md',
            producedBy: { template: 'task-review' },
        });
        eventBus.emit({
            id: 'evt-review-gate-complete',
            type: EventType.TASK_COMPLETED,
            taskId: 'task-review-gate',
            payload: { status: 'completed' },
            timestamp: Date.now(),
        });
        const inReview = await service.readTask('task-review-gate');
        expect(inReview?.status).toBe('in_review');
        expect(inReview?.latestSummary).toContain('awaiting artifact acceptance');
        const accepted = await service.acceptArtifact(artifact.id, 'reviewer');
        expect(accepted.status).toBe('accepted');
        const completed = await service.readTask('task-review-gate');
        expect(completed?.status).toBe('completed');
        expect(completed?.latestSummary).toContain('accepted');
        await service.appendArtifactVersion({
            artifactId: artifact.id,
            content: '# Review gate v2',
            contentType: 'text/markdown',
            extension: 'md',
        });
        const afterNewVersion = await service.readTask('task-review-gate');
        expect(afterNewVersion?.status).toBe('in_review');
        await service.rejectArtifact(artifact.id, 'Needs stronger validation', 'reviewer');
        const rejected = await service.readTask('task-review-gate');
        expect(rejected?.status).toBe('retry');
        expect(rejected?.latestSummary).toContain('Needs stronger validation');
        expect(rejected?.comments?.at(-1)?.body).toContain('Needs stronger validation');
    });
    it('projects task evidence summaries for completed tasks so the queue can show acceptance signals', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({ title: 'Console polish', goal: 'Ship a previewable dashboard mock' }, 'task-summary');
        eventBus.emit({
            id: 'evt-summary-1',
            type: EventType.TOOL_RESULT,
            taskId: 'task-summary',
            payload: {
                toolName: 'write_file',
                output: 'Written 9012 bytes',
                durationMs: 14,
                success: true,
                filesModified: [
                    '/Users/huyuehui/ace/tik/src/console.html',
                    '/Users/huyuehui/ace/tik/src/styles.css',
                ],
            },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-summary-2',
            type: EventType.TASK_COMPLETED,
            taskId: 'task-summary',
            payload: { summary: 'Task completed' },
            timestamp: Date.now() + 1,
        });
        const task = await service.readTask('task-summary');
        expect(task?.status).toBe('completed');
        expect(task?.evidenceSummary).toEqual({
            rawEventCount: 1,
            modifiedFileCount: 2,
            previewableArtifactCount: 1,
            latestPreviewableArtifactPath: '/Users/huyuehui/ace/tik/src/console.html',
            latestPreviewableArtifactCreatedAt: expect.any(String),
            latestToolName: 'write_file',
            hasErrorEvidence: false,
        });
    });
    it('counts modified files from raw shell git status and diff evidence', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({ title: 'Align task list', goal: 'Fix dashboard alignment' }, 'task-git-evidence');
        eventBus.emit({
            id: 'evt-git-1',
            type: EventType.TOOL_RESULT,
            taskId: 'task-git-evidence',
            payload: {
                toolName: 'bash',
                output: [
                    ' M packages/dashboard/src/styles/workbench-inbox.css',
                    '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
                    'diff --git a/packages/dashboard/src/styles/workbench-inbox.css b/packages/dashboard/src/styles/workbench-inbox.css',
                    'index 123..456 100644',
                ].join('\n'),
                durationMs: 14,
                success: true,
            },
            timestamp: Date.now(),
        });
        const task = await service.readTask('task-git-evidence');
        expect(task?.evidenceSummary).toMatchObject({
            rawEventCount: 1,
            modifiedFileCount: 2,
            previewableArtifactCount: 0,
            latestToolName: 'bash',
            hasErrorEvidence: false,
        });
    });
    it('counts modified files from JSON bash stdout evidence', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({ title: 'Align task list', goal: 'Fix dashboard alignment' }, 'task-json-git-evidence');
        eventBus.emit({
            id: 'evt-json-git-1',
            type: EventType.TOOL_RESULT,
            taskId: 'task-json-git-evidence',
            payload: {
                toolName: 'bash',
                output: {
                    command: 'git status --short && git diff -- packages/dashboard/src/styles/workbench-inbox.css',
                    stdout: [
                        '/Users/huyuehui/ace/tik/.workspace/worktrees/tik-805562e6--tik-83',
                        ' M packages/dashboard/src/styles/workbench-inbox.css',
                        '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
                        'diff --git a/packages/dashboard/src/styles/workbench-inbox.css b/packages/dashboard/src/styles/workbench-inbox.css',
                    ].join('\n'),
                    exitCode: 0,
                },
                durationMs: 14,
                success: true,
            },
            timestamp: Date.now(),
        });
        const task = await service.readTask('task-json-git-evidence');
        expect(task?.evidenceSummary).toMatchObject({
            rawEventCount: 1,
            modifiedFileCount: 2,
            previewableArtifactCount: 0,
            latestToolName: 'bash',
            hasErrorEvidence: false,
        });
    });
    it('suppresses low-signal runtime noise and keeps operator-facing summaries concise', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({ title: 'Console audit', goal: 'Keep the task history readable' }, 'task-noise');
        eventBus.emit({
            id: 'evt-noise-1',
            type: EventType.SESSION_MESSAGE,
            taskId: 'task-noise',
            payload: { role: 'assistant', content: 'thinking' },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-noise-2',
            type: EventType.PLAN_GENERATED,
            taskId: 'task-noise',
            payload: {
                goals: ['Produce a reviewable artifact'],
                actionCount: 2,
            },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-noise-3',
            type: EventType.EVALUATION_STARTED,
            taskId: 'task-noise',
            payload: { iteration: 1 },
            timestamp: Date.now(),
        });
        const timeline = await service.readTimeline('task-noise');
        const summaryBodies = timeline
            .filter((item) => item.kind === 'summary')
            .map((item) => item.body);
        expect(summaryBodies).toEqual([
            'Supervisor drafted the next pass: Produce a reviewable artifact (2 planned actions).',
        ]);
    });
    it('updates the active session to the runtime session when the kernel opens one', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const primedTask = await service.createTask({ title: 'Audit auth flow', goal: 'Inspect and update auth behavior' }, 'task-1');
        eventBus.emit({
            id: 'evt-session',
            type: EventType.SESSION_STARTED,
            taskId: primedTask.id,
            payload: { sessionId: 'session-real', mode: 'single', agents: ['planner'], currentAgent: 'planner' },
            timestamp: Date.now(),
        });
        const tasks = await service.listTasks();
        expect(tasks[0]?.activeSessionId).toBe('session-real');
    });
    it('persists the task-bound environment pack snapshot on create and task-created hydration', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const taskManager = new TaskManager(eventBus);
        await service.createTask({
            title: 'Implement checkout flow',
            goal: 'Ship the checkout flow',
            environmentPackSnapshot: {
                id: 'commerce-ops',
                name: 'Commerce Ops',
                version: '0.2.0',
            },
            environmentPackSelection: {
                selectedSkills: ['release-review'],
                selectedKnowledgeIds: ['operations-runbook'],
            },
        }, 'task-manual');
        taskManager.create({
            description: 'Hydrate imported task',
            environmentPackSnapshot: {
                id: 'base-engineering',
                name: 'Base Engineering',
                version: '0.1.0',
            },
            environmentPackSelection: {
                selectedSkills: ['coder'],
                selectedKnowledgeIds: ['repo-index'],
            },
        });
        const tasks = await service.listTasks();
        expect(tasks.find((task) => task.id === 'task-manual')?.environmentPackSnapshot?.id).toBe('commerce-ops');
        expect(tasks.find((task) => task.id === 'task-manual')?.environmentPackSelection).toEqual({
            selectedSkills: ['release-review'],
            selectedKnowledgeIds: ['operations-runbook'],
        });
        expect(tasks.find((task) => task.title === 'Hydrate imported task')?.environmentPackSnapshot?.id).toBe('base-engineering');
        expect(tasks.find((task) => task.title === 'Hydrate imported task')?.environmentPackSelection).toEqual({
            selectedSkills: ['coder'],
            selectedKnowledgeIds: ['repo-index'],
        });
    });
    it('updates task-level environment pack skill and knowledge selections', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Configure runtime',
            goal: 'Narrow the task capabilities',
            environmentPackSnapshot: {
                id: 'design-to-code',
                name: 'Design To Code',
                version: '0.1.0',
            },
            environmentPackSelection: {
                selectedSkills: ['figma-to-react', 'ui-review'],
                selectedKnowledgeIds: ['design-system', 'ui-guidelines'],
            },
        }, 'task-config');
        const updated = await service.updateTaskConfiguration('task-config', {
            selectedSkills: ['ui-review'],
            selectedKnowledgeIds: ['ui-guidelines'],
        });
        expect(updated?.environmentPackSelection).toEqual({
            selectedSkills: ['ui-review'],
            selectedKnowledgeIds: ['ui-guidelines'],
        });
        const timeline = await service.readTimeline('task-config');
        expect(timeline.some((item) => item.body.includes('Updated task configuration'))).toBe(true);
    });
    it('persists tracker fields and appends execution runs on the unified workbench task record', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const task = await service.createTask({
            id: 'linear-task-id',
            shortIdentifier: 'TIK-42',
            title: 'Ship daemon',
            description: 'Build the tracker daemon.',
            goal: 'Ship a daemon that launches workbench tasks.',
            state: 'Todo',
            priority: 1,
            labels: ['backend', 'orchestration'],
            blockedBy: [{ id: 'dep-1', shortIdentifier: 'TIK-1', state: 'Done' }],
            assignee: 'codex',
            createdBy: 'linear',
            sourceUrl: 'https://linear.app/acme/issue/TIK-42',
        });
        const withRun = await service.appendTaskRun(task.id, {
            runId: 'run-1',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:05:00.000Z',
            status: 'completed',
            kernelTaskId: 'kernel-task-1',
            agentName: 'codex',
            turnCount: 3,
        });
        expect(withRun?.id).toBe('linear-task-id');
        expect(withRun).toMatchObject({
            shortIdentifier: 'TIK-42',
            title: 'Ship daemon',
            description: 'Build the tracker daemon.',
            goal: 'Ship a daemon that launches workbench tasks.',
            state: 'Todo',
            priority: 1,
            labels: ['backend', 'orchestration'],
            blockedBy: [{ id: 'dep-1', shortIdentifier: 'TIK-1', state: 'Done' }],
            assignee: 'codex',
            createdBy: 'linear',
            sourceUrl: 'https://linear.app/acme/issue/TIK-42',
        });
        expect(withRun?.runs).toEqual([
            {
                runId: 'run-1',
                startedAt: '2026-01-01T00:00:00.000Z',
                endedAt: '2026-01-01T00:05:00.000Z',
                status: 'completed',
                kernelTaskId: 'kernel-task-1',
                agentName: 'codex',
                turnCount: 3,
            },
        ]);
        const reloaded = await service.readTask('linear-task-id');
        expect(reloaded?.runs?.[0]?.kernelTaskId).toBe('kernel-task-1');
    });
    it('transitions tracker task state through the allowed workflow and records an audit timeline', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const task = await service.createTask({
            title: 'Implement tracker task',
            goal: 'Move through the tracker state machine',
            status: 'backlog',
        }, 'task-transition');
        expect(task.status).toBe('backlog');
        const todo = await service.transitionTask(task.id, 'todo', {
            actor: 'human',
            reason: 'Ready to dispatch',
        });
        const inProgress = await service.transitionTask(task.id, 'in_progress', {
            actor: 'daemon',
            reason: 'Dispatch attempt 1',
        });
        const completed = await service.transitionTask(task.id, 'completed', {
            actor: 'agent',
            reason: 'Agent reported completion',
        });
        expect(todo?.status).toBe('todo');
        expect(inProgress?.status).toBe('in_progress');
        expect(completed?.status).toBe('completed');
        expect(completed?.latestSummary).toContain('completed');
        const timeline = await service.readTimeline(task.id);
        expect(timeline.map((item) => item.body)).toEqual(expect.arrayContaining([
            expect.stringContaining('Ready to dispatch'),
            expect.stringContaining('Dispatch attempt 1'),
            expect.stringContaining('Agent reported completion'),
        ]));
    });
    it('rejects illegal tracker transitions with a typed code', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        await service.createTask({
            title: 'Illegal transition',
            goal: 'Cannot jump directly from backlog to completed',
            status: 'backlog',
        }, 'task-illegal-transition');
        await expect(service.transitionTask('task-illegal-transition', 'completed')).rejects.toMatchObject({
            code: 'transition_not_allowed',
        });
    });
    it('tracks attempts, comments, labels, and dependencies on the same task record', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        await service.createTask({ title: 'Dependency', goal: 'Finish first', status: 'todo' }, 'task-dep');
        await service.createTask({ title: 'Main', goal: 'Run with metadata', status: 'todo' }, 'task-main');
        const withDependency = await service.setTaskDependencies('task-main', { add: ['task-dep'] });
        const attempt = await service.appendAttempt('task-main', {
            kernelTaskId: 'kernel-task-1',
            startedAt: '2026-04-09T00:00:00.000Z',
            turnCount: 2,
        });
        const finished = await service.finishAttempt('task-main', attempt.attemptNumber, 'failed', 'boom');
        const labels = await service.setLabels('task-main', { add: ['Backend', 'P0'], remove: ['missing'] });
        const comment = await service.addComment('task-main', {
            authorKind: 'human',
            authorId: 'huyuehui',
            body: 'Please retry with smaller scope.',
        });
        expect(withDependency?.blockedByTaskIds).toEqual(['task-dep']);
        expect(withDependency?.blockedBy?.[0]).toMatchObject({
            id: 'task-dep',
            shortIdentifier: expect.stringMatching(/^TIK-/),
            state: 'todo',
        });
        expect(attempt.attemptNumber).toBe(1);
        expect(finished?.attempts?.[0]).toMatchObject({
            attemptNumber: 1,
            kernelTaskId: 'kernel-task-1',
            outcome: 'failed',
            error: 'boom',
        });
        expect(labels?.labels).toEqual(['backend', 'p0']);
        expect(comment?.comments?.[0]).toMatchObject({
            authorKind: 'human',
            authorId: 'huyuehui',
            body: 'Please retry with smaller scope.',
        });
    });
    it('assigns a stable TIK identifier when creating a task without tracker metadata', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        const created = await service.createTask({
            title: 'Fresh task',
            goal: 'Needs a stable task identifier immediately',
            status: 'todo',
        }, 'task-fresh');
        expect(created.identifier).toBe('TIK-1');
        expect(created.shortIdentifier).toBe('TIK-1');
    });
    it('stops the active kernel task and closes the attempt when a running task is cancelled manually', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const stopped = [];
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
            stopTask: (taskId, reason) => {
                stopped.push({ taskId, reason });
            },
        });
        await service.createTask({ title: 'Cancelable', goal: 'Stop when user cancels', status: 'in_progress' }, 'task-cancel');
        await service.appendAttempt('task-cancel', {
            kernelTaskId: 'kernel-task-cancel-1',
            startedAt: '2026-04-09T00:00:00.000Z',
        });
        const cancelled = await service.transitionTask('task-cancel', 'cancelled', {
            actor: 'human',
            reason: 'No longer needed',
        });
        expect(stopped).toEqual([
            { taskId: 'kernel-task-cancel-1', reason: 'No longer needed' },
        ]);
        expect(cancelled?.attempts?.[0]).toMatchObject({
            kernelTaskId: 'kernel-task-cancel-1',
            outcome: 'cancelled',
            error: 'No longer needed',
        });
        expect(cancelled?.attempts?.[0]?.finishedAt).toBeTruthy();
    });
    it('dismisses pending decisions and archives pending review artifacts when a task is cancelled manually', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
            artifacts: new FileArtifactRegistry({ rootPath: root }),
        });
        await service.createTask({ title: 'Cancel cleanup', goal: 'Leave no actionable review residue' }, 'task-cancel-cleanup');
        const decision = await service.requestToolApproval('task-cancel-cleanup', 'bash');
        const artifact = await service.createArtifact({
            taskId: 'task-cancel-cleanup',
            title: 'Run Review: cancel cleanup',
            kind: 'run_review',
            content: '# Review',
            contentType: 'text/markdown',
            extension: 'md',
            tags: ['run-review'],
        });
        const cancelled = await service.transitionTask('task-cancel-cleanup', 'cancelled', {
            actor: 'human',
            reason: 'No longer needed',
        });
        expect(cancelled?.status).toBe('cancelled');
        expect(cancelled?.waitingReason).toBeUndefined();
        expect(cancelled?.waitingDecisionId).toBeUndefined();
        expect(await service.readPendingDecisions('task-cancel-cleanup')).toHaveLength(0);
        expect(await readDecisionStatuses(root, 'task-cancel-cleanup')).toContain('dismissed');
        expect(await service.readDecision(decision.id)).toMatchObject({ status: 'dismissed' });
        expect(await service.readArtifact(artifact.id)).toMatchObject({ status: 'archived' });
    });
    it('does not reactivate cancelled tasks when stale review artifacts are accepted or rejected', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
            artifacts: new FileArtifactRegistry({ rootPath: root }),
        });
        await service.createTask({ title: 'Accept after cancel', goal: 'Stay cancelled', status: 'needs_review' }, 'task-cancel-accept');
        const acceptArtifact = await service.createArtifact({
            taskId: 'task-cancel-accept',
            title: 'Run Review: accept after cancel',
            kind: 'run_review',
            content: '# Review',
            contentType: 'text/markdown',
            extension: 'md',
            tags: ['run-review'],
        });
        await service.transitionTask('task-cancel-accept', 'cancelled', { actor: 'human' });
        await service.acceptArtifact(acceptArtifact.id, 'reviewer');
        expect((await service.readTask('task-cancel-accept'))?.status).toBe('cancelled');
        await service.createTask({ title: 'Reject after cancel', goal: 'Stay cancelled', status: 'needs_review' }, 'task-cancel-reject');
        const rejectArtifact = await service.createArtifact({
            taskId: 'task-cancel-reject',
            title: 'Run Review: reject after cancel',
            kind: 'run_review',
            content: '# Review',
            contentType: 'text/markdown',
            extension: 'md',
            tags: ['run-review'],
        });
        await service.transitionTask('task-cancel-reject', 'cancelled', { actor: 'human' });
        await service.rejectArtifact(rejectArtifact.id, 'No longer relevant', 'reviewer');
        expect((await service.readTask('task-cancel-reject'))?.status).toBe('cancelled');
    });
    it('prevents dependency cycles between task blockers', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const service = new WorkbenchService({
            rootPath: root,
            eventBus: new EventBus(),
            store: new WorkbenchStore(root),
        });
        await service.createTask({ title: 'One', goal: 'First', status: 'todo' }, 'task-one');
        await service.createTask({ title: 'Two', goal: 'Second', status: 'todo' }, 'task-two');
        await service.setTaskDependencies('task-one', { add: ['task-two'] });
        await expect(service.setTaskDependencies('task-two', { add: ['task-one'] })).rejects.toMatchObject({
            code: 'dependency_cycle',
        });
    });
    it('rebinds a task to a different environment pack when configuration changes packs', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Retarget runtime',
            goal: 'Switch this task into another execution pack',
            environmentPackSnapshot: {
                id: 'base-engineering',
                name: 'Base Engineering',
                version: '0.1.0',
            },
            environmentPackSelection: {
                selectedSkills: ['coder'],
                selectedKnowledgeIds: ['repo-index'],
            },
        }, 'task-rebind');
        const updated = await service.updateTaskConfiguration('task-rebind', {
            selectedSkills: ['figma-to-react'],
            selectedKnowledgeIds: ['design-system'],
        }, {
            id: 'design-to-code',
            name: 'Design To Code',
            version: '0.1.0',
        });
        expect(updated?.environmentPackSnapshot).toEqual({
            id: 'design-to-code',
            name: 'Design To Code',
            version: '0.1.0',
        });
        expect(updated?.environmentPackSelection).toEqual({
            selectedSkills: ['figma-to-react'],
            selectedKnowledgeIds: ['design-system'],
        });
        expect(updated?.latestSummary).toContain('Rebound task to design-to-code');
    });
    it('updates the task brief and records the operator adjustment in the timeline', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Snake game',
            goal: 'Build a playable snake game',
        }, 'task-brief');
        const updated = await service.updateTaskBrief('task-brief', {
            title: 'Snake game console',
            goal: 'Build a playable snake game with a clear score panel',
            adjustment: 'Focus on keyboard play and a visible restart action.',
        });
        expect(updated?.title).toBe('Snake game console');
        expect(updated?.goal).toContain('clear score panel');
        expect(updated?.latestSummary).toContain('Operator adjusted');
        const timeline = await service.readTimeline('task-brief');
        const operatorEntry = timeline.find((item) => item.actor === 'user');
        expect(operatorEntry?.body).toContain('Adjusted task brief');
        expect(operatorEntry?.body).toContain('Focus on keyboard play');
    });
    it('reverts the last task adjustment and restores the prior title and brief', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Original brief',
            goal: 'Ship the original scope',
        }, 'task-revert');
        await service.updateTaskBrief('task-revert', {
            title: 'Adjusted brief',
            goal: 'Ship the adjusted scope',
            adjustment: 'Tighten the work around a previewable artifact.',
        });
        const reverted = await service.revertLastTaskAdjustment('task-revert');
        expect(reverted?.title).toBe('Original brief');
        expect(reverted?.goal).toBe('Ship the original scope');
        expect(reverted?.lastAdjustment).toBeUndefined();
        const timeline = await service.readTimeline('task-revert');
        expect(timeline.some((item) => item.body.includes('Reverted latest task adjustment.'))).toBe(true);
    });
    it('can force-archive a stale running task when the runtime record is gone', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const task = await service.createTask({
            title: 'Stale running task',
            goal: 'Clean up an orphaned runtime record',
        }, 'task-stale');
        await store.upsertTask({
            ...task,
            status: 'running',
            updatedAt: '2026-04-09T00:00:01.000Z',
            lastProgressAt: '2026-04-09T00:00:01.000Z',
            latestSummary: 'Supervisor observed event iteration.completed.',
        });
        await expect(service.archiveTask('task-stale')).rejects.toThrow('cannot be archived');
        const archived = await service.archiveTask('task-stale', { force: true });
        expect(archived?.status).toBe('archived');
        expect(archived?.latestSummary).toContain('runtime record went missing');
        const timeline = await service.readTimeline('task-stale');
        expect(timeline.some((item) => item.body.includes('runtime record went missing'))).toBe(true);
    });
    it('requests and resolves a high-risk tool approval through the workbench service', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Publish dry-run',
            goal: 'Validate the operator approval loop',
        }, 'task-decision');
        const decision = await service.requestToolApproval('task-decision', 'bash');
        expect(decision?.status).toBe('pending');
        const pendingTask = await service.readTask('task-decision');
        expect(pendingTask?.status).toBe('waiting_for_user');
        expect(pendingTask?.waitingDecisionId).toBe(decision?.id);
        const waitPromise = service.waitForDecisionResolution(decision.id, { pollMs: 10, timeoutMs: 1000 });
        await service.resolveDecision('task-decision', decision.id, {
            optionId: 'approve',
            message: 'Proceed with the publish dry-run.',
        });
        const resolution = await waitPromise;
        expect(resolution.approved).toBe(true);
        const resolvedTask = await service.readTask('task-decision');
        expect(resolvedTask?.status).toBe('running');
        expect(resolvedTask?.waitingDecisionId).toBeUndefined();
        const timeline = await service.readTimeline('task-decision');
        expect(timeline.some((item) => item.body.includes('Approved decision: High-risk action: bash'))).toBe(true);
    });
    it('projects tasks with pending decisions back into waiting_for_user even if a later runtime event stored them as running', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Publish dry-run',
            goal: 'Validate projected waiting state',
        }, 'task-projected-wait');
        const decision = await service.requestToolApproval('task-projected-wait', 'bash');
        expect(decision?.status).toBe('pending');
        await store.upsertTask({
            ...(await service.readTask('task-projected-wait')),
            status: 'running',
            waitingReason: undefined,
            waitingDecisionId: undefined,
            latestSummary: 'Supervisor resumed task execution.',
            updatedAt: '2026-04-09T00:00:01.000Z',
            lastProgressAt: '2026-04-09T00:00:01.000Z',
        });
        const projected = await service.readTask('task-projected-wait');
        expect(projected?.status).toBe('waiting_for_user');
        expect(projected?.waitingDecisionId).toBe(decision?.id);
        expect(projected?.waitingReason).toContain('bash');
        expect(projected?.latestSummary).toContain('Waiting for operator approval');
    });
    it('hydrates workbench tasks from the kernel task event path and records timeline summaries and decisions', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const taskManager = new TaskManager(eventBus);
        const task = taskManager.create({ description: 'Audit auth flow' });
        eventBus.emit({
            id: 'evt-5',
            type: EventType.TOOL_CALLED,
            taskId: task.id,
            payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
            timestamp: Date.now(),
        });
        const tasks = await service.listTasks();
        const timeline = await service.readTimeline(task.id);
        const decisions = await service.readPendingDecisions(task.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.id).toBe(task.id);
        expect(tasks[0]?.title).toBe('Audit auth flow');
        expect(timeline.some((item) => item.kind === 'summary')).toBe(true);
        expect(decisions).toHaveLength(1);
    });
    it('keeps waiting metadata while a pending decision receives non-terminal runtime events', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const taskManager = new TaskManager(eventBus);
        const task = taskManager.create({ description: 'Audit auth flow' });
        eventBus.emit({
            id: 'evt-6',
            type: EventType.TOOL_CALLED,
            taskId: task.id,
            payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
            timestamp: Date.now(),
        });
        let tasks = await service.listTasks();
        expect(tasks[0]?.status).toBe('waiting_for_user');
        expect(tasks[0]?.waitingReason).toContain('git_commit');
        expect(tasks[0]?.waitingDecisionId).toBeTruthy();
        eventBus.emit({
            id: 'evt-7',
            type: EventType.TASK_STARTED,
            taskId: task.id,
            payload: { status: 'executing', previousStatus: 'planning' },
            timestamp: Date.now(),
        });
        tasks = await service.listTasks();
        const decisions = await service.readPendingDecisions(task.id);
        const decisionStatuses = await readDecisionStatuses(root, task.id);
        expect(tasks[0]?.status).toBe('waiting_for_user');
        expect(tasks[0]?.waitingReason).toContain('git_commit');
        expect(tasks[0]?.waitingDecisionId).toBeTruthy();
        expect(decisions).toHaveLength(1);
        expect(decisionStatuses).toContain('pending');
        expect(decisionStatuses).not.toContain('dismissed');
        expect(decisionStatuses).not.toContain('resolved');
    });
    it('dismisses the waiting decision when a waiting task is cancelled', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const taskManager = new TaskManager(eventBus);
        const task = taskManager.create({ description: 'Audit auth flow' });
        eventBus.emit({
            id: 'evt-8',
            type: EventType.TOOL_CALLED,
            taskId: task.id,
            payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-9',
            type: EventType.TASK_CANCELLED,
            taskId: task.id,
            payload: { status: 'cancelled', previousStatus: 'planning' },
            timestamp: Date.now(),
        });
        const tasks = await service.listTasks();
        const decisions = await service.readPendingDecisions(task.id);
        const decisionStatuses = await readDecisionStatuses(root, task.id);
        expect(tasks[0]?.status).toBe('cancelled');
        expect(tasks[0]?.waitingReason).toBeUndefined();
        expect(tasks[0]?.waitingDecisionId).toBeUndefined();
        expect(decisions).toHaveLength(0);
        expect(decisionStatuses).toContain('dismissed');
        expect(decisionStatuses).not.toContain('resolved');
    });
    it('dismisses the waiting decision when a high-risk tool errors after requesting approval', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        const taskManager = new TaskManager(eventBus);
        const task = taskManager.create({ description: 'Audit auth flow' });
        eventBus.emit({
            id: 'evt-10',
            type: EventType.TOOL_CALLED,
            taskId: task.id,
            payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-11',
            type: EventType.TOOL_ERROR,
            taskId: task.id,
            payload: { toolName: 'git_commit', error: 'commit failed', success: false },
            timestamp: Date.now(),
        });
        const tasks = await service.listTasks();
        const decisions = await service.readPendingDecisions(task.id);
        const decisionStatuses = await readDecisionStatuses(root, task.id);
        expect(tasks[0]?.status).not.toBe('waiting_for_user');
        expect(tasks[0]?.waitingReason).toBeUndefined();
        expect(tasks[0]?.waitingDecisionId).toBeUndefined();
        expect(decisions).toHaveLength(0);
        expect(decisionStatuses).toContain('dismissed');
        expect(decisionStatuses).not.toContain('resolved');
    });
    it('keeps workbench status paused until an explicit resume or terminal event arrives', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({ title: 'Pause drift', goal: 'Ensure paused state is sticky' }, 'task-pause');
        eventBus.emit({
            id: 'evt-pause-1',
            type: EventType.TASK_PAUSED,
            taskId: 'task-pause',
            payload: { status: 'paused', previousStatus: 'executing' },
            timestamp: Date.now(),
        });
        eventBus.emit({
            id: 'evt-pause-2',
            type: EventType.EVALUATION_STARTED,
            taskId: 'task-pause',
            payload: { iteration: 1 },
            timestamp: Date.now(),
        });
        let task = await service.readTask('task-pause');
        expect(task?.status).toBe('paused');
        eventBus.emit({
            id: 'evt-pause-3',
            type: EventType.TASK_RESUMED,
            taskId: 'task-pause',
            payload: { status: 'executing', previousStatus: 'paused' },
            timestamp: Date.now(),
        });
        task = await service.readTask('task-pause');
        expect(task?.status).toBe('running');
    });
    it('ignores late runtime events after a task has been archived so terminal tasks stay frozen', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const eventBus = new EventBus();
        const store = new WorkbenchStore(root);
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'Frozen archive',
            goal: 'Do not let late runtime events revive an archived task',
        }, 'task-frozen');
        await service.archiveTask('task-frozen');
        eventBus.emit({
            id: 'evt-late-tool-error',
            type: EventType.TOOL_ERROR,
            taskId: 'task-frozen',
            payload: {
                toolName: 'bash',
                error: 'late error from stale runtime',
                success: false,
            },
            timestamp: Date.now(),
        });
        const task = await service.readTask('task-frozen');
        const timeline = await service.readTimeline('task-frozen');
        expect(task?.status).toBe('archived');
        expect(task?.latestSummary).toBe('Task archived from the active work queue.');
        expect(timeline.some((item) => item.body.includes('late error from stale runtime'))).toBe(false);
    });
    it('fires a slash-command transition when a human comment includes /done from a legal source state', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'slash command target',
            goal: 'Test /done from in_progress',
            status: 'in_progress',
        }, 'task-slash-done');
        const result = await service.addComment('task-slash-done', {
            authorKind: 'human',
            authorId: 'huyuehui',
            body: '/done',
        });
        expect(result?.status).toBe('completed');
        expect(result?.comments?.[0]?.body).toBe('/done');
        const timeline = await service.readTimeline('task-slash-done');
        const bodies = timeline.map((item) => item.body);
        expect(bodies.some((b) => b.includes('Comment added:'))).toBe(true);
        expect(bodies.some((b) => b.includes('Task state changed: in_progress -> completed'))).toBe(true);
        expect(bodies.some((b) => b.includes('Marked done via comment by huyuehui'))).toBe(true);
    });
    it('reopens a completed task when a plain human comment requests follow-up work', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'completed tracker task',
            goal: 'Accept follow-up comments as tracker work',
            status: 'completed',
        }, 'task-comment-follow-up');
        const result = await service.addComment('task-comment-follow-up', {
            authorKind: 'human',
            authorId: 'huyuehui',
            body: '创建mr 并合并到 master',
            createdAt: '2026-06-18T07:01:51.367Z',
        });
        expect(result?.status).toBe('todo');
        expect(result?.latestSummary).toBe('Task transitioned to todo: Human comment requested a follow-up run.');
        expect(result?.comments?.[0]).toMatchObject({
            authorKind: 'human',
            authorId: 'huyuehui',
            body: '创建mr 并合并到 master',
        });
        const timeline = await service.readTimeline('task-comment-follow-up');
        const bodies = timeline.map((item) => item.body);
        expect(bodies.some((b) => b.includes('Comment added:'))).toBe(true);
        expect(bodies.some((b) => b.includes('Task state changed: completed -> todo'))).toBe(true);
        expect(bodies.some((b) => b.includes('Human comment requested a follow-up run.'))).toBe(true);
    });
    it('does not fire a transition when a slash command appears in an agent comment', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'agent comment',
            goal: 'agents must not self-transition',
            status: 'in_progress',
        }, 'task-agent-comment');
        const result = await service.addComment('task-agent-comment', {
            authorKind: 'agent',
            authorId: 'supervisor',
            body: '/done',
        });
        expect(result?.status).toBe('in_progress');
        expect(result?.comments?.[0]?.authorKind).toBe('agent');
    });
    it('treats a slash command targeting an illegal transition as a no-op (comment still saves)', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
        tempDirs.push(root);
        const store = new WorkbenchStore(root);
        const eventBus = new EventBus();
        const service = new WorkbenchService({ rootPath: root, eventBus, store });
        await service.createTask({
            title: 'illegal transition',
            goal: '/done from backlog is not allowed',
            status: 'backlog',
        }, 'task-illegal');
        const result = await service.addComment('task-illegal', {
            authorKind: 'human',
            authorId: 'huyuehui',
            body: '/done',
        });
        expect(result?.status).toBe('backlog');
        expect(result?.comments?.[0]?.body).toBe('/done');
    });
});
//# sourceMappingURL=workbench-service.test.js.map