import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertRuntimeCwd, attachProcessLogs, buildRuntimeProcessEnv, childCompletion, } from './runtime-process.js';
import { collectGitDiffSummary, collectTranscriptFromRunLogs } from './runtime-collection.js';
export class ClaudeCodeRunner {
    name = 'claude-code';
    mode;
    executable;
    pluginDirs;
    addDirs;
    permissionMode;
    statuses = new Map();
    children = new Map();
    preparedRuns = new Map();
    spawnProcess;
    constructor(options = {}) {
        this.mode = options.mode;
        this.executable = options.executable || 'claude';
        this.pluginDirs = options.pluginDirs || splitPathList(process.env.TIK_CLAUDE_CODE_PLUGIN_DIRS);
        this.addDirs = options.addDirs || splitPathList(process.env.TIK_CLAUDE_CODE_ADD_DIRS);
        this.permissionMode = options.permissionMode || normalizePermissionMode(process.env.TIK_CLAUDE_CODE_PERMISSION_MODE) || 'dontAsk';
        this.spawnProcess = options.spawnProcess || ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    }
    async prepare(input) {
        const mode = normalizeClaudeMode(this.mode || input.runnerMode);
        const promptFile = await writePromptFile(input);
        return {
            runId: input.runId,
            runner: this.name,
            mode,
            cwd: input.worktreePath || input.projectPath,
            command: this.executable,
            args: buildClaudeArgs(mode, input.renderedPrompt, {
                pluginDirs: this.pluginDirs,
                addDirs: this.addDirs,
                permissionMode: this.permissionMode,
            }),
            promptFile,
            prompt: input.renderedPrompt,
            timeoutMs: input.timeoutMs,
        };
    }
    async start(input) {
        this.statuses.set(input.runId, 'running');
        this.preparedRuns.set(input.runId, input);
        await assertRuntimeCwd(input.cwd);
        const command = input.command || 'claude';
        const args = input.args || [];
        const child = this.spawnProcess(command, args, {
            cwd: input.cwd,
            env: buildRuntimeProcessEnv(input),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (input.prompt !== undefined) {
            child.stdin?.write(input.prompt);
            child.stdin?.end();
        }
        this.children.set(input.runId, child);
        const logAttachment = attachProcessLogs(input, child);
        const completion = childCompletion('claude-code', child, logAttachment.writers, (status) => {
            this.children.delete(input.runId);
            this.statuses.set(input.runId, status);
        }, input.timeoutMs);
        return {
            runId: input.runId,
            pid: child.pid,
            startedAt: new Date().toISOString(),
            completion,
            stop: (reason) => this.stop(input.runId, reason),
        };
    }
    async stop(runId, _reason) {
        this.statuses.set(runId, 'cancelled');
        const child = this.children.get(runId);
        this.children.delete(runId);
        child?.kill('SIGTERM');
    }
    async getStatus(runId) {
        return this.statuses.get(runId) || 'unknown';
    }
    async collectTranscript(_runId) {
        const prepared = this.preparedRuns.get(_runId);
        return prepared ? collectTranscriptFromRunLogs(prepared) : [];
    }
    async collectDiff(_runId) {
        const prepared = this.preparedRuns.get(_runId);
        return prepared ? collectGitDiffSummary(prepared) : { changedFiles: [] };
    }
    async collectArtifacts(_runId) {
        return [];
    }
    async cleanup(runId) {
        await this.stop(runId, 'cleanup');
    }
}
function normalizeClaudeMode(mode) {
    return mode === 'claude_hooked' ? 'claude_hooked' : 'claude_print';
}
function buildClaudeArgs(_mode, _prompt, options) {
    const printArgs = [
        '--print',
        '--permission-mode',
        options.permissionMode,
        '--output-format',
        'text',
        ...flatRepeat('--plugin-dir', options.pluginDirs || []),
        ...flatRepeat('--add-dir', options.addDirs || []),
    ];
    return printArgs;
}
function flatRepeat(flag, values) {
    return values.flatMap((value) => value ? [flag, value] : []);
}
function splitPathList(value) {
    return (value || '')
        .split(path.delimiter)
        .map((item) => item.trim())
        .filter(Boolean);
}
function normalizePermissionMode(value) {
    if (value === 'acceptEdits'
        || value === 'auto'
        || value === 'bypassPermissions'
        || value === 'default'
        || value === 'dontAsk'
        || value === 'plan') {
        return value;
    }
    return undefined;
}
async function writePromptFile(input) {
    const runDir = path.join(input.workspaceRoot, '.tik', 'runs', input.runId);
    await fs.mkdir(runDir, { recursive: true });
    const promptFile = path.join(runDir, 'prompt.md');
    await fs.writeFile(promptFile, input.renderedPrompt, 'utf-8');
    return promptFile;
}
//# sourceMappingURL=claude-code-runner.js.map