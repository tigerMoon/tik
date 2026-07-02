import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWhitelistedHookEnv, redactHookError, runTrackerHook, } from '../src/tracker-hooks.js';
const tempDirs = [];
const originalEnv = { ...process.env };
afterEach(async () => {
    process.env = { ...originalEnv };
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('tracker hooks', () => {
    it('passes Tik env plus PATH/HOME and explicit whitelist to v2 hooks', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-hook-'));
        tempDirs.push(root);
        const hooksDir = path.join(root, '.tik', 'hooks');
        await fs.mkdir(hooksDir, { recursive: true });
        const hookPath = path.join(hooksDir, 'capture-env.sh');
        const outputPath = path.join(root, 'env.txt');
        await fs.writeFile(hookPath, [
            '#!/bin/sh',
            'printf "%s|%s|%s|%s" "$PATH" "$HOME" "$SAFE_VALUE" "${SECRET_TOKEN-unset}" > "$TIK_TRACKER_PROJECT_PATH/env.txt"',
        ].join('\n'), 'utf-8');
        await fs.chmod(hookPath, 0o755);
        process.env.PATH = '/usr/bin:/bin';
        process.env.HOME = '/tmp/tik-home';
        process.env.SAFE_VALUE = 'safe';
        process.env.SECRET_TOKEN = 'secret';
        await runTrackerHook('.tik/hooks/capture-env.sh', {
            task: { id: 'task-1', shortIdentifier: 'TIK-1' },
            workspaceRoot: root,
            projectPath: root,
            envWhitelist: ['SAFE_VALUE'],
        });
        await expect(fs.readFile(outputPath, 'utf-8')).resolves.toBe('/usr/bin:/bin|/tmp/tik-home|safe|unset');
    });
    it('rejects v2 hook paths that resolve outside the workspace root', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-hook-'));
        tempDirs.push(root);
        const outsidePath = path.join(path.dirname(root), 'outside-hook.sh');
        await fs.writeFile(outsidePath, '#!/bin/sh\nexit 0\n', 'utf-8');
        await fs.chmod(outsidePath, 0o755);
        await expect(runTrackerHook('../outside-hook.sh', {
            task: { id: 'task-1', shortIdentifier: 'TIK-1' },
            workspaceRoot: root,
            projectPath: root,
            envWhitelist: [],
        })).rejects.toThrow(/outside the workspace root/i);
    });
    it('rejects v2 hook paths that follow symlinks outside the workspace root', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-hook-'));
        tempDirs.push(root);
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-hook-outside-'));
        tempDirs.push(outsideDir);
        const outsideHook = path.join(outsideDir, 'payload.sh');
        await fs.writeFile(outsideHook, '#!/bin/sh\nexit 0\n', 'utf-8');
        await fs.chmod(outsideHook, 0o755);
        await fs.symlink(outsideDir, path.join(root, 'linked-outside'));
        await expect(runTrackerHook('linked-outside/payload.sh', {
            task: { id: 'task-1', shortIdentifier: 'TIK-1' },
            workspaceRoot: root,
            projectPath: root,
            envWhitelist: [],
        })).rejects.toThrow(/outside the workspace root/i);
    });
    it('treats hook names as workflow v2 file paths instead of shell commands', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tracker-hook-'));
        tempDirs.push(root);
        process.env.SHELL_ONLY_VALUE = 'legacy-env';
        await expect(runTrackerHook('printf "%s:%s" "$TIK_TRACKER_TASK_ID" "$SHELL_ONLY_VALUE" > shell-output.txt', {
            task: { id: 'task-1', shortIdentifier: 'TIK-1' },
            workspaceRoot: root,
            projectPath: root,
            envWhitelist: [],
        })).rejects.toThrow(/Workflow v2 hook does not exist/i);
        await expect(fs.stat(path.join(root, 'shell-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('redacts sensitive env values while preserving useful execFile error fields', () => {
        const original = Object.assign(new Error('failed with SECRET_VALUE under /tmp/tik-home'), {
            stdout: 'stdout SECRET_VALUE /tmp/tik-home',
            stderr: 'stderr SECRET_VALUE /tmp/tik-home',
            cmd: 'hook SECRET_VALUE',
            code: 1,
        });
        const redacted = redactHookError(original, {
            SECRET_TOKEN: 'SECRET_VALUE',
            HOME: '/tmp/tik-home',
            PATH: '/usr/bin:/bin',
        });
        expect(redacted.message).toBe('failed with [REDACTED] under /tmp/tik-home');
        expect(redacted.stdout).toBe('stdout [REDACTED] /tmp/tik-home');
        expect(redacted.stderr).toBe('stderr [REDACTED] /tmp/tik-home');
        expect(redacted.cmd).toBe('hook [REDACTED]');
        expect(redacted.code).toBe(1);
    });
    it('builds default hook env without treating PATH/HOME as explicit secrets', () => {
        process.env.PATH = '/usr/bin:/bin';
        process.env.HOME = '/tmp/tik-home';
        process.env.SAFE_VALUE = 'safe';
        process.env.SECRET_TOKEN = 'secret';
        const env = buildWhitelistedHookEnv(['SAFE_VALUE'], {
            TIK_TRACKER_TASK_ID: 'task-1',
        });
        expect(env).toMatchObject({
            PATH: '/usr/bin:/bin',
            HOME: '/tmp/tik-home',
            SAFE_VALUE: 'safe',
            TIK_TRACKER_TASK_ID: 'task-1',
        });
        expect(env.SECRET_TOKEN).toBeUndefined();
    });
});
//# sourceMappingURL=tracker-hooks.test.js.map