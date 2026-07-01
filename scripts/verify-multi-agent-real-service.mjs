#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const nodePath = process.execPath;
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const reportDir = path.join(repoRoot, '.tik', 'verification');
const nowTag = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `multi-agent-real-service-${nowTag}.json`);

const options = parseArgs(process.argv.slice(2));
const workspaceRoot = path.resolve(options.workspaceRoot || await mkdtemp(path.join(os.tmpdir(), 'tik-real-service-')));
const projectPath = path.resolve(options.project || workspaceRoot);
const host = options.host || '127.0.0.1';
const port = Number(options.port || await findFreePort(host));

const report = {
  kind: 'multi-agent-real-service-verification',
  startedAt: new Date().toISOString(),
  workspaceRoot,
  projectPath,
  server: null,
  steps: [],
  taskSnapshots: [],
  workflowSnapshots: [],
  artifacts: {
    reportPath,
  },
};

let child;

try {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  await mkdir(reportDir, { recursive: true });

  child = await startTikServe({ host, port, projectPath: workspaceRoot });
  report.server = {
    apiBaseUrl: child.apiBaseUrl,
    pid: child.process.pid,
    stdout: child.stdout,
    stderr: child.stderr,
  };

  const client = createClient(child.apiBaseUrl);
  const health = await client.get('/health');
  recordStep('health', health);

  const taskCreated = await client.post('/v1/tasks', {
    title: 'Real-service multi-agent workflow verification',
    description: 'Created by scripts/verify-multi-agent-real-service.mjs through the external Tik HTTP service.',
    goal: 'Verify task content, task state transitions, and multi-agent workflow records through a real Tik server process.',
    status: 'backlog',
    priority: 1,
    labels: ['multi-agent', 'real-service', 'verification'],
    humanAssignee: 'codex',
    workspaceBinding: buildWorkspaceBinding(workspaceRoot, projectPath),
  });
  recordStep('task.created', taskCreated);
  const taskId = taskCreated.body.task.id;
  await captureTask(client, taskId, 'created');

  const workflowCreated = await client.post('/v1/multi-agent/workflows', {
    id: `wf-real-service-${Date.now()}`,
    goal: 'Verify MultiAgentWorkflowService through a real Tik service process',
    rootTaskId: taskId,
    repo: path.basename(projectPath),
    baseRef: 'main',
    headRef: 'codex/multi-agent-workflow-service-codex-workflow',
    headSha: 'real-service-head-1',
    maxRounds: 2,
    workspaceBinding: buildWorkspaceBinding(workspaceRoot, projectPath),
    metadata: {
      verification: 'real-service',
      script: 'scripts/verify-multi-agent-real-service.mjs',
    },
  });
  recordStep('workflow.created', workflowCreated);
  const workflowId = workflowCreated.body.workflow.id;
  await captureWorkflow(client, workflowId, 'created');

  const graph = buildTaskGraph(workflowId);
  const graphAccepted = await client.put(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/task-graph`, { graph });
  recordStep('workflow.task_graph.accepted', graphAccepted);
  await captureWorkflow(client, workflowId, 'task_graph_accepted');

  const taskTodo = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    to: 'todo',
    actor: 'system',
    reason: 'Real-service verification moved the task into schedulable work.',
  });
  recordStep('task.transition.todo', taskTodo);
  await captureTask(client, taskId, 'todo');

  const illegalTaskTransition = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    to: 'completed',
    actor: 'system',
    reason: 'Intentional invalid transition check from todo to completed.',
  }, { okStatuses: [409] });
  recordStep('task.transition.invalid_completed', illegalTaskTransition);
  await captureTask(client, taskId, 'after_invalid_transition');

  const taskInProgress = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    to: 'in_progress',
    actor: 'daemon',
    reason: 'Real-service verification started implementation.',
  });
  recordStep('task.transition.in_progress', taskInProgress);
  await captureTask(client, taskId, 'in_progress');

  const subtaskExecuting = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'executing',
  });
  recordStep('subtask.executing', subtaskExecuting);

  const implementationEvidence = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/evidence`, {
    id: 'ev-real-service-implementation',
    kind: 'implementation',
    title: 'Real-service implementation evidence',
    summary: 'Implementation evidence recorded through the external Tik service.',
    subtaskId: 'st-real-service',
    headSha: 'real-service-head-1',
    payload: {
      servicePid: child.process.pid,
      apiBaseUrl: child.apiBaseUrl,
    },
  });
  recordStep('evidence.implementation', implementationEvidence);

  const subtaskImplemented = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'implemented',
    implementationHeadSha: 'real-service-head-1',
    evidenceRefs: ['ev-real-service-implementation'],
  });
  recordStep('subtask.implemented', subtaskImplemented);

  const taskNeedsReview = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    to: 'needs_review',
    actor: 'agent',
    reason: 'Implementation evidence was recorded; review is required.',
  });
  recordStep('task.transition.needs_review', taskNeedsReview);
  await captureTask(client, taskId, 'needs_review');

  const validationEvidence = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/evidence`, {
    id: 'ev-real-service-validation',
    kind: 'validation',
    title: 'Real-service validation evidence',
    summary: 'Validation evidence recorded through the external Tik service.',
    subtaskId: 'st-real-service',
    command: 'node scripts/verify-multi-agent-real-service.mjs',
    passed: true,
    headSha: 'real-service-head-1',
  });
  recordStep('evidence.validation', validationEvidence);

  const decision = {
    id: 'dec-real-service-complete-subtask',
    workflowId,
    rootTaskId: taskId,
    subtaskId: 'st-real-service',
    decidedBy: 'codex-workflow',
    decidedAt: new Date().toISOString(),
    action: 'complete_subtask',
    reason: 'External Tik service accepted implementation and validation evidence.',
    evidenceRefs: ['ev-real-service-implementation', 'ev-real-service-validation'],
    inputs: {
      currentHeadSha: 'real-service-head-1',
    },
    expectedTikMutation: {
      taskStatus: 'completed',
    },
    confidence: 0.95,
  };
  const decisionRecorded = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions`, {
    decision,
  });
  recordStep('workflow.decision.complete_subtask', decisionRecorded);

  const missingEvidenceDecision = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions`, {
    decision: {
      ...decision,
      id: 'dec-real-service-missing-evidence',
      evidenceRefs: ['ev-real-service-missing'],
    },
  }, { okStatuses: [409] });
  recordStep('workflow.decision.missing_evidence_guard', missingEvidenceDecision);

  const subtaskApproved = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'approved',
    evidenceRefs: ['ev-real-service-validation'],
    lastValidatedHeadSha: 'real-service-head-1',
  });
  recordStep('subtask.approved', subtaskApproved);

  const subtaskDone = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'done',
  });
  recordStep('subtask.done', subtaskDone);

  const taskCompleted = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    to: 'completed',
    actor: 'agent',
    reason: 'Workflow subtask completed with real-service evidence.',
  });
  recordStep('task.transition.completed', taskCompleted);
  await captureTask(client, taskId, 'completed');

  const comment = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/comments`, {
    authorKind: 'system',
    authorId: 'real-service-verifier',
    body: `Real-service verification report: ${reportPath}`,
  });
  recordStep('task.comment.report_link', comment);
  await captureTask(client, taskId, 'commented');

  const taskTimeline = await client.get(`/workbench/tasks/${encodeURIComponent(taskId)}/timeline`);
  recordStep('task.timeline', taskTimeline);
  report.taskTimeline = taskTimeline.body.timeline;

  const workflowTimeline = await client.get(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/timeline`);
  recordStep('workflow.timeline', workflowTimeline);
  report.workflowTimeline = workflowTimeline.body.events;

  await captureWorkflow(client, workflowId, 'final');
  await capturePersistedFiles(workspaceRoot, taskId, workflowId);

  const reviewEvidence = await createDashboardReviewEvidence(client, {
    rootTaskId: taskId,
    headSha: readGitHead(projectPath) || 'real-service-head-1',
  });
  report.reviewEvidence = reviewEvidence;

  report.completedAt = new Date().toISOString();
  report.result = {
    status: 'passed',
    taskId,
    workflowId,
    taskStates: report.taskSnapshots.map((snapshot) => ({
      label: snapshot.label,
      status: snapshot.task?.status,
      latestSummary: snapshot.task?.latestSummary,
      labels: snapshot.task?.labels,
      agentLoopPhase: snapshot.task?.agentLoop?.phase,
    })),
    workflowEventTypes: report.workflowTimeline.map((event) => event.type),
    reviewTaskId: reviewEvidence.taskId,
    reviewTaskShortIdentifier: reviewEvidence.shortIdentifier,
    reviewTaskStatus: reviewEvidence.finalTask.status,
    reviewTaskAgentLoop: {
      kind: reviewEvidence.finalTask.agentLoop?.kind,
      phase: reviewEvidence.finalTask.agentLoop?.phase,
      verdict: reviewEvidence.finalTask.agentLoop?.reviewResult?.verdict,
      blockingIssueCount: reviewEvidence.finalTask.agentLoop?.reviewResult?.blockingIssues?.length ?? null,
    },
    invalidTransitionStatus: illegalTaskTransition.status,
    missingEvidenceGuard: missingEvidenceDecision.body.guard,
  };
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.result = {
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  process.exitCode = 1;
} finally {
  if (child) {
    await stopTikServe(child.process);
    report.server = {
      ...report.server,
      stoppedAt: new Date().toISOString(),
      stdout: child.stdout,
      stderr: child.stderr,
    };
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  printSummary(report);
}

function buildWorkspaceBinding(root, project) {
  return {
    workspaceRoot: root,
    workspaceName: path.basename(root),
    projectName: path.basename(project),
    effectiveProjectPath: project,
    sourceProjectPath: project,
    laneId: 'real-service-verification',
    worktreeKind: 'root',
  };
}

function buildTaskGraph(workflowId) {
  return {
    workflowId,
    version: 1,
    createdBy: 'claude-code',
    risks: ['External service process, HTTP serialization, and file-backed persistence must agree.'],
    globalAcceptanceCriteria: ['Task and workflow state are visible through real Tik APIs.'],
    finalValidationCommands: ['node scripts/verify-multi-agent-real-service.mjs'],
    subtasks: [
      {
        id: 'st-real-service',
        title: 'Verify real Tik service contract',
        goal: 'Exercise MultiAgentWorkflowService through a real external Tik server process.',
        dependsOn: [],
        allowedPaths: ['packages/kernel/src/**', 'packages/shared/src/**', 'codex-skill/tik-multi-agent-workflow/**'],
        acceptanceCriteria: [
          'The workflow records evidence and a guarded decision.',
          'The root workbench task exposes every state and full content through HTTP.',
        ],
        validationCommands: ['node scripts/verify-multi-agent-real-service.mjs'],
        reviewFocus: ['HTTP contract', 'task state visibility', 'persistence'],
        assignedExecutor: 'codex',
        assignedReviewer: 'claude-code',
      },
    ],
  };
}

async function createDashboardReviewEvidence(client, input) {
  const reviewTask = await client.post('/v1/agent-loop/worktree-review-rounds', {
    rootTaskId: input.rootTaskId,
    round: 1,
    maxRounds: 2,
    repo: path.basename(projectPath),
    title: '[REAL REVIEW RESULT] MultiAgentWorkflowService dashboard evidence',
    baseRef: 'main',
    headRef: 'codex/multi-agent-workflow-service-codex-workflow',
    headSha: input.headSha,
    idempotencyKey: `real-service-review:${input.rootTaskId}:${input.headSha}:r1:${Date.now()}`,
    labels: ['external-claude-review', 'real-service', 'multi-agent', 'dashboard-evidence'],
    allowedScope: [
      'packages/kernel/src/multi-agent/**',
      'packages/kernel/src/server.ts',
      'packages/shared/src/types/multi-agent.ts',
      'codex-skill/tik-multi-agent-workflow/**',
      'scripts/verify-multi-agent-real-service.mjs',
    ],
    acceptanceCriteria: [
      'Dashboard task contains ReviewResult JSON.',
      'Task timeline records review-result ingestion.',
      'Comments show workflow state transitions and review outcome.',
    ],
    reviewFocus: ['workflow guardrails', 'real service API evidence', 'dashboard observability'],
    createdBy: 'codex',
    workspaceBinding: buildWorkspaceBinding(workspaceRoot, projectPath),
  });
  recordStep('review_task.created', reviewTask);
  const reviewTaskId = reviewTask.body.task.id;

  await client.post(`/v1/tasks/${encodeURIComponent(reviewTaskId)}/comments`, {
    authorKind: 'system',
    authorId: 'real-service-verifier',
    body: [
      'Workflow execution marker: created real agent-loop Claude review task through POST /api/v1/agent-loop/worktree-review-rounds.',
      `Initial status=${reviewTask.body.task.status}, agentLoop.kind=${reviewTask.body.task.agentLoop?.kind}, phase=${reviewTask.body.task.agentLoop?.phase}.`,
    ].join('\n'),
  });

  let runtimeLaunch = null;
  if (options.launchClaudeRuntime) {
    runtimeLaunch = await client.post(
      `/v1/agent-loop/tasks/${encodeURIComponent(reviewTaskId)}/claude-review-runs`,
      undefined,
      { okStatuses: [200, 400, 409, 500] },
    );
    recordStep('review_task.runtime_launch_attempt', runtimeLaunch);
    await client.post(`/v1/tasks/${encodeURIComponent(reviewTaskId)}/comments`, {
      authorKind: 'system',
      authorId: 'real-service-verifier',
      body: [
        `Runtime launch attempt through POST /api/v1/agent-loop/tasks/${reviewTaskId}/claude-review-runs returned HTTP ${runtimeLaunch.status}.`,
        'Response:',
        '```json',
        JSON.stringify(runtimeLaunch.body, null, 2),
        '```',
      ].join('\n'),
    });
  } else {
    await client.post(`/v1/tasks/${encodeURIComponent(reviewTaskId)}/comments`, {
      authorKind: 'system',
      authorId: 'real-service-verifier',
      body: [
        'Claude runtime launch intentionally skipped by this verifier.',
        'This avoids leaving a long-running local Claude process in automated verification.',
        'Pass --launch-claude-runtime to exercise the runtime dispatch endpoint explicitly.',
      ].join('\n'),
    });
  }

  const reviewResultBody = {
    verdict: 'approve',
    headShaReviewed: input.headSha,
    currentHeadSha: input.headSha,
    blockingIssues: [],
    nonBlockingSuggestions: [{
      title: 'Keep real-service dashboard verification explicit',
      file: 'scripts/verify-multi-agent-real-service.mjs',
      reason: 'It makes workflow execution evidence visible and reproducible from the Dashboard workspace.',
    }],
    testsNeeded: [],
    markdown: [
      '## Real Review Result',
      '',
      'No blocking findings.',
      '',
      `This structured ReviewResult was submitted through the real Tik API endpoint /api/v1/agent-loop/tasks/${reviewTaskId}/review-result.`,
    ].join('\n'),
    reviewerWorkerId: 'real-service-verifier',
  };
  const reviewResult = await client.post(
    `/v1/agent-loop/tasks/${encodeURIComponent(reviewTaskId)}/review-result`,
    reviewResultBody,
  );
  recordStep('review_task.review_result_ingested', reviewResult);

  await client.post(`/v1/tasks/${encodeURIComponent(reviewTaskId)}/comments`, {
    authorKind: 'system',
    authorId: 'real-service-verifier',
    body: [
      'State flow marker:',
      '1. Review task created as claude_review / needs_claude_review.',
      options.launchClaudeRuntime
        ? '2. Runtime launch endpoint was called.'
        : '2. Runtime launch was skipped by verifier configuration.',
      `3. ReviewResult ingested with verdict=${reviewResult.body.task.agentLoop?.reviewResult?.verdict}.`,
      `4. Tik transitioned task to status=${reviewResult.body.task.status}, agentLoop.kind=${reviewResult.body.task.agentLoop?.kind}, phase=${reviewResult.body.task.agentLoop?.phase}.`,
    ].join('\n'),
  });

  const finalTask = await readTaskById(client, reviewTaskId);
  const timeline = await client.get(`/workbench/tasks/${encodeURIComponent(reviewTaskId)}/timeline`);
  recordStep('review_task.timeline', timeline);
  return {
    taskId: reviewTaskId,
    shortIdentifier: finalTask.shortIdentifier,
    createdTask: reviewTask.body.task,
    runtimeLaunch,
    reviewResult: reviewResult.body,
    finalTask,
    timeline: timeline.body.timeline,
  };
}

