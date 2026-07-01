#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scriptPath = new URL('./tik-multi-agent-workflow.mjs', import.meta.url).pathname;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-workflow-test-'));
const repo = path.join(tempRoot, 'repo');

let workflow = null;
let graph = null;
let subtasks = {};
let decisions = [];
let evidence = [];
let reviewTask = null;

try {
  await initRepo(repo);
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows') {
        const body = await readRequestJson(req);
        workflow = {
          id: 'wf-cli',
          driver: 'codex-workflow',
          status: 'active',
          goal: body.goal,
          rootTaskId: body.rootTaskId || 'wf-cli',
          repo: body.repo,
          baseRef: body.baseRef,
          headRef: body.headRef,
          currentHeadSha: body.headSha,
          maxRounds: body.maxRounds || 3,
        };
        sendJson(res, { workflow });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-cli') {
        sendJson(res, {
          workflow,
          taskGraph: graph,
          subtasks,
          decisions,
          evidence,
        });
        return;
      }
      if (req.method === 'PUT' && route === '/api/v1/multi-agent/workflows/wf-cli/task-graph') {
        const body = await readRequestJson(req);
        graph = body.graph;
        subtasks = {
          'st-api': {
            subtaskId: 'st-api',
            status: 'ready',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: [],
            blockerFindingIds: [],
            fixRound: 0,
          },
        };
        sendJson(res, { graph, subtasks });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/evidence') {
        const body = await readRequestJson(req);
        const item = {
          id: body.id || 'ev-cli',
          workflowId: 'wf-cli',
          ...body,
        };
        evidence.push(item);
        sendJson(res, { evidence: item });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/st-api') {
        const body = await readRequestJson(req);
        subtasks['st-api'] = {
          ...subtasks['st-api'],
          ...body,
        };
        sendJson(res, { subtask: subtasks['st-api'] });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/decisions') {
        const body = await readRequestJson(req);
        decisions.push(body.decision);
        sendJson(res, {
          decision: body.decision,
          guard: { accepted: true, code: 'ok' },
          workflow: { ...workflow, lastDecisionId: body.decision.id },
        });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/worktree-review-rounds') {
        const body = await readRequestJson(req);
        assert.equal(body.labels.includes('external-claude-review'), true);
        assert.equal(body.rootTaskId, 'wf-cli');
        reviewTask = {
          id: 'task-review',
          shortIdentifier: 'TIK-REVIEW',
          status: 'todo',
          labels: ['agent-loop', 'claude-review', 'external-claude-review', 'needs-claude-review'],
          agentLoop: {
            kind: 'claude_review',
            phase: 'needs_claude_review',
            headSha: body.headSha,
            round: body.round,
            maxRounds: body.maxRounds,
          },
        };
        sendJson(res, { task: reviewTask });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: reviewTask ? [reviewTask] : [] });
        return;
      }
      sendJson(res, { error: { message: `Unexpected route ${req.method} ${route}` } }, 404);
    } catch (error) {
      sendJson(res, { error: { message: error instanceof Error ? error.message : String(error) } }, 500);
    }
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/api`;

  const init = await run([
    'init',
    '--api-base-url', apiBaseUrl,
    '--path', repo,
    '--goal', 'Implement auth workflow',
    '--root-task', 'wf-cli',
    '--base', 'main',
  ]);
  assert.equal(init.action, 'initialized');
  assert.equal(init.workflowId, 'wf-cli');

  const putGraph = await run([
    'accept-plan',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--task-graph-json', JSON.stringify({
      workflowId: 'wf-cli',
      version: 1,
      createdBy: 'claude-code',
      subtasks: [{
        id: 'st-api',
        title: 'API',
        goal: 'Implement API',
        dependsOn: [],
        allowedPaths: ['packages/kernel/src/**'],
        acceptanceCriteria: ['API works'],
        validationCommands: ['pnpm --filter @tik/kernel test'],
        reviewFocus: ['routes'],
        assignedExecutor: 'codex',
        assignedReviewer: 'claude-code',
      }],
      risks: [],
      globalAcceptanceCriteria: [],
      finalValidationCommands: [],
    }),
  ]);
  assert.equal(putGraph.action, 'accepted-plan');

  const next = await run(['next', '--api-base-url', apiBaseUrl, '--workflow', 'wf-cli']);
  assert.equal(next.decision.action, 'execute_subtask');
  assert.equal(next.decision.subtaskId, 'st-api');
  assert.match(next.instruction, /Implement subtask st-api/);

  const execute = await run([
    'execute',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--summary', 'Implemented API',
  ]);
  assert.equal(execute.action, 'execution-recorded');
  assert.equal(subtasks['st-api'].status, 'implemented');

  const review = await run([
    'review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--path', repo,
    '--round', '1',
    '--max-rounds', '2',
  ]);
  assert.equal(review.action, 'review-requested');
  assert.equal(review.taskId, 'task-review');

  reviewTask = {
    ...reviewTask,
    status: 'todo',
    labels: ['agent-loop', 'codex-fix', 'external-claude-review', 'needs-codex-fix'],
    agentLoop: {
      ...reviewTask.agentLoop,
      kind: 'codex_fix',
      phase: 'needs_codex_fix',
      reviewResult: {
        verdict: 'request_changes',
        headShaReviewed: reviewTask.agentLoop.headSha,
        blockingIssues: [{
          title: 'Missing test',
          file: 'src/index.ts',
          reason: 'No regression test covers this workflow.',
        }],
        nonBlockingSuggestions: [],
        testsNeeded: ['Add a regression test.'],
        markdown: 'Blocking issue found.',
      },
    },
  };

  const processReview = await run([
    'process-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--task', 'task-review',
  ]);
  assert.equal(processReview.decision.action, 'fix_claude_blockers');
  assert.match(processReview.instruction, /Fix Claude blocking issues/);

  await new Promise((resolve) => server.close(resolve));
  console.log('tik-multi-agent-workflow helper smoke test passed');
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
