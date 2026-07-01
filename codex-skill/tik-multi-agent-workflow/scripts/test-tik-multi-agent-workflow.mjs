#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decideNextAction } from '../lib/loop-gate.mjs';

const scriptPath = new URL('./tik-multi-agent-workflow.mjs', import.meta.url).pathname;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-workflow-test-'));
const repo = path.join(tempRoot, 'repo');

let workflow = null;
let graph = null;
let subtasks = {};
let decisions = [];
let evidence = [];
let reviewTask = null;
let finalReviewTask = null;
let subtaskStatusHistory = [];
let events = [];

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
        events.push({ type: 'workflow.created', payload: { workflowId: workflow.id } });
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
          events,
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-cli/timeline') {
        sendJson(res, { events });
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
        events.push({ type: 'task_graph.created', payload: { version: graph.version } });
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
        events.push({ type: 'evidence.recorded', payload: { evidenceId: item.id, kind: item.kind, subtaskId: item.subtaskId } });
        sendJson(res, { evidence: item });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/st-api') {
        const body = await readRequestJson(req);
        subtasks['st-api'] = {
          ...subtasks['st-api'],
          ...body,
        };
        if (body.status) {
          subtaskStatusHistory.push(body.status);
        }
        events.push({ type: 'subtask.updated', payload: { subtaskId: 'st-api', status: subtasks['st-api'].status } });
        sendJson(res, { subtask: subtasks['st-api'] });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-cli/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-cli/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        if (route.endsWith('/decisions')) {
          decisions.push(body.decision);
          events.push({ type: 'decision.recorded', payload: { action: body.decision.action, subtaskId: body.decision.subtaskId } });
          if (body.decision.action === 'complete_workflow') {
            workflow = {
              ...workflow,
              status: 'completed',
              completedAt: new Date().toISOString(),
            };
            events.push({ type: 'workflow.completed', payload: { workflowId: workflow.id } });
          }
        }
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
        const isFinalReview = body.title?.includes('Final');
        const task = {
          id: isFinalReview ? 'task-final-review' : `task-review-${body.round || 1}`,
          shortIdentifier: isFinalReview ? 'TIK-FINAL' : `TIK-REVIEW-${body.round || 1}`,
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
        if (isFinalReview) {
          finalReviewTask = task;
        } else {
          reviewTask = task;
        }
        sendJson(res, { task });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: [reviewTask, finalReviewTask].filter(Boolean) });
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

  const validate = await run([
    'validate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--command', `${process.execPath} -e "process.exit(0)"`,
  ]);
  assert.equal(validate.action, 'validation-recorded');
  assert.equal(validate.passed, true);
  assert.equal(subtasks['st-api'].status, 'validated');

  const nextAfterValidation = await run(['next', '--api-base-url', apiBaseUrl, '--workflow', 'wf-cli']);
  assert.equal(nextAfterValidation.decision.action, 'request_claude_review');
  assert.equal(nextAfterValidation.decision.subtaskId, 'st-api');

  const legacyApprovedNext = decideNextAction({
    workflow,
    taskGraph: graph,
    subtasks: {
      'st-api': {
        ...subtasks['st-api'],
        status: 'approved',
      },
    },
  });
  assert.equal(legacyApprovedNext.action, 'request_claude_review');

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
  assert.equal(review.taskId, 'task-review-1');

  reviewTask = {
    ...reviewTask,
    status: 'in_review',
    labels: ['agent-loop', 'external-claude-review', 'human-review', 'needs-human-review'],
    agentLoop: {
      ...reviewTask.agentLoop,
      kind: 'human_review',
      phase: 'needs_human_review',
      reviewResult: {
        verdict: 'approve',
        headShaReviewed: 'different-head',
        currentHeadSha: 'different-head',
        blockingIssues: [],
        nonBlockingSuggestions: [],
        testsNeeded: [],
        markdown: 'Approved stale or unvalidated head.',
      },
    },
  };

  const processUnvalidatedApprove = await run([
    'process-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--task', 'task-review-1',
  ]);
  assert.equal(processUnvalidatedApprove.decision.action, 'validate_subtask');
  assert.match(processUnvalidatedApprove.instruction, /validation/i);

  subtasks['st-api'] = {
    ...subtasks['st-api'],
    status: 'reviewing',
  };
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
    '--task', 'task-review-1',
  ]);
  assert.equal(processReview.decision.action, 'fix_claude_blockers');
  assert.match(processReview.instruction, /Fix Claude blocking issues/);
  assert.equal(subtasks['st-api'].status, 'needs_fix');

  const fix = await run([
    'fix',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--review-round', 'task-review-1',
    '--summary', 'Fixed the Claude blocking issue',
  ]);
  assert.equal(fix.action, 'fix-recorded');
  assert.equal(fix.decision.action, 'validate_subtask');
  assert.equal(subtasks['st-api'].status, 'implemented');

  const validateAfterFix = await run([
    'validate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--command', `${process.execPath} -e "process.exit(0)"`,
  ]);
  assert.equal(validateAfterFix.action, 'validation-recorded');
  assert.equal(validateAfterFix.decision.action, 'request_re_review');
  assert.equal(subtasks['st-api'].status, 'validated');

  const continueToReview = await run([
    'continue',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--path', repo,
  ]);
  assert.equal(continueToReview.action, 'review-requested');
  assert.equal(continueToReview.decision.action, 'request_re_review');
  assert.equal(continueToReview.taskId, 'task-review-2');
  assert.equal(subtasks['st-api'].status, 'reviewing');

  reviewTask = {
    ...reviewTask,
    status: 'in_review',
    labels: ['agent-loop', 'external-claude-review', 'human-review', 'needs-human-review'],
    agentLoop: {
      ...reviewTask.agentLoop,
      kind: 'human_review',
      phase: 'needs_human_review',
      reviewResult: {
        verdict: 'approve',
        headShaReviewed: reviewTask.agentLoop.headSha,
        currentHeadSha: reviewTask.agentLoop.headSha,
        blockingIssues: [],
        nonBlockingSuggestions: [],
        testsNeeded: [],
        markdown: 'Approved after fix.',
      },
    },
  };

  const approveAfterFix = await run([
    'process-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--task', 'task-review-2',
  ]);
  assert.equal(approveAfterFix.decision.action, 'complete_subtask');
  assert.equal(subtasks['st-api'].status, 'done');
  assert.deepEqual(subtaskStatusHistory.slice(-2), ['review_approved', 'done']);

  const continueToFinalReview = await run([
    'continue',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--path', repo,
  ]);
  assert.equal(continueToFinalReview.action, 'final-review-requested');
  assert.equal(continueToFinalReview.decision.action, 'request_final_review');
  assert.equal(continueToFinalReview.taskId, 'task-final-review');

  finalReviewTask = {
    ...finalReviewTask,
    status: 'in_review',
    labels: ['agent-loop', 'external-claude-review', 'human-review', 'needs-human-review'],
    agentLoop: {
      ...finalReviewTask.agentLoop,
      kind: 'human_review',
      phase: 'needs_human_review',
      reviewResult: {
        verdict: 'approve',
        headShaReviewed: workflow.currentHeadSha,
        currentHeadSha: workflow.currentHeadSha,
        blockingIssues: [],
        nonBlockingSuggestions: [],
        testsNeeded: [],
        markdown: 'Final review approved.',
      },
    },
  };

  const finalApproval = await run([
    'process-final-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--task', 'task-final-review',
  ]);
  assert.equal(finalApproval.action, 'workflow-completed');
  assert.equal(finalApproval.decision.action, 'complete_workflow');
  assert.equal(workflow.status, 'completed');

  const status = await run([
    'status',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
  ]);
  assert.equal(status.action, 'status');
  assert.equal(Array.isArray(status.timeline), true);
  assert.equal(status.timeline.includes('workflow.completed'), true);

  await new Promise((resolve) => server.close(resolve));
  await assertRejectedExecutionDoesNotMutate(repo);
  await assertRejectedReviewDoesNotMutate(repo);
  await assertRejectedProcessReviewDoesNotMutate(repo);
  await assertRejectedProcessFinalReviewDoesNotMutate(repo);
  console.log('tik-multi-agent-workflow helper smoke test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function assertRejectedExecutionDoesNotMutate(repoPath) {
  let localWorkflow = {
    id: 'wf-reject-execute',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Reject execution',
    rootTaskId: 'wf-reject-execute',
    repo: 'repo',
    baseRef: 'main',
    headRef: 'main',
    currentHeadSha: gitHead(repoPath),
    maxRounds: 3,
  };
  let localSubtasks = {
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
  let localEvidence = [];
  const localGraph = buildGraph('wf-reject-execute');
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-reject-execute') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions: [], evidence: localEvidence });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-reject-execute/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-reject-execute/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        sendJson(res, {
          decision: body.decision,
          guard: { accepted: false, code: 'invalid_transition', message: 'Rejected by test guard.' },
          workflow: localWorkflow,
        }, 409);
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-reject-execute/evidence') {
        const body = await readRequestJson(req);
        localEvidence.push({ id: body.id || 'ev-should-not-exist', ...body });
        sendJson(res, { evidence: localEvidence.at(-1) });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-reject-execute/subtasks/st-api') {
        const body = await readRequestJson(req);
        localSubtasks['st-api'] = { ...localSubtasks['st-api'], ...body };
        sendJson(res, { subtask: localSubtasks['st-api'] });
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
  const rejected = await run([
    'execute',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-reject-execute',
    '--subtask', 'st-api',
    '--summary', 'Should not mutate',
  ]);
  assert.equal(rejected.guard.accepted, false);
  assert.equal(localEvidence.length, 0);
  assert.equal(localSubtasks['st-api'].status, 'ready');
  await new Promise((resolve) => server.close(resolve));
}

