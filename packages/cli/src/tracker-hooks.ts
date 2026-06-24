import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_HOOK_ENV_KEYS = ['PATH', 'HOME'] as const;

type ExecFileError = Error & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  cmd?: string;
  code?: string | number;
};

export interface TrackerHookInput {
  task: { id: string; shortIdentifier: string };
  workspaceRoot: string;
  projectPath: string;
  workflowVersion?: 1 | 2;
  envWhitelist?: string[];
}

export async function runTrackerHook(name: string, input: TrackerHookInput): Promise<void> {
  const tikEnv = {
    TIK_TRACKER_TASK_ID: input.task.id,
    TIK_TRACKER_TASK_IDENTIFIER: input.task.shortIdentifier,
    TIK_TRACKER_ISSUE_ID: input.task.id,
    TIK_TRACKER_ISSUE_IDENTIFIER: input.task.shortIdentifier,
    TIK_TRACKER_WORKSPACE_ROOT: input.workspaceRoot,
    TIK_TRACKER_PROJECT_PATH: input.projectPath,
  };

  if (input.workflowVersion === 2) {
    const env = buildWhitelistedHookEnv(input.envWhitelist || [], tikEnv);
    try {
      await execFileAsync(await resolveWorkflowV2HookPath(input.workspaceRoot, name), [], {
        cwd: input.projectPath,
        env,
      });
    } catch (error) {
      throw redactHookError(error, env);
    }
    return;
  }

  await execFileAsync('/bin/sh', ['-lc', name], {
    cwd: input.projectPath,
    env: {
      ...process.env,
      ...tikEnv,
    },
  });
}

export function buildWhitelistedHookEnv(
  whitelist: string[],
  tikEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...tikEnv };
  for (const key of DEFAULT_HOOK_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of whitelist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function redactHookError(error: unknown, env: NodeJS.ProcessEnv): Error {
  const original = error instanceof Error ? error as ExecFileError : new Error(String(error)) as ExecFileError;
  const redact = buildRedactor(env);
  const redacted = new Error(redact(original.message) || 'Tracker hook failed.') as ExecFileError;
  redacted.name = original.name;
  redacted.stack = redact(original.stack);
  redacted.stdout = redactField(original.stdout, redact);
  redacted.stderr = redactField(original.stderr, redact);
  redacted.cmd = redact(original.cmd);
  redacted.code = original.code;
  return redacted;
}

function redactField(
  value: string | Buffer | undefined,
  redact: (value: string | undefined) => string | undefined,
): string | Buffer | undefined {
  if (value === undefined) return undefined;
  if (Buffer.isBuffer(value)) return Buffer.from(redact(value.toString('utf-8')) || '');
  return redact(value);
}

async function resolveWorkflowV2HookPath(workspaceRoot: string, hookName: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, hookName);
  if (!isWithin(root, resolved)) {
    throw new Error(`Workflow v2 hook resolves outside the workspace root: ${hookName}`);
  }
  const realRoot = await fs.realpath(root);
  const realResolved = await fs.realpath(resolved);
  if (!isWithin(realRoot, realResolved)) {
    throw new Error(`Workflow v2 hook resolves outside the workspace root: ${hookName}`);
  }
  return realResolved;
}

function buildRedactor(env: NodeJS.ProcessEnv): (value: string | undefined) => string | undefined {
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && isSensitiveEnvKey(key))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  return (value: string | undefined) => {
    if (!value) return value;
    return secrets.reduce((next, secret) => next.split(secret).join('[REDACTED]'), value);
  };
}

function isSensitiveEnvKey(key: string): boolean {
  return /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i.test(key);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
