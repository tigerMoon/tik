import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export function buildRuntimeProcessEnv(input) {
    return { ...(input.env || {}) };
}
export async function assertRuntimeCwd(cwd) {
    const stat = await fs.stat(cwd).catch((error) => {
        if (error.code === 'ENOENT') {
            throw new Error(`Runtime working directory does not exist: ${cwd}`);
        }
        throw error;
    });
    if (!stat.isDirectory()) {
        throw new Error(`Runtime working directory is not a directory: ${cwd}`);
    }
}
export function attachProcessLogs(input, child) {
    const runDir = input.promptFile ? path.dirname(input.promptFile) : path.join(input.cwd, '.tik', 'runs', input.runId);
    const stdoutPath = path.join(runDir, 'stdout.log');
    const stderrPath = path.join(runDir, 'stderr.log');
    const redactedEnv = input.env || {};
    const writers = [];
    child.stdout?.on('data', (chunk) => {
        writers.push(appendLog(stdoutPath, redactChunk(chunk, redactedEnv)));
    });
    child.stderr?.on('data', (chunk) => {
        writers.push(appendLog(stderrPath, redactChunk(chunk, redactedEnv)));
    });
    return { writers, redactedEnv };
}
export function childCompletion(runtimeName, child, logWriters, onSettled, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        let timeout;
        const settle = (completion) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            void Promise.allSettled(logWriters).then(() => {
                onSettled(completion.status);
                resolve(completion);
            });
        };
        if (timeoutMs && timeoutMs > 0) {
            timeout = setTimeout(() => {
                child.kill('SIGTERM');
                settle({
                    status: 'failed',
                    error: `${runtimeName} timed out after ${timeoutMs}ms.`,
                });
            }, timeoutMs);
        }
        child.on('exit', (code) => {
            if (code === 0) {
                settle({ status: 'completed' });
            }
            else {
                settle({
                    status: 'failed',
                    error: `${runtimeName} exited with code ${code ?? 'unknown'}.`,
                });
            }
        });
        child.on('error', (err) => {
            const error = err instanceof Error ? err.message : String(err);
            settle({
                status: 'failed',
                error: `${runtimeName} failed to start: ${error}`,
            });
        });
    });
}
export function promiseCompletion(promise, onSettled) {
    return promise.then(() => {
        onSettled('completed');
        return { status: 'completed' };
    }, (err) => {
        const error = err instanceof Error ? err.message : String(err);
        onSettled('failed');
        return { status: 'failed', error };
    });
}
function redactChunk(chunk, env) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    const redacted = sensitiveValues(env).reduce((current, secret) => current.split(secret).join('[REDACTED]'), text);
    return redacted;
}
function sensitiveValues(env) {
    return Object.entries(env)
        .filter(([key, value]) => value && isSensitiveEnvKey(key))
        .map(([, value]) => value)
        .filter((value) => value.length >= 4)
        .sort((left, right) => right.length - left.length);
}
function isSensitiveEnvKey(key) {
    return /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i.test(key);
}
async function appendLog(filePath, chunk) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, chunk);
}
//# sourceMappingURL=runtime-process.js.map