#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
let contracts = [];
let evaluationRuns = [];
let questionerOutputs = [];
let invocations = [];
let reviewTask = null;
let finalReviewTask = null;
let reviewTasks = {};
let rootTask = null;
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
          policy: body.policy,
          metadata: body.metadata,
        };
        events.push({ type: 'workflow.created', payload: { workflowId: workflow.id } });
        sendJson(res, { workflow });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/tasks') {
        const body = await readRequestJson(req);
        rootTask = {
          id: body.id || 'task-root',
          identifier: 'TIK-ROOT',
          shortIdentifier: 'TIK-ROOT',
          title: body.title,
          description: body.description,
          goal: body.goal,
          status: body.status || 'new',
          priority: body.priority,
          labels: body.labels || [],
          comments: [],
          workspaceBinding: body.workspaceBinding,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        sendJson(res, { task: rootTask });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/tasks/task-root/comments') {
        const body = await readRequestJson(req);
        rootTask = {
          ...rootTask,
          comments: [
            ...(rootTask.comments || []),
            {
              id: 'comment-root-1',
              authorKind: body.authorKind || 'agent',
              authorId: body.authorId,
              body: body.body,
              createdAt: new Date().toISOString(),
            },
          ],
          updatedAt: new Date().toISOString(),
        };
        sendJson(res, { task: rootTask });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/tasks/task-root/transitions') {
        const body = await readRequestJson(req);
        rootTask = {
          ...rootTask,
          status: body.to,
          updatedAt: new Date().toISOString(),
        };
        sendJson(res, { task: rootTask });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-cli') {
        sendJson(res, {
          workflow,
          taskGraph: graph,
          subtasks,
          decisions,
          evidence,
          contracts,
          evaluationRuns,
          questionerOutputs,
          invocations,
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
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/__final__') {
        sendJson(res, { subtask: { subtaskId: '__final__', ...await readRequestJson(req) } });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/st-api/contracts') {
        const body = await readRequestJson(req);
        const contract = {
          id: body.id || 'contract-st-api-v1',
          workflowId: 'wf-cli',
          subtaskId: 'st-api',
          ...body,
        };
        contracts.push(contract);
        events.push({ type: 'contract.created', payload: { contractId: contract.id, subtaskId: 'st-api' } });
        sendJson(res, { contract });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/st-api/contracts/contract-st-api-v1/accept') {
        const body = await readRequestJson(req);
        const contract = {
          ...contracts.find((item) => item.id === 'contract-st-api-v1'),
          status: 'accepted',
          acceptedBy: body.acceptedBy,
          acceptedAt: new Date().toISOString(),
          headShaAtAcceptance: body.headShaAtAcceptance,
        };
        contracts = contracts.filter((item) => item.id !== contract.id).concat(contract);
        events.push({ type: 'contract.accepted', payload: { contractId: contract.id, subtaskId: 'st-api' } });
        sendJson(res, { contract });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/st-api/evaluations') {
        const body = await readRequestJson(req);
        const evaluationRun = {
          id: body.id || 'eval-st-api-v1',
          workflowId: 'wf-cli',
          subtaskId: 'st-api',
          status: 'created',
          readonlyPolicy: {
            enforced: true,
            allowedWritePaths: ['.tik/multi-agent/'],
            forbiddenWritePaths: ['packages/'],
          },
          artifactRefs: [],
          startedAt: new Date().toISOString(),
          ...body,
        };
        evaluationRuns.push(evaluationRun);
        events.push({ type: 'evaluation.created', payload: { evaluationRunId: evaluationRun.id, subtaskId: 'st-api' } });
        sendJson(res, { evaluationRun });
        return;
      }
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/subtasks\/st-api\/evaluations\/[^/]+\/validate-readonly$/)) {
        const evaluationRunId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        evaluationRuns = evaluationRuns.map((run) => run.id === evaluationRunId
          ? {
            ...run,
            readonlyPolicy: {
              ...run.readonlyPolicy,
              gitStatusBefore: body.gitStatusBefore,
              gitStatusAfter: body.gitStatusAfter,
              violations: [],
            },
          }
          : run);
        sendJson(res, { evaluationRun: evaluationRuns.find((run) => run.id === evaluationRunId), guard: { accepted: true, code: 'ok' } });
        return;
      }
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/subtasks\/st-api\/evaluations\/[^/]+\/result$/)) {
        const evaluationRunId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        evaluationRuns = evaluationRuns.map((run) => run.id === evaluationRunId
          ? {
            ...run,
            status: evaluationStatusForVerdict(body.result.verdict),
            result: body.result,
            completedAt: new Date().toISOString(),
          }
          : run);
        events.push({ type: 'evaluation.result.recorded', payload: { evaluationRunId, subtaskId: 'st-api' } });
        sendJson(res, { evaluationRun: evaluationRuns.find((run) => run.id === evaluationRunId) });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/__final__/evaluations') {
        const body = await readRequestJson(req);
        const evaluationRun = {
          id: body.id || 'eval-final-v1',
          workflowId: 'wf-cli',
          subtaskId: '__final__',
          status: 'created',
          readonlyPolicy: {
            enforced: true,
            allowedWritePaths: ['.tik/multi-agent/'],
            forbiddenWritePaths: ['packages/'],
          },
          artifactRefs: [],
          startedAt: new Date().toISOString(),
          ...body,
        };
        evaluationRuns.push(evaluationRun);
        sendJson(res, { evaluationRun });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/__final__/evaluations/eval-final-v1/validate-readonly') {
        evaluationRuns = evaluationRuns.map((run) => run.id === 'eval-final-v1'
          ? {
            ...run,
            readonlyPolicy: {
              ...run.readonlyPolicy,
              violations: [],
            },
          }
          : run);
        sendJson(res, { evaluationRun: evaluationRuns.find((run) => run.id === 'eval-final-v1'), guard: { accepted: true, code: 'ok' } });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/subtasks/__final__/evaluations/eval-final-v1/result') {
        const body = await readRequestJson(req);
        evaluationRuns = evaluationRuns.map((run) => run.id === 'eval-final-v1'
          ? {
            ...run,
            status: evaluationStatusForVerdict(body.result.verdict),
            result: body.result,
            completedAt: new Date().toISOString(),
          }
          : run);
        sendJson(res, { evaluationRun: evaluationRuns.find((run) => run.id === 'eval-final-v1') });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/questioner-outputs') {
        const body = await readRequestJson(req);
        const questionerOutput = {
          id: body.id || 'q-cli',
          workflowId: 'wf-cli',
          createdAt: new Date().toISOString(),
          ...body,
        };
        questionerOutputs.push(questionerOutput);
        events.push({ type: 'questioner.output.recorded', payload: { questionerOutputId: questionerOutput.id } });
        sendJson(res, { questionerOutput });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/agent-invocations') {
        const body = await readRequestJson(req);
        const invocation = {
          id: body.id || `inv-${invocations.length + 1}`,
          workflowId: 'wf-cli',
          status: 'created',
          attestationToken: `att-${body.id || invocations.length + 1}`,
          hookAttested: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...body,
        };
        invocations.push(invocation);
        events.push({ type: 'agent_invocation.created', payload: { invocationId: invocation.id, role: invocation.role, runner: invocation.runner } });
        sendJson(res, { invocation });
        return;
      }
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/agent-invocations\/[^/]+\/hook-start$/)) {
        const invocationId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        invocations = invocations.map((item) => item.id === invocationId
          ? {
            ...item,
            status: 'started',
            hookAttested: true,
            threadId: body.actualSubagentThreadId,
            actualSubagentThreadId: body.actualSubagentThreadId,
            parentThreadId: body.parentThreadId,
            runtimeAttestation: {
              source: 'codex-plugin-hook',
              parentThreadId: body.parentThreadId,
              actualSubagentThreadId: body.actualSubagentThreadId,
              role: item.role,
              startedAt: body.startedAt || new Date().toISOString(),
            },
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          : item);
        sendJson(res, { invocation: invocations.find((item) => item.id === invocationId) });
        return;
      }
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/agent-invocations\/[^/]+\/hook-stop$/)) {
        const invocationId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        invocations = invocations.map((item) => item.id === invocationId
          ? {
            ...item,
            ...body,
            status: body.status,
            result: body.result,
            headSha: body.headSha,
            evidenceRefs: body.evidenceRefs || item.evidenceRefs,
            evaluationRunId: body.evaluationRunId,
            readonlyPolicy: body.readonlyPolicy,
            runtimeAttestation: {
              ...item.runtimeAttestation,
              stoppedAt: body.stoppedAt || new Date().toISOString(),
              headSha: body.headSha,
              evidenceRefs: body.evidenceRefs,
              readonlyPolicy: body.readonlyPolicy,
            },
            attestationToken: undefined,
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          : item);
        sendJson(res, { invocation: invocations.find((item) => item.id === invocationId) });
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
        assert.equal(body.rootTaskId, 'task-root');
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
          setReviewTask(task);
        }
        sendJson(res, { task });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: [rootTask, ...Object.values(reviewTasks), finalReviewTask].filter(Boolean) });
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

  const createdTask = await run([
    'create-task',
    '--api-base-url', apiBaseUrl,
    '--path', repo,
    '--title', 'Formal workflow task',
    '--goal', 'Carry a full multi-agent workflow',
    '--status', 'todo',
    '--label', 'multi-agent,formal-workflow',
  ]);
  assert.equal(createdTask.action, 'task-created');
  assert.equal(createdTask.taskId, 'task-root');
  assert.equal(createdTask.shortIdentifier, 'TIK-ROOT');
  assert.equal(rootTask.status, 'todo');

  const commentedTask = await run([
    'comment-task',
    '--api-base-url', apiBaseUrl,
    '--task', 'TIK-ROOT',
    '--body', 'Formal workflow started through the skill.',
  ]);
  assert.equal(commentedTask.action, 'task-commented');
  assert.equal(rootTask.comments.length, 1);

  const transitionedTask = await run([
    'transition-task',
    '--api-base-url', apiBaseUrl,
    '--task', 'TIK-ROOT',
    '--to', 'in_progress',
    '--reason', 'Workflow execution started.',
  ]);
  assert.equal(transitionedTask.action, 'task-transitioned');
  assert.equal(rootTask.status, 'in_progress');

  const init = await run([
    'init',
    '--api-base-url', apiBaseUrl,
    '--path', repo,
    '--goal', 'Implement auth workflow',
    '--root-task', 'task-root',
    '--workflow', 'wf-cli',
    '--parent-thread', 'workflow-thread-cli',
    '--base', 'main',
  ]);
  assert.equal(init.action, 'initialized');
  assert.equal(init.workflowId, 'wf-cli');
  assert.equal(init.rootTaskId, 'task-root');
  assert.equal(workflow.metadata.parentCodexThreadId, 'workflow-thread-cli');

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
      globalAcceptanceCriteria: ['Workflow finishes with guarded evidence.'],
      finalValidationCommands: [`${process.execPath} -e "process.exit(0)"`],
    }),
  ]);
  assert.equal(putGraph.action, 'accepted-plan');

  const next = await run(['next', '--api-base-url', apiBaseUrl, '--workflow', 'wf-cli']);
  assert.equal(next.decision.action, 'execute_subtask');
  assert.equal(next.decision.subtaskId, 'st-api');
  assert.match(next.instruction, /Implement subtask st-api/);

  const builderStarted = await run([
    'start-builder',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--invocation', 'inv-builder-cli',
    '--parent-thread', 'workflow-thread-cli',
    '--thread', 'builder-thread-cli',
    '--path', repo,
  ]);
  assert.equal(builderStarted.action, 'builder-started');
  assert.equal(builderStarted.invocation.status, 'started');
  assert.equal(builderStarted.invocation.threadId, 'builder-thread-cli');
  assert.equal(builderStarted.attestationToken, 'att-inv-builder-cli');

  subtasks['st-api'] = {
    ...subtasks['st-api'],
    evidenceRefs: ['ev-preflight-questioner'],
  };

  const execute = await run([
    'execute',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--summary', 'Implemented API',
    '--changed-files', 'packages/kernel/src/multi-agent/guard.ts,packages/kernel/src/server.ts',
    '--observed-changed-files', 'packages/kernel/src/multi-agent/guard.ts,packages/kernel/src/server.ts',
    '--invocation', 'inv-builder-cli',
    '--attestation-token', builderStarted.attestationToken,
  ]);
  assert.equal(execute.action, 'execution-recorded');
  assert.equal(subtasks['st-api'].status, 'implemented');
  assert.deepEqual(subtasks['st-api'].evidenceRefs, ['ev-preflight-questioner', 'ev-cli']);
  assert.equal(execute.invocation.status, 'completed');
  assert.deepEqual(execute.invocation.evidenceRefs, ['ev-cli']);
  assert.deepEqual(evidence[0].payload.changedFiles, [
    { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
    { path: 'packages/kernel/src/server.ts', changeType: 'modified' },
  ]);
  assert.deepEqual(evidence[0].payload.declaredChangedFiles, [
    { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
    { path: 'packages/kernel/src/server.ts', changeType: 'modified' },
  ]);
  assert.deepEqual(evidence[0].payload.observedChangedFiles, [
    { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
    { path: 'packages/kernel/src/server.ts', changeType: 'modified' },
  ]);

  const validate = await run([
    'validate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--evidence-id', 'ev-validation-cli',
    '--command', `${process.execPath} -e "console.log('validation ok')"`,
  ]);
  assert.equal(validate.action, 'validation-recorded');
  assert.equal(validate.passed, true);
  assert.equal(validate.evidence.artifactRef, '.tik/multi-agent/workflows/wf-cli/validation/st-api/ev-validation-cli.stdout.log');
  assert.match(await readFile(path.join(repo, validate.evidence.artifactRef), 'utf-8'), /validation ok/);
  assert.equal(subtasks['st-api'].status, 'validated');
  assert.deepEqual(subtasks['st-api'].evidenceRefs, ['ev-preflight-questioner', 'ev-cli', 'ev-validation-cli']);

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

  const v1Policy = {
    requireAcceptedContract: true,
    requireEvaluationPassForComplete: true,
    requireQuestionerAfterEvaluation: true,
    requireSameHeadShaForEvidence: true,
  };
  const v1DraftContractNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'ready',
        evidenceRefs: [],
      },
    },
    contracts: [],
    evaluationRuns: [],
    questionerOutputs: [],
  });
  assert.equal(v1DraftContractNext.action, 'draft_contract');
  assert.equal(v1DraftContractNext.subtaskId, 'st-api');

  const v1EvaluateNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'implemented',
        evidenceRefs: ['ev-impl'],
      },
    },
    evidence: [{ id: 'ev-impl', kind: 'implementation', subtaskId: 'st-api', headSha: workflow.currentHeadSha, createdAt: new Date().toISOString() }],
    contracts: [{
      id: 'contract-st-api-v1',
      subtaskId: 'st-api',
      status: 'accepted',
      version: 1,
      acceptedAt: new Date().toISOString(),
    }],
    evaluationRuns: [],
    questionerOutputs: [],
  });
  assert.equal(v1EvaluateNext.action, 'run_codex_evaluator');
  assert.equal(v1EvaluateNext.subtaskId, 'st-api');

  const v1QuestionEvaluationNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'evaluation_passed',
        evidenceRefs: ['ev-impl'],
      },
    },
    evidence: [{ id: 'ev-impl', kind: 'implementation', subtaskId: 'st-api', headSha: workflow.currentHeadSha, createdAt: new Date().toISOString() }],
    contracts: [{
      id: 'contract-st-api-v1',
      subtaskId: 'st-api',
      status: 'accepted',
      version: 1,
      acceptedAt: new Date().toISOString(),
    }],
    evaluationRuns: [{
      id: 'eval-pass',
      subtaskId: 'st-api',
      status: 'passed',
      headSha: workflow.currentHeadSha,
      result: { verdict: 'pass', headSha: workflow.currentHeadSha },
      startedAt: new Date().toISOString(),
    }],
    questionerOutputs: [],
  });
  assert.equal(v1QuestionEvaluationNext.action, 'ask_claude_question_evaluation');
  assert.equal(v1QuestionEvaluationNext.subtaskId, 'st-api');

  const v1ReadonlyViolationNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'evaluation_failed',
        evidenceRefs: ['ev-impl'],
      },
    },
    evidence: [{ id: 'ev-impl', kind: 'implementation', subtaskId: 'st-api', headSha: workflow.currentHeadSha, createdAt: new Date().toISOString() }],
    contracts: [{
      id: 'contract-st-api-v1',
      subtaskId: 'st-api',
      status: 'accepted',
      version: 1,
      acceptedAt: new Date().toISOString(),
    }],
    evaluationRuns: [{
      id: 'eval-invalidated',
      subtaskId: 'st-api',
      status: 'invalidated',
      headSha: workflow.currentHeadSha,
      readonlyPolicy: {
        enforced: true,
        allowedWritePaths: ['.tik/multi-agent/'],
        forbiddenWritePaths: ['packages/'],
        violations: ['packages/kernel/src/multi-agent/guard.ts'],
      },
      result: { verdict: 'fail', headSha: workflow.currentHeadSha },
      startedAt: new Date().toISOString(),
    }],
    questionerOutputs: [],
  });
  assert.equal(v1ReadonlyViolationNext.action, 'request_human_review');
  assert.equal(v1ReadonlyViolationNext.inputs.evaluationRunId, 'eval-invalidated');

  const v1CompleteNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'questioning_evidence',
        evidenceRefs: ['ev-impl'],
      },
    },
    evidence: [{ id: 'ev-impl', kind: 'implementation', subtaskId: 'st-api', headSha: workflow.currentHeadSha, createdAt: new Date().toISOString() }],
    contracts: [{
      id: 'contract-st-api-v1',
      subtaskId: 'st-api',
      status: 'accepted',
      version: 1,
      acceptedAt: new Date().toISOString(),
    }],
    evaluationRuns: [{
      id: 'eval-pass',
      subtaskId: 'st-api',
      status: 'passed',
      headSha: workflow.currentHeadSha,
      result: { verdict: 'pass', headSha: workflow.currentHeadSha },
      startedAt: new Date().toISOString(),
    }],
    questionerOutputs: [{
      id: 'q-clear',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      verdict: 'evidence_sufficient',
      questions: [],
      createdAt: new Date().toISOString(),
    }],
  });
  assert.equal(v1CompleteNext.action, 'complete_subtask');
  assert.equal(v1CompleteNext.subtaskId, 'st-api');

  const v1FinalEvaluationNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'done',
        evidenceRefs: ['ev-impl'],
      },
    },
    evaluationRuns: [],
    questionerOutputs: [],
  });
  assert.equal(v1FinalEvaluationNext.action, 'run_final_evaluation');

  const v1FinalQuestionerNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'done',
        evidenceRefs: ['ev-impl'],
      },
    },
    evaluationRuns: [{
      id: 'eval-final-pass',
      subtaskId: '__final__',
      status: 'passed',
      headSha: workflow.currentHeadSha,
      result: { verdict: 'pass', headSha: workflow.currentHeadSha },
      startedAt: new Date().toISOString(),
    }],
    questionerOutputs: [],
  });
  assert.equal(v1FinalQuestionerNext.action, 'ask_claude_question_final_evidence');

  const v1WorkflowCompleteNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'done',
        evidenceRefs: ['ev-impl'],
      },
    },
    evaluationRuns: [{
      id: 'eval-final-pass',
      subtaskId: '__final__',
      status: 'passed',
      headSha: workflow.currentHeadSha,
      result: { verdict: 'pass', headSha: workflow.currentHeadSha },
      startedAt: new Date().toISOString(),
    }],
    questionerOutputs: [{
      id: 'q-final-clear',
      intent: 'question_final_evidence',
      verdict: 'evidence_sufficient',
      questions: [],
      createdAt: new Date().toISOString(),
    }],
  });
  assert.equal(v1WorkflowCompleteNext.action, 'complete_workflow');

  const draftedContract = await run([
    'draft-contract',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
  ]);
  assert.equal(draftedContract.action, 'contract-drafted');
  assert.equal(draftedContract.contract.id, 'contract-st-api-v1');
  assert.equal(contracts[0].status, 'draft');

  const acceptedContract = await run([
    'accept-contract',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--contract', 'contract-st-api-v1',
  ]);
  assert.equal(acceptedContract.action, 'contract-accepted');
  assert.equal(acceptedContract.contract.status, 'accepted');
  assert.equal(subtasks['st-api'].status, 'contract_accepted');

  const evaluatorStarted = await run([
    'start-evaluator',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--invocation', 'inv-evaluator-cli',
    '--parent-thread', 'workflow-thread-cli',
    '--thread', 'evaluator-thread-cli',
    '--path', repo,
    '--evaluator-artifact-path', 'reports/evaluator/',
    '--evaluator-artifact-path', 'custom-artifacts/result.json',
  ]);
  assert.equal(evaluatorStarted.action, 'evaluator-started');
  assert.equal(evaluatorStarted.invocation.status, 'started');
  assert.equal(evaluatorStarted.invocation.threadId, 'evaluator-thread-cli');
  assert.equal(evaluatorStarted.attestationToken, 'att-inv-evaluator-cli');
  assert.ok(evaluatorStarted.invocation.allowedPaths.includes('.tik/multi-agent/'));
  assert.ok(evaluatorStarted.invocation.allowedPaths.includes('reports/evaluator/'));
  assert.ok(evaluatorStarted.invocation.allowedPaths.includes('custom-artifacts/result.json'));

  const evaluated = await run([
    'evaluate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--evaluation', 'eval-st-api-v1',
    '--command', `${process.execPath} -e "console.log('evaluation ok')"`,
    '--invocation', 'inv-evaluator-cli',
    '--attestation-token', evaluatorStarted.attestationToken,
  ]);
  assert.equal(evaluated.action, 'evaluation-recorded');
  assert.equal(evaluated.passed, true);
  assert.equal(evaluated.invocation.status, 'completed');
  assert.equal(evaluated.invocation.evaluationRunId, 'eval-st-api-v1');
  assert.equal(evaluated.invocation.threadId, 'evaluator-thread-cli');
  assert.equal(evaluationRuns[0].status, 'passed');
  assert.equal(
    evaluated.evaluationRun.result.commandResults[0].stdoutArtifactId,
    '.tik/multi-agent/workflows/wf-cli/evaluations/eval-st-api-v1/stdout.log',
  );
  assert.match(
    await readFile(path.join(repo, evaluated.evaluationRun.result.commandResults[0].stdoutArtifactId), 'utf-8'),
    /evaluation ok/,
  );
  assert.equal(subtasks['st-api'].status, 'evaluation_passed');

  const thinEvaluated = await run([
    'evaluate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--evaluation', 'eval-thin-cli',
    '--infer-command', 'false',
    '--result-json', JSON.stringify({ verdict: 'pass' }),
  ]);
  assert.equal(thinEvaluated.action, 'evaluation-recorded');
  assert.equal(thinEvaluated.passed, false);
  assert.equal(thinEvaluated.evaluationRun.status, 'inconclusive');
  assert.equal(thinEvaluated.evaluationRun.result.verdict, 'inconclusive');
  assert.equal(
    thinEvaluated.evaluationRun.result.coverageGaps[0].reason,
    'No evaluator command, criteria result, or artifact evidence was provided.',
  );

  evaluationRuns = evaluationRuns.filter((run) => run.id !== 'eval-thin-cli');
  subtasks['st-api'] = {
    ...subtasks['st-api'],
    status: 'evaluation_passed',
    validationRunIds: ['eval-st-api-v1'],
  };

  const questioned = await run([
    'record-questioner',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--intent', 'question_evaluation',
    '--invocation', 'claude-questioner-cli',
    '--head-sha', 'head-v1',
    '--contract', 'contract-st-api-v1',
    '--evaluation', 'eval-st-api-v1',
    '--artifact-ref', '.tik/multi-agent/workflows/wf-cli/questioner/q-cli.json',
    '--verdict', 'evidence_sufficient',
  ]);
  assert.equal(questioned.action, 'questioner-output-recorded');
  assert.equal(questionerOutputs[0].intent, 'question_evaluation');
  assert.equal(subtasks['st-api'].status, 'questioning_evidence');

  const v1CompletedSubtask = await run([
    'complete-subtask',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
  ]);
  assert.equal(v1CompletedSubtask.action, 'subtask-completed');
  assert.equal(v1CompletedSubtask.decision.action, 'complete_subtask');
  assert.equal(subtasks['st-api'].status, 'done');

  const finalEvaluated = await run([
    'evaluate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', '__final__',
    '--evaluation', 'eval-final-v1',
    '--command', `${process.execPath} -e "process.exit(0)"`,
  ]);
  assert.equal(finalEvaluated.action, 'evaluation-recorded');
  assert.equal(finalEvaluated.passed, true);

  const finalQuestioned = await run([
    'record-questioner',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--intent', 'question_final_evidence',
    '--invocation', 'claude-final-questioner-cli',
    '--head-sha', 'head-v1',
    '--evaluation', 'eval-final-v1',
    '--artifact-ref', '.tik/multi-agent/workflows/wf-cli/questioner/q-final-cli.json',
    '--verdict', 'evidence_sufficient',
  ]);
  assert.equal(finalQuestioned.action, 'questioner-output-recorded');

  const v1CompletedWorkflow = await run([
    'complete-workflow',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
  ]);
  assert.equal(v1CompletedWorkflow.action, 'workflow-completed');
  assert.equal(v1CompletedWorkflow.decision.action, 'complete_workflow');
  assert.equal(workflow.status, 'completed');

  subtasks['st-api'] = {
    ...subtasks['st-api'],
    status: 'validated',
    evidenceRefs: mergeTestRefs(subtasks['st-api'].evidenceRefs, ['ev-cli']),
    validationRunIds: mergeTestRefs(subtasks['st-api'].validationRunIds, ['ev-cli']),
  };

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
    status: 'blocked',
    labels: ['agent-loop', 'external-claude-review', 'stale-head'],
    agentLoop: {
      ...reviewTask.agentLoop,
      phase: 'stale',
      stale: {
        expectedHeadSha: reviewTask.agentLoop.headSha,
        actualHeadSha: 'new-head-after-review-started',
      },
      reviewResult: undefined,
    },
  };
  setReviewTask(reviewTask);

  const staleReview = await run([
    'process-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--task', 'task-review-1',
  ]);
  assert.equal(staleReview.action, 'review-stale');
  assert.equal(staleReview.stale.actualHeadSha, 'new-head-after-review-started');
  assert.equal(subtasks['st-api'].status, 'validated');
  assert.deepEqual(subtasks['st-api'].reviewRoundIds, []);

  const freshReview = await run([
    'review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--path', repo,
    '--round', '1',
    '--max-rounds', '2',
  ]);
  assert.equal(freshReview.action, 'review-requested');
  assert.equal(freshReview.taskId, 'task-review-1');
  assert.equal(subtasks['st-api'].status, 'reviewing');
  assert.deepEqual(subtasks['st-api'].reviewRoundIds, ['task-review-1']);

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
  setReviewTask(reviewTask);

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
  setReviewTask(reviewTask);

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
  setReviewTask(reviewTask);

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
    status: 'blocked',
    labels: ['agent-loop', 'external-claude-review', 'final-claude-review', 'stale-head'],
    agentLoop: {
      ...finalReviewTask.agentLoop,
      phase: 'stale',
      stale: {
        expectedHeadSha: workflow.currentHeadSha,
        actualHeadSha: 'new-final-head',
      },
      reviewResult: undefined,
    },
  };

  const staleFinalReview = await run([
    'process-final-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--task', 'task-final-review',
  ]);
  assert.equal(staleFinalReview.action, 'final-review-stale');
  assert.equal(staleFinalReview.stale.actualHeadSha, 'new-final-head');

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

function evaluationStatusForVerdict(verdict) {
  if (verdict === 'pass') return 'passed';
  if (verdict === 'inconclusive') return 'inconclusive';
  return 'failed';
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

function mergeTestRefs(...groups) {
  return Array.from(new Set(groups.flatMap((group) => group || []).filter(Boolean)));
}

function setReviewTask(task) {
  reviewTask = task;
  reviewTasks = {
    ...reviewTasks,
    [task.id]: task,
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
