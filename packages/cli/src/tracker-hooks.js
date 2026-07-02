import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const DEFAULT_HOOK_ENV_KEYS = ['PATH', 'HOME'];
export async function runTrackerHook(name, input) {
    const tikEnv = {
        TIK_TRACKER_TASK_ID: input.task.id,
        TIK_TRACKER_TASK_IDENTIFIER: input.task.shortIdentifier,
        TIK_TRACKER_ISSUE_ID: input.task.id,
        TIK_TRACKER_ISSUE_IDENTIFIER: input.task.shortIdentifier,
        TIK_TRACKER_WORKSPACE_ROOT: input.workspaceRoot,
        TIK_TRACKER_PROJECT_PATH: input.projectPath,
    };
    const env = buildWhitelistedHookEnv(input.envWhitelist || [], tikEnv);
    try {
        await execFileAsync(await resolveWorkflowV2HookPath(input.workspaceRoot, name), [], {
            cwd: input.projectPath,
            env,
        });
    }
    catch (error) {
        throw redactHookError(error, env);
    }
}
export function buildWhitelistedHookEnv(whitelist, tikEnv) {
    const env = { ...tikEnv };
    for (const key of DEFAULT_HOOK_ENV_KEYS) {
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    }
    for (const key of whitelist) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    }
    return env;
}
export function redactHookError(error, env) {
    const original = error instanceof Error ? error : new Error(String(error));
    const redact = buildRedactor(env);
    const redacted = new Error(redact(original.message) || 'Tracker hook failed.');
    redacted.name = original.name;
    redacted.stack = redact(original.stack);
    redacted.stdout = redactField(original.stdout, redact);
    redacted.stderr = redactField(original.stderr, redact);
    redacted.cmd = redact(original.cmd);
    redacted.code = original.code;
    return redacted;
}
function redactField(value, redact) {
    if (value === undefined)
        return undefined;
    if (Buffer.isBuffer(value))
        return Buffer.from(redact(value.toString('utf-8')) || '');
    return redact(value);
}
async function resolveWorkflowV2HookPath(workspaceRoot, hookName) {
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, hookName);
    if (!isWithin(root, resolved)) {
        throw new Error(`Workflow v2 hook resolves outside the workspace root: ${hookName}`);
    }
    const realRoot = await fs.realpath(root);
    const realResolved = await fs.realpath(resolved).catch((error) => {
        if (error.code === 'ENOENT') {
            throw new Error(`Workflow v2 hook does not exist: ${hookName}`);
        }
        throw error;
    });
    if (!isWithin(realRoot, realResolved)) {
        throw new Error(`Workflow v2 hook resolves outside the workspace root: ${hookName}`);
    }
    return realResolved;
}
function buildRedactor(env) {
    const secrets = Object.entries(env)
        .filter(([key, value]) => value && isSensitiveEnvKey(key))
        .map(([, value]) => value)
        .filter((value) => value.length >= 4)
        .sort((left, right) => right.length - left.length);
    return (value) => {
        if (!value)
            return value;
        return secrets.reduce((next, secret) => next.split(secret).join('[REDACTED]'), value);
    };
}
function isSensitiveEnvKey(key) {
    return /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i.test(key);
}
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
//# sourceMappingURL=tracker-hooks.js.map