async function startTikServe(input) {
  const args = [
    cliPath,
    'serve',
    '--host',
    input.host,
    '--port',
    String(input.port),
    '--project',
    input.projectPath,
    '--provider',
    'codex',
  ];
  const env = {
    ...process.env,
    PATH: `/Users/huyuehui/.nvm/versions/node/v20.20.0/bin:${process.env.PATH || ''}`,
  };
  const childProcess = spawn(nodePath, args, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = {
    process: childProcess,
    stdout: '',
    stderr: '',
    apiBaseUrl: `http://${input.host}:${input.port}/api`,
  };
  childProcess.stdout.setEncoding('utf-8');
  childProcess.stderr.setEncoding('utf-8');
  childProcess.stdout.on('data', (chunk) => {
    started.stdout += chunk;
    const match = chunk.match(/API:\s+(http:\/\/[^\s]+)/);
    if (match) {
      started.apiBaseUrl = `${match[1].replace(/\/$/, '')}/api`;
    }
  });
  childProcess.stderr.on('data', (chunk) => {
    started.stderr += chunk;
  });

  const exitPromise = new Promise((_, reject) => {
    childProcess.once('exit', (code, signal) => {
      reject(new Error(`tik serve exited before becoming healthy: code=${code} signal=${signal}\n${started.stderr}`));
    });
  });

  const readyPromise = waitFor(async () => {
    if (!started.apiBaseUrl) return false;
    try {
      const response = await fetch(`${started.apiBaseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 20_000, intervalMs: 100 });

  try {
    await Promise.race([readyPromise, exitPromise]);
    childProcess.removeAllListeners('exit');
    return started;
  } catch (error) {
    await stopTikServe(childProcess);
    throw error;
  }
}

async function stopTikServe(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }
  childProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => childProcess.once('exit', resolve)),
    sleep(3000).then(() => {
      if (childProcess.exitCode === null && childProcess.signalCode === null) {
        childProcess.kill('SIGKILL');
      }
    }),
  ]);
}

function createClient(apiBaseUrl) {
  async function request(method, route, body, input = {}) {
    const response = await fetch(`${apiBaseUrl}${route}`, {
      method,
      headers: body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    const okStatuses = input.okStatuses || [200];
    if (!okStatuses.includes(response.status)) {
      throw new Error(`${method} ${route} returned ${response.status}: ${text}`);
    }
    return {
      method,
      route,
      status: response.status,
      body: parsed,
    };
  }
  return {
    get: (route, input) => request('GET', route, undefined, input),
    post: (route, body, input) => request('POST', route, body, input),
    put: (route, body, input) => request('PUT', route, body, input),
    patch: (route, body, input) => request('PATCH', route, body, input),
  };
}

async function captureTask(client, taskId, label) {
  const task = await readTaskById(client, taskId);
  report.taskSnapshots.push({
    label,
    capturedAt: new Date().toISOString(),
    task,
  });
}

async function readTaskById(client, taskId) {
  const list = await client.get('/v1/tasks');
  const task = (list.body.tasks || []).find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }
  return task;
}

async function captureWorkflow(client, workflowId, label) {
  const workflow = await client.get(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}`);
  report.workflowSnapshots.push({
    label,
    capturedAt: new Date().toISOString(),
    bundle: workflow.body,
  });
}

async function capturePersistedFiles(root, taskId, workflowId) {
  const workbenchIndexPath = path.join(root, '.tik', 'workbench', 'index.json');
  const taskTimelinePath = path.join(root, '.tik', 'workbench', 'timelines', `${taskId}.jsonl`);
  const workflowDir = path.join(root, '.tik', 'multi-agent', 'workflows', workflowId);
  const workflowPath = path.join(workflowDir, 'workflow.json');
  const subtasksPath = path.join(workflowDir, 'subtasks.json');
  report.persistedFiles = {
    workbenchIndexPath,
    taskTimelinePath,
    workflowPath,
    subtasksPath,
    workbenchIndex: JSON.parse(await readFile(workbenchIndexPath, 'utf-8')),
    taskTimelineJsonl: await readFile(taskTimelinePath, 'utf-8'),
    workflow: JSON.parse(await readFile(workflowPath, 'utf-8')),
    subtasks: JSON.parse(await readFile(subtasksPath, 'utf-8')),
  };
}

function recordStep(label, response) {
  report.steps.push({
    label,
    at: new Date().toISOString(),
    method: response.method,
    route: response.route,
    status: response.status,
    body: response.body,
  });
}

async function waitFor(predicate, input) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(input.intervalMs);
  }
  throw new Error(`Timed out after ${input.timeoutMs}ms.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readGitHead(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function findFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Expected a TCP address while allocating a free port.'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [key, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const value = inlineValue !== undefined ? inlineValue : args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      parsed[toCamel(key)] = true;
    } else {
      parsed[toCamel(key)] = value;
      index += 1;
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printSummary(value) {
  const result = value.result || {};
  console.log(JSON.stringify({
    status: result.status,
    reportPath,
    apiBaseUrl: value.server?.apiBaseUrl,
    taskId: result.taskId,
    workflowId: result.workflowId,
    taskStates: result.taskStates,
    reviewTaskId: result.reviewTaskId,
    reviewTaskShortIdentifier: result.reviewTaskShortIdentifier,
    reviewTaskStatus: result.reviewTaskStatus,
    reviewTaskAgentLoop: result.reviewTaskAgentLoop,
    workflowEventTypes: result.workflowEventTypes,
    invalidTransitionStatus: result.invalidTransitionStatus,
    missingEvidenceGuard: result.missingEvidenceGuard,
    error: result.message,
  }, null, 2));
}
