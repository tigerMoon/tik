import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTrackerWorkflowV2Content, explainWorkflowTask, initWorkflowV2, validateWorkflow, } from '../src/workflow-command.js';
const tempDirs = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('workflow command helpers', () => {
    it('creates a workflow v2 file with validation and previous review template context', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-command-'));
        tempDirs.push(root);
        const result = await initWorkflowV2({ workspaceRoot: root, file: '.tik/WORKFLOW.md' });
        expect(result.created).toBe(true);
        expect(result.path).toBe(path.join(root, '.tik', 'WORKFLOW.md'));
        expect(await fs.readFile(result.path, 'utf-8')).toContain('version: 2');
        expect(result.content).toContain('validation:');
        expect(result.content).toContain('previousReview');
    });
    it('does not overwrite an existing workflow unless forced', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-command-'));
        tempDirs.push(root);
        await fs.writeFile(path.join(root, 'WORKFLOW.md'), 'custom workflow\n', 'utf-8');
        const result = await initWorkflowV2({ workspaceRoot: root });
        expect(result.created).toBe(false);
        expect(result.content).toBe('custom workflow\n');
        expect(await fs.readFile(path.join(root, 'WORKFLOW.md'), 'utf-8')).toBe('custom workflow\n');
    });
    it('validates workflow v2 and prints routing plus validation commands', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-command-'));
        tempDirs.push(root);
        await fs.writeFile(path.join(root, 'WORKFLOW.md'), defaultTrackerWorkflowV2Content(), 'utf-8');
        const output = await validateWorkflow({ workspaceRoot: root });
        expect(output).toContain('Version: 2');
        expect(output).toContain('Routing: codex codex_exec');
        expect(output).toContain('Validation: pnpm typecheck, pnpm test');
    });
    it('explains selected runner, project path, validation, and expected proof artifacts', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-command-'));
        tempDirs.push(root);
        await fs.writeFile(path.join(root, 'WORKFLOW.md'), defaultTrackerWorkflowV2Content(), 'utf-8');
        const output = await explainWorkflowTask({
            workspaceRoot: root,
            taskId: 'WB-123',
            task: {
                shortIdentifier: 'WB-123',
                title: 'Add cache',
                repository: {
                    executionPath: path.join(root, 'packages', 'service-b'),
                },
            },
        });
        expect(output).toContain('Task: WB-123 Add cache');
        expect(output).toContain('Selected runner: codex');
        expect(output).toContain('Mode: codex_exec');
        expect(output).toContain(`Project path: ${path.join(root, 'packages', 'service-b')}`);
        expect(output).toContain('  - pnpm typecheck');
        expect(output).toContain('  - run-review.md');
    });
});
//# sourceMappingURL=workflow-command.test.js.map