async function assertRejectedReviewDoesNotMutate(repoPath) {
  const headSha = gitHead(repoPath);
  let reviewCreated = false;
  let localWorkflow = {
    id: 'wf-reject-review',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Reject review',
    rootTaskId: 'wf-reject-review',
    repo: 'repo',
    baseRef: 'main',
    headRef: 'main',
    currentHeadSha: headSha,
    maxRounds: 3,
  };
  let localSubtasks = {
    'st-api': {
      subtaskId: 'st-api',
      status: 'validated',
      reviewRoundIds: [],
      validationRunIds: ['ev-validation'],
      evidenceRefs: ['ev-validation'],
      blockerFindingIds: [],
      fixRound: 0,
    },
  };
  const localEvidence = [{
    id: 'ev-validation',
    workflowId: 'wf-reject-review',
    subtaskId: 'st-api',
    kind: 'validation',
    title: 'Validation',
    passed: true,
    headSha,
    createdAt: new Date().toISOString(),
  }];
  const localGraph = buildGraph('wf-reject-review');
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-reject-review') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions: [], evidence: localEvidence });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-reject-review/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-reject-review/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        sendJson(res, {
          decision: body.decision,
          guard: { accepted: false, code: 'invalid_transition', message: 'Rejected by test guard.' },
          workflow: localWorkflow,
        }, 409);
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/worktree-review-rounds') {
        reviewCreated = true;
        sendJson(res, { task: { id: 'task-review', shortIdentifier: 'TIK-REJECT' } });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-reject-review/subtasks/st-api') {
        const body = await readRequestJson(req);
        localSubtasks['st-api'] = { ...localSubtasks['st-api'], ...body };
        sendJson(res, { subtask: localSubtasks['st-api'] });
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
  const rejected = await run([
    'review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-reject-review',
    '--subtask', 'st-api',
    '--path', repoPath,
  ]);
  assert.equal(rejected.guard.accepted, false);
  assert.equal(reviewCreated, false);
  assert.equal(localSubtasks['st-api'].status, 'validated');
  assert.deepEqual(localSubtasks['st-api'].reviewRoundIds, []);
  await new Promise((resolve) => server.close(resolve));
}

