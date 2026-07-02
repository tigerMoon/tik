import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeLLMProvider } from '../src/commands/claude-llm.js';
const tempDirs = [];
function buildProviderWithResponses(responses, calls = []) {
    const provider = new ClaudeLLMProvider('test-model');
    provider.client = {
        messages: {
            async create(params) {
                calls.push(params);
                const response = responses.shift();
                if (!response) {
                    throw new Error('Unexpected Claude test call');
                }
                return response;
            },
        },
    };
    return provider;
}
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('ClaudeLLMProvider.plan', () => {
    it('exposes only read-only tools while generating a plan', async () => {
        const calls = [];
        const provider = buildProviderWithResponses([
            {
                content: [{ type: 'text', text: 'Inspect the project and propose a safe implementation plan.' }],
                stop_reason: 'end_turn',
            },
        ], calls);
        await provider.plan('Task: inspect only', '{}');
        const toolNames = calls[0].tools.map((tool) => tool.name);
        expect(toolNames).toEqual([
            'read_file',
            'glob',
            'grep',
            'git_status',
            'git_diff',
            'git_log',
        ]);
        expect(toolNames).not.toContain('write_file');
        expect(toolNames).not.toContain('edit_file');
        expect(toolNames).not.toContain('bash');
    });
    it('does not execute mutating tool calls returned during plan generation', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-claude-plan-'));
        tempDirs.push(tempDir);
        const targetPath = path.join(tempDir, 'plan-should-not-write.txt');
        const calls = [];
        const provider = buildProviderWithResponses([
            {
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu-write',
                        name: 'write_file',
                        input: { path: targetPath, content: 'mutated during plan' },
                    },
                ],
                stop_reason: 'tool_use',
            },
            {
                content: [{ type: 'text', text: 'Plan safely without mutating files.' }],
                stop_reason: 'end_turn',
            },
        ], calls);
        const response = await provider.plan('Task: create a plan only', '{}');
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(response.actions).toContainEqual({
            tool: 'write_file',
            input: { path: targetPath, content: 'mutated during plan' },
            reason: 'Error: Tool write_file is not allowed during plan generation',
        });
        expect(calls[1].messages.at(-1).content[0]).toMatchObject({
            type: 'tool_result',
            tool_use_id: 'toolu-write',
            is_error: true,
        });
    });
    it('does not execute shell tool calls returned during plan generation', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-claude-plan-bash-'));
        tempDirs.push(tempDir);
        const targetPath = path.join(tempDir, 'plan-should-not-run-bash.txt');
        const provider = buildProviderWithResponses([
            {
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu-bash',
                        name: 'bash',
                        input: { command: `printf hacked > ${JSON.stringify(targetPath)}` },
                    },
                ],
                stop_reason: 'tool_use',
            },
            {
                content: [{ type: 'text', text: 'Plan safely without running shell commands.' }],
                stop_reason: 'end_turn',
            },
        ]);
        const response = await provider.plan('Task: create a plan only', '{}');
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(response.actions).toContainEqual({
            tool: 'bash',
            input: { command: `printf hacked > ${JSON.stringify(targetPath)}` },
            reason: 'Error: Tool bash is not allowed during plan generation',
        });
    });
    it('does not allow read_file to escape the planning cwd', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-claude-plan-path-'));
        tempDirs.push(tempDir);
        const workspaceRoot = path.join(tempDir, 'workspace');
        const outsideSecret = path.join(tempDir, 'secret.txt');
        await fs.mkdir(workspaceRoot, { recursive: true });
        await fs.writeFile(outsideSecret, 'super-secret-plan-data', 'utf-8');
        const calls = [];
        const provider = buildProviderWithResponses([
            {
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu-read-outside',
                        name: 'read_file',
                        input: { path: outsideSecret },
                    },
                ],
                stop_reason: 'tool_use',
            },
            {
                content: [{ type: 'text', text: 'Plan safely without leaking outside files.' }],
                stop_reason: 'end_turn',
            },
        ], calls);
        const response = await provider.plan('Task: inspect only', '{}', { cwd: workspaceRoot });
        expect(response.actions).toContainEqual({
            tool: 'read_file',
            input: { path: outsideSecret },
            reason: expect.stringMatching(/^Error: Refusing/),
        });
        const toolResult = calls[1].messages.at(-1).content[0];
        expect(toolResult).toMatchObject({
            type: 'tool_result',
            tool_use_id: 'toolu-read-outside',
            is_error: true,
        });
        expect(toolResult.content).not.toContain('super-secret-plan-data');
    });
    it('does not allow read_file to follow symlinks outside the planning cwd', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-claude-plan-symlink-'));
        tempDirs.push(tempDir);
        const workspaceRoot = path.join(tempDir, 'workspace');
        const outsideDir = path.join(tempDir, 'outside');
        await fs.mkdir(workspaceRoot, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'symlink-secret-plan-data', 'utf-8');
        await fs.symlink(outsideDir, path.join(workspaceRoot, 'linked-outside'));
        const calls = [];
        const provider = buildProviderWithResponses([
            {
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu-read-symlink',
                        name: 'read_file',
                        input: { path: 'linked-outside/secret.txt' },
                    },
                ],
                stop_reason: 'tool_use',
            },
            {
                content: [{ type: 'text', text: 'Plan safely without leaking symlinked files.' }],
                stop_reason: 'end_turn',
            },
        ], calls);
        const response = await provider.plan('Task: inspect only', '{}', { cwd: workspaceRoot });
        expect(response.actions).toContainEqual({
            tool: 'read_file',
            input: { path: 'linked-outside/secret.txt' },
            reason: expect.stringMatching(/^Error: Refusing/),
        });
        const toolResult = calls[1].messages.at(-1).content[0];
        expect(toolResult).toMatchObject({
            type: 'tool_result',
            tool_use_id: 'toolu-read-symlink',
            is_error: true,
        });
        expect(toolResult.content).not.toContain('symlink-secret-plan-data');
    });
});
//# sourceMappingURL=claude-llm.test.js.map