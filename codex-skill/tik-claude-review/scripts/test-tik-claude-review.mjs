#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scriptPath = new URL('./tik-claude-review.mjs', import.meta.url).pathname;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tik-claude-review-test-'));
const repo = path.join(tempRoot, 'repo');
let tasks = [];

try {
  await initRepo(repo);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/v1/agent-loop/worktree-review-rounds') {
        const body = await readRequestJson(req);
        assert.equal(body.labels.includes('external-claude-review'), true);
        assert.equal(body.workspaceBinding.effectiveProjectPath, repo);
        const task = {
          id: 'task-review',
          shortIdentifier: 'TIK-REVIEW',
          status: 'todo',
          labels: ['agent-loop', 'claude-review', 'external-claude-review', 'needs-claude-review'],
          agentLoop: {
            kind: 'claude_review',
            phase: 'needs_claude_review',
            headSha: body.headSha,
          },
        };
        tasks = [task];
        sendJson(res, { task });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/tasks') {
        sendJson(res, { tasks });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/agent-loop/tasks/task-review/claude-review-runs') {
        sendJson(res, {
          queued: false,
          runId: 'run-review-1',
          result: {
            dispatched: ['TIK-REVIEW'],
            failed: [],
          },
        });
        return;
      }
      sendJson(res, { error: { message: `Unexpected route ${req.method} ${req.url}` } }, 404);
    } catch (error) {
      sendJson(res, { error: { message: error instanceof Error ? error.message : String(error) } }, 500);
    }
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/api`;

  const create = await run(['create', '--api-base-url', apiBaseUrl, '--path', repo, '--root-task', 'TASK-1']);
  assert.equal(create.action, 'created');
  assert.equal(create.taskId, 'task-review');
  assert.equal(create.trackerOwned, false);

  const started = await run(['start', '--api-base-url', apiBaseUrl, '--task', 'task-review']);
  assert.equal(started.action, 'started');
  assert.equal(started.runId, 'run-review-1');
  assert.deepEqual(started.dispatched, ['TIK-REVIEW']);

  tasks[0] = {
    ...tasks[0],
    status: 'todo',
    labels: ['agent-loop', 'codex-fix', 'external-claude-review', 'needs-codex-fix'],
    agentLoop: {
      ...tasks[0].agentLoop,
      kind: 'codex_fix',
      phase: 'needs_codex_fix',
      reviewResult: {
        verdict: 'request_changes',
        headShaReviewed: tasks[0].agentLoop.headSha,
        blockingIssues: [{
          title: 'Missing test',
          file: 'src/index.ts',
          reason: 'No regression test covers the behavior.',
        }],
        nonBlockingSuggestions: [],
        testsNeeded: ['Add a regression test.'],
        markdown: 'Blocking issue found.',
      },
    },
  };

  const wait = await run(['wait', '--api-base-url', apiBaseUrl, '--task', 'task-review', '--timeout-ms', '1000', '--interval-ms', '10']);
  assert.equal(wait.action, 'review-result');
  assert.equal(wait.nextPhase, 'needs_codex_fix');
  assert.equal(wait.blockingIssueCount, 1);

  const processed = await run(['process', '--api-base-url', apiBaseUrl, '--task', 'task-review']);
  assert.equal(processed.action, 'codex-fix-needed');
  assert.equal(processed.blockingIssues[0].title, 'Missing test');

  await new Promise((resolve) => server.close(resolve));
  console.log('tik-claude-review helper smoke test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function initRepo(repoPath) {
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, 'README.md'), '# test\n', 'utf-8');
  await runCommand('git', ['init'], repoPath);
  await runCommand('git', ['config', 'user.email', 'test@example.com'], repoPath);
  await runCommand('git', ['config', 'user.name', 'Tik Test'], repoPath);
  await runCommand('git', ['add', 'README.md'], repoPath);
  await runCommand('git', ['commit', '-m', 'init'], repoPath);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