async function assertRejectedProcessReviewDoesNotMutate(repoPath) {
  const headSha = gitHead(repoPath);
  let localWorkflow = {
    id: 'wf-reject-process-review',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Reject process review',
    rootTaskId: 'wf-reject-process-review',
    repo: 'repo',
    baseRef: 'main',
    headRef: 'main',
    currentHeadSha: headSha,
    maxRounds: 3,
  };
  let localSubtasks = {
    'st-api': {
      subtaskId: 'st-api',
      status: 'reviewing',
      reviewRoundIds: ['task-review'],
      validationRunIds: ['ev-validation'],
      evidenceRefs: ['ev-validation'],
      blockerFindingIds: [],
      fixRound: 0,
    },
  };
  const localEvidence = [{
    id: 'ev-validation',
    workflowId: 'wf-reject-process-review',
    subtaskId: 'st-api',
    kind: 'validation',
    title: 'Validation',
    passed: true,
    headSha,
    createdAt: new Date().toISOString(),
  }];
  const localGraph = buildGraph('wf-reject-process-review');
  const reviewTask = {
    id: 'task-review',
    shortIdentifier: 'TIK-REJECT-PROCESS',
    agentLoop: {
      reviewResult: {
        verdict: 'approve',
        headShaReviewed: headSha,
        currentHeadSha: headSha,
        blockingIssues: [],
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-reject-process-review') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions: [], evidence: localEvidence });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: [reviewTask] });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-reject-process-review/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-reject-process-review/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        sendJson(res, {
          decision: body.decision,
          guard: { accepted: false, code: 'invalid_transition', message: 'Rejected by test guard.' },
          workflow: localWorkflow,
        }, 409);
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-reject-process-review/evidence') {
        const body = await readRequestJson(req);
        localEvidence.push({ id: body.id || 'ev-should-not-exist', workflowId: localWorkflow.id, ...body });
        sendJson(res, { evidence: localEvidence.at(-1) });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-reject-process-review/subtasks/st-api') {
        const body = await readRequestJson(req);
        localSubtasks['st-api'] = { ...localSubtasks['st-api'], ...body };
        sendJson(res, { subtask: localSubtasks['st-api'] });
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
  const rejected = await run([
    'process-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-reject-process-review',
    '--subtask', 'st-api',
    '--task', 'task-review',
  ]);
  assert.equal(rejected.guard.accepted, false);
  assert.equal(localEvidence.length, 1);
  assert.equal(localSubtasks['st-api'].status, 'reviewing');
  await new Promise((resolve) => server.close(resolve));
}

async function assertRejectedProcessFinalReviewDoesNotMutate(repoPath) {
  const headSha = gitHead(repoPath);
  let localWorkflow = {
    id: 'wf-reject-process-final-review',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Reject process final review',
    rootTaskId: 'wf-reject-process-final-review',
    repo: 'repo',
    baseRef: 'main',
    headRef: 'main',
    currentHeadSha: headSha,
    maxRounds: 3,
  };
  const localSubtasks = {
    'st-api': {
      subtaskId: 'st-api',
      status: 'done',
      reviewRoundIds: ['task-review'],
      validationRunIds: ['ev-validation'],
      evidenceRefs: ['ev-validation', 'ev-review'],
      blockerFindingIds: [],
      fixRound: 0,
    },
  };
  const localEvidence = [];
  const localGraph = buildGraph('wf-reject-process-final-review');
  const reviewTask = {
    id: 'task-final-review',
    shortIdentifier: 'TIK-REJECT-FINAL',
    agentLoop: {
      reviewResult: {
        verdict: 'approve',
        headShaReviewed: headSha,
        currentHeadSha: headSha,
        blockingIssues: [],
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-reject-process-final-review') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions: [], evidence: localEvidence });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: [reviewTask] });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-reject-process-final-review/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-reject-process-final-review/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        sendJson(res, {
          decision: body.decision,
          guard: { accepted: false, code: 'invalid_transition', message: 'Rejected by test guard.' },
          workflow: localWorkflow,
        }, 409);
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-reject-process-final-review/evidence') {
        const body = await readRequestJson(req);
        localEvidence.push({ id: body.id || 'ev-final-should-not-exist', workflowId: localWorkflow.id, ...body });
        sendJson(res, { evidence: localEvidence.at(-1) });
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
  const rejected = await run([
    'process-final-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-reject-process-final-review',
    '--task', 'task-final-review',
  ]);
  assert.equal(rejected.guard.accepted, false);
  assert.equal(localEvidence.length, 0);
  assert.equal(localWorkflow.status, 'active');
  await new Promise((resolve) => server.close(resolve));
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

function gitHead(repoPath) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).stdout.trim();
}

function buildGraph(workflowId) {
  return {
    workflowId,
    version: 1,
    createdBy: 'claude-code',
    subtasks: [{
      id: 'st-api',
      title: 'API',
      goal: 'Implement API',
      dependsOn: [],
      allowedPaths: ['packages/kernel/src/**'],
      acceptanceCriteria: ['API works'],
      validationCommands: [`${process.execPath} -e "process.exit(0)"`],
      reviewFocus: ['routes'],
      assignedExecutor: 'codex',
      assignedReviewer: 'claude-code',
    }],
    risks: [],
    globalAcceptanceCriteria: [],
    finalValidationCommands: [],
  };
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
