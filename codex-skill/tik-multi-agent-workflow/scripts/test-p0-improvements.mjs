#!/usr/bin/env node
// Focused smoke tests for the P0 CLI improvements. Kept small and independent
// of test-tik-multi-agent-workflow.mjs so it can be run in isolation.
//
// Covers:
//   P0-1 CLI: init discovers open workflows and reuses (0/1/many).
//   P0-2 CLI: cooldown lock blocks subsequent status/next/continue with exit 3.
//   P0-3 CLI: builder-reused JSON output when server returns reused=true.
//   P0-4 CLI: terse output elides long fields by default; --verbose keeps them.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDir, 'tik-multi-agent-workflow.mjs');

async function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error?.message || error));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/api` });
    });
  });
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res, payload, statusCode = 200, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function run(args, extraEnv = {}) {
  // Use async spawn instead of spawnSync — spawnSync deadlocks reliably when
  // the child spawns its own subprocesses (git, codex --version, etc.) whose
  // output backs up in pipes while the parent blocks.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout.trim().split(/\n(?=\{)/).pop()); } catch { /* not JSON */ }
      resolve({ status: code, stdout, stderr, json });
    });
  });
}

// ---- helpers to make init's git preconditions succeed ----

async function initGitRepo(dir) {
  spawnSync('git', ['init'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), 'x');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=x', 'commit', '-m', 'init'], { cwd: dir });
}

// Standard permissive preflight + workflows list + workflows POST handler used
// by all three P0-1 discovery scenarios.
function makeDiscoveryHandler({ openWorkflows, workflowInits, sentPreflight }) {
  return async (req, res) => {
    const route = req.url || '/';
    if (req.method === 'POST' && route === '/api/v1/multi-agent/preflight') {
      const body = await readRequestJson(req);
      sentPreflight.push(body);
      sendJson(res, {
        report: {
          accepted: true,
          mode: body.mode || 'implementation',
          workspaceRoot: body.workspaceBinding?.workspaceRoot,
          checks: [],
        },
      });
      return;
    }
    if (req.method === 'GET' && route.startsWith('/api/v1/multi-agent/workflows?')) {
      // discover
      sendJson(res, { workflows: openWorkflows });
      return;
    }
    if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows') {
      const body = await readRequestJson(req);
      workflowInits.push(body);
      const workflow = {
        id: body.id || 'wf-new',
        driver: 'codex-workflow',
        status: 'active',
        mode: body.mode || 'implementation',
        goal: body.goal,
        rootTaskId: body.rootTaskId || body.id || 'wf-new',
        currentHeadSha: body.headSha,
        policy: body.policy,
      };
      sendJson(res, { workflow });
      return;
    }
    res.statusCode = 404;
    res.end();
  };
}

async function testDiscoveryZero() {
  const openWorkflows = [];
  const workflowInits = [];
  const sentPreflight = [];
  const { server, url } = await startServer(makeDiscoveryHandler({ openWorkflows, workflowInits, sentPreflight }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-disc0-'));
  await initGitRepo(dir);
  try {
    const result = await run(['init',
      '--api-base-url', url,
      '--path', dir,
      '--goal', 'Discovery zero test',
    ]);
    assert.equal(result.status, 0, `init should succeed when discovery is empty; stderr=${result.stderr}`);
    assert.equal(result.json.action, 'initialized');
    assert.equal(result.json.reusedWorkflow, false);
    assert.equal(result.json.discoveredCandidates, 0);
    assert.equal(workflowInits.length, 1, 'exactly one workflow should be created');
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  ✓ P0-1 discovery: zero candidates → creates new workflow');
}

async function testDiscoveryOne() {
  const openWorkflows = [{
    id: 'wf-existing',
    driver: 'codex-workflow',
    status: 'active',
    mode: 'implementation',
    // Must match the caller's --goal for reuse to happen; the discovery
    // guard rejects reuse when goals differ to avoid silently rebinding
    // yesterday's workflow to today's fresh --goal.
    goal: 'Discovery one test',
    rootTaskId: 'wf-existing',
    updatedAt: new Date().toISOString(),
    metadata: {},
  }];
  const workflowInits = [];
  const sentPreflight = [];
  const { server, url } = await startServer(makeDiscoveryHandler({ openWorkflows, workflowInits, sentPreflight }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-disc1-'));
  await initGitRepo(dir);
  try {
    const result = await run(['init',
      '--api-base-url', url,
      '--path', dir,
      '--goal', 'Discovery one test',
    ]);
    assert.equal(result.status, 0, `init should succeed when discovery has 1 non-stale match; stderr=${result.stderr}`);
    assert.equal(result.json.action, 'initialized');
    assert.equal(result.json.reusedWorkflow, true);
    assert.equal(result.json.workflowId, 'wf-existing');
    assert.equal(workflowInits.length, 0, 'no new workflow should be created when reuse succeeds');
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  ✓ P0-1 discovery: exactly one candidate → reuses it');
}

async function testDiscoveryOneGoalMismatch() {
  const openWorkflows = [{
    id: 'wf-existing',
    driver: 'codex-workflow',
    status: 'active',
    mode: 'implementation',
    goal: 'Add pagination to /users endpoint',
    rootTaskId: 'wf-existing',
    updatedAt: new Date().toISOString(),
    metadata: {},
  }];
  const workflowInits = [];
  const sentPreflight = [];
  const { server, url } = await startServer(makeDiscoveryHandler({ openWorkflows, workflowInits, sentPreflight }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-disc1gm-'));
  await initGitRepo(dir);
  try {
    const result = await run(['init',
      '--api-base-url', url,
      '--path', dir,
      '--goal', 'Fix login CSRF',
    ]);
    assert.notEqual(result.status, 0, 'init should refuse to silently rebind a workflow with a different goal');
    assert.ok(
      result.stderr.includes('goal_mismatch'),
      `stderr should mention goal_mismatch, got: ${result.stderr}`,
    );
    assert.equal(workflowInits.length, 0, 'no new workflow should be created on goal mismatch');
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  ✓ P0-1 discovery: goal mismatch → refuses reuse, does not create either');
}

async function testDiscoveryMany() {
  const openWorkflows = [
    { id: 'wf-1', driver: 'codex-workflow', status: 'active', mode: 'implementation', goal: 'g1', rootTaskId: 'wf-1', updatedAt: new Date().toISOString(), metadata: {} },
    { id: 'wf-2', driver: 'codex-workflow', status: 'active', mode: 'implementation', goal: 'g2', rootTaskId: 'wf-2', updatedAt: new Date().toISOString(), metadata: {} },
  ];
  const workflowInits = [];
  const sentPreflight = [];
  const { server, url } = await startServer(makeDiscoveryHandler({ openWorkflows, workflowInits, sentPreflight }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-discM-'));
  await initGitRepo(dir);
  try {
    const result = await run(['init',
      '--api-base-url', url,
      '--path', dir,
      '--goal', 'Discovery many test',
    ]);
    assert.notEqual(result.status, 0, 'init should refuse when discovery finds multiple non-stale candidates');
    assert.ok(result.stderr.includes('ambiguous_open_workflows'), `stderr should mention ambiguous_open_workflows, got: ${result.stderr}`);
    assert.equal(workflowInits.length, 0, 'no new workflow should be created on ambiguous match');
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  ✓ P0-1 discovery: multiple candidates → refuses with ambiguous_open_workflows');
}

async function testDiscoveryForceNew() {
  const openWorkflows = [
    { id: 'wf-1', driver: 'codex-workflow', status: 'active', mode: 'implementation', goal: 'g1', rootTaskId: 'wf-1', updatedAt: new Date().toISOString(), metadata: {} },
    { id: 'wf-2', driver: 'codex-workflow', status: 'active', mode: 'implementation', goal: 'g2', rootTaskId: 'wf-2', updatedAt: new Date().toISOString(), metadata: {} },
  ];
  const workflowInits = [];
  const sentPreflight = [];
  const { server, url } = await startServer(makeDiscoveryHandler({ openWorkflows, workflowInits, sentPreflight }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-forcenew-'));
  await initGitRepo(dir);
  try {
    const result = await run(['init',
      '--api-base-url', url,
      '--path', dir,
      '--goal', 'Force new test',
      '--force-new',
    ]);
    assert.equal(result.status, 0, `--force-new should bypass discovery; stderr=${result.stderr}`);
    assert.equal(result.json.action, 'initialized');
    assert.equal(result.json.reusedWorkflow, false);
    assert.equal(workflowInits.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
  console.log('  ✓ P0-1 discovery: --force-new bypasses discovery');
}

async function testCooldownBlocks() {
  const workflowId = 'wf-cooldown';
  // 1) Prime a cooldown file directly (skip a full workflow session; that's what the module does anyway).
  const stateDir = path.join(os.homedir(), '.tik', 'state');
  await mkdir(stateDir, { recursive: true });
  const cooldownPath = path.join(stateDir, `cooldown-${workflowId}.json`);
  const nextEligibleAt = new Date(Date.now() + 30_000).toISOString();
  await writeFile(cooldownPath, JSON.stringify({
    workflowId,
    createdAt: new Date().toISOString(),
    nextEligibleAt,
    cooldownMs: 30_000,
    reason: 'awaiting_native_runtime',
    reasonCode: 'awaiting_native_runtime',
  }));

  try {
    // 2) Any of continue/next/status should exit 3 with action=cooldown.
    const server = await startServer(async () => { /* should never be called */ });
    try {
      const result = await run(['status', '--api-base-url', server.url, '--workflow', workflowId]);
      assert.equal(result.status, 3, `status during cooldown should exit 3; got ${result.status}, stderr=${result.stderr}`);
      assert.equal(result.json.action, 'cooldown');
      assert.ok(result.json.remainingMs > 0);

      // 3) TIK_DISABLE_COOLDOWN=1 bypasses (result will still fail because there is no real workflow, but cooldown should not be the reason).
      const bypass = await run(['status', '--api-base-url', server.url, '--workflow', workflowId], { TIK_DISABLE_COOLDOWN: '1' });
      // Real HTTP fails because our stub returns 404, so exit != 3 is enough to prove cooldown was bypassed.
      assert.notEqual(bypass.status, 3, 'TIK_DISABLE_COOLDOWN=1 should bypass the cooldown lock');
    } finally {
      await new Promise((r) => server.server.close(r));
    }
  } finally {
    if (existsSync(cooldownPath)) await rm(cooldownPath);
  }
  console.log('  ✓ P0-2 cooldown: status during cooldown → exit 3, TIK_DISABLE_COOLDOWN=1 bypasses');
}

async function testTerseAndVerbose() {
  // The `--help` path is deterministic; we don't need a server. But `--help`
  // prints usage text to stderr and exits 0 with no JSON — not a useful terse
  // test. Instead, test terse mode on a real handler response by mocking a
  // status endpoint returning a huge `recentEvents` field.
  const { server, url } = await startServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/multi-agent/workflows/wf-terse') {
      sendJson(res, {
        workflow: { id: 'wf-terse', driver: 'codex-workflow', status: 'active', updatedAt: new Date().toISOString() },
        subtasks: {},
        decisions: [],
        evidence: [],
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/multi-agent/workflows/wf-terse/timeline') {
      // >200 bytes of recent events; must be elided in terse mode.
      const events = Array.from({ length: 30 }, (_, i) => ({
        type: `event.${i}`,
        createdAt: new Date().toISOString(),
        payload: { longField: 'x'.repeat(20) },
      }));
      sendJson(res, { events });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const terse = await run(['status', '--api-base-url', url, '--workflow', 'wf-terse'], { TIK_DISABLE_COOLDOWN: '1' });
    assert.equal(terse.status, 0, `terse status should succeed; stderr=${terse.stderr}`);
    // recentEvents should be elided to an empty array (type-stable), and the
    // parent object should carry an __elided marker pointing at the field.
    assert.ok(Array.isArray(terse.json.recentEvents), 'terse mode should preserve array type for recentEvents');
    assert.equal(terse.json.recentEvents.length, 0, 'terse mode should empty the array');
    assert.ok(Array.isArray(terse.json.__elided), 'terse mode should surface an __elided marker');
    assert.ok(terse.json.__elided.includes('recentEvents'), '__elided should list recentEvents');
    // timeline is a small array of event.type strings — should remain.
    assert.ok(Array.isArray(terse.json.timeline));

    const verbose = await run(['status', '--api-base-url', url, '--workflow', 'wf-terse', '--verbose'], { TIK_DISABLE_COOLDOWN: '1' });
    assert.equal(verbose.status, 0);
    assert.ok(Array.isArray(verbose.json.recentEvents), '--verbose should preserve recentEvents as an array');
    // status handler slices to last 20 events regardless of mode.
    assert.equal(verbose.json.recentEvents.length, 20);
  } finally {
    await new Promise((r) => server.close(r));
  }
  console.log('  ✓ P0-4 terse: elides recentEvents by default; --verbose restores');
}

async function testBuilderReused() {
  const workflowId = 'wf-reused-cli';
  const subtaskId = 'st-1';
  const { server, url } = await startServer(async (req, res) => {
    if (req.method === 'GET' && req.url === `/api/v1/multi-agent/workflows/${workflowId}`) {
      sendJson(res, {
        workflow: {
          id: workflowId, driver: 'codex-workflow', status: 'active', mode: 'implementation',
          goal: 'g', rootTaskId: workflowId, currentHeadSha: 'h1',
          workspaceBinding: { workspaceRoot: '/tmp', effectiveProjectPath: '/tmp' },
        },
        subtasks: { [subtaskId]: { subtaskId, status: 'pending', evidenceRefs: [] } },
        contracts: [{ id: 'contract-1', subtaskId, status: 'accepted', version: 1 }],
        taskGraph: { subtasks: [{ id: subtaskId, title: 'S1' }] },
        decisions: [],
      });
      return;
    }
    if (req.method === 'POST' && req.url === `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations/native-launch`) {
      sendJson(res, {
        invocation: { id: 'inv-reused', role: 'executor', status: 'started' },
        runtime: { runId: 'inv-reused', runtimeRef: 'run:inv-reused', status: 'running', reused: true },
        reused: true,
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const result = await run(['start-builder',
      '--api-base-url', url,
      '--workflow', workflowId,
      '--subtask', subtaskId,
      '--invocation', 'inv-reused',
      '--path', '/tmp',
    ], { TIK_DISABLE_COOLDOWN: '1' });
    assert.equal(result.status, 0, `start-builder should succeed on reused response; stderr=${result.stderr}`);
    assert.equal(result.json.action, 'builder-reused');
    assert.equal(result.json.reused, true);
    assert.ok(result.json.hint.includes('already running or completed'));
  } finally {
    await new Promise((r) => server.close(r));
  }
  console.log('  ✓ P0-3 builder-reused: reused=true → action=builder-reused with hint');
}

// Sequenced runner. Fail fast so we can see the first broken assertion.
const tests = [
  testDiscoveryZero,
  testDiscoveryOne,
  testDiscoveryOneGoalMismatch,
  testDiscoveryMany,
  testDiscoveryForceNew,
  testCooldownBlocks,
  testTerseAndVerbose,
  testBuilderReused,
];

let failed = 0;
for (const test of tests) {
  try {
    await test();
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${test.name}: ${error?.message || error}`);
    if (error?.stack) console.error(error.stack);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} P0 CLI improvement smoke tests failed`);
  process.exit(1);
}
console.log(`\ntik-multi-agent-workflow P0 improvements: ${tests.length}/${tests.length} smoke tests passed`);
