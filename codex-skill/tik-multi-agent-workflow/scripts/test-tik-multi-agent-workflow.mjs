#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decideNextAction } from '../lib/loop-gate.mjs';
import { instructionForDecision } from '../lib/output.mjs';

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
let questionerRuns = [];
let questionerOutputs = [];
let invocations = [];
let reviewTask = null;
let finalReviewTask = null;
let reviewTasks = {};
let rootTask = null;
let subtaskStatusHistory = [];
let hookStarts = [];
let events = [];
let contextSnapshots = {};
let decisionIfMatchLog = [];
let forceConcurrentDecisionChange = false;

try {
  await initRepo(repo);
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows') {
        const body = await readRequestJson(req);
        const createdWorkflow = {
          id: body.id || 'wf-cli',
          driver: 'codex-workflow',
          status: 'active',
          goal: body.goal,
          rootTaskId: body.rootTaskId || body.id || 'wf-cli',
          repo: body.repo,
          baseRef: body.baseRef,
          headRef: body.headRef,
          currentHeadSha: body.headSha,
          maxRounds: body.maxRounds || 3,
          policy: body.policy,
          metadata: body.metadata,
        };
        if (createdWorkflow.id === 'wf-cli') {
          workflow = createdWorkflow;
        }
        events.push({ type: 'workflow.created', payload: { workflowId: createdWorkflow.id } });
        sendJson(res, { workflow: createdWorkflow });
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
          questionerRuns,
          questionerOutputs,
          invocations,
          events,
        });
        return;
      }
      if (req.method === 'GET' && pathname(route) === '/api/v1/multi-agent/workflows/wf-cli/next-action') {
        sendJson(res, mockNextActionPayload({
          workflow,
          taskGraph: graph,
          subtasks,
          decisions,
          evidence,
          contracts,
          evaluationRuns,
          questionerRuns,
          questionerOutputs,
          invocations,
          events,
        }));
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-cli/timeline') {
        sendJson(res, { events });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-cli/context-snapshots/main') {
        const snapshot = contextSnapshots.main;
        if (!snapshot) {
          sendJson(res, { error: { message: 'Context snapshot not found' } }, 404);
          return;
        }
        sendJson(res, { snapshot });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/context-snapshots') {
        const body = await readRequestJson(req);
        const snapshot = {
          ...body.snapshot,
          createdAt: contextSnapshots[body.snapshot.target]?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          etag: `sn-${Object.keys(contextSnapshots).length + events.length + 1}`,
          renderedMarkdown: [
            '# Workflow Snapshot',
            '',
            '## Goal',
            body.snapshot.objectiveSummary,
            '',
            '## Artifact Refs',
            ...(body.snapshot.artifactRefs || []).map((ref) => `- ${ref}`),
            '',
          ].join('\n'),
        };
        contextSnapshots[snapshot.target] = snapshot;
        events.push({ type: 'context_snapshot.recorded', payload: { target: snapshot.target, etag: snapshot.etag } });
        sendJson(res, { snapshot, guard: { accepted: true, code: 'ok' } });
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
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/questioner-runs') {
        const body = await readRequestJson(req);
        sendJson(res, createMockQuestionerRun(body));
        return;
      }
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/actions\/[^/]+\/run$/)) {
        const actionId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        const plannedAction = decideNextAction({
          workflow,
          taskGraph: graph,
          subtasks,
          decisions,
          evidence,
          contracts,
          evaluationRuns,
          questionerRuns,
          questionerOutputs,
          invocations,
          events,
        });
        if (plannedAction.action !== actionId) {
          sendJson(res, {
            plannedAction,
            guard: {
              accepted: false,
              code: 'invalid_transition',
              message: `Requested action ${actionId} is not the planned next action ${plannedAction.action}.`,
            },
          }, 409);
          return;
        }
        if (!String(actionId).startsWith('ask_claude_question_')) {
          sendJson(res, {
            plannedAction,
            guard: {
              accepted: false,
              code: 'invalid_transition',
              message: `Action ${actionId} is planned but has no generic action executor yet; use its domain command.`,
            },
          }, 409);
          return;
        }
        const run = createMockQuestionerRun({
          id: body.options?.id,
          invocationId: body.options?.invocationId,
          subtaskId: plannedAction.subtaskId,
          intent: actionId === 'ask_claude_question_final_evidence'
            ? 'question_final_evidence'
            : actionId === 'ask_claude_question_contract'
              ? 'question_contract'
              : 'question_evaluation',
          contractId: plannedAction.inputs?.contractId,
          evaluationRunId: actionId === 'ask_claude_question_final_evidence' ? undefined : plannedAction.inputs?.evaluationRunId,
          finalEvaluationRunId: actionId === 'ask_claude_question_final_evidence' ? plannedAction.inputs?.evaluationRunId : undefined,
          headSha: body.headSha || workflow.currentHeadSha,
          runtimeAudit: body.options?.runtimeAudit,
        });
        sendJson(res, {
          action: actionId,
          plannedAction,
          created: { kind: 'questioner_run', id: run.questionerRunId },
          ...run,
        });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-cli/questioner-outputs') {
        const body = await readRequestJson(req);
        const invocation = invocations.find((item) => item.id === body.actor?.invocationId);
        if (
          !invocation
          || invocation.role !== 'questioner'
          || invocation.runner !== 'claude-code'
          || invocation.status !== 'completed'
          || invocation.result?.questionerOutput?.artifactRef !== body.artifactRef
        ) {
          sendJson(res, {
            error: {
              code: 'missing_subagent_invocation',
              message: 'Questioner output must reference a completed Tik-owned Claude Questioner invocation.',
            },
          }, 409);
          return;
        }
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
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/questioner-runs\/[^/]+\/output$/)) {
        const runId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        const run = questionerRuns.find((item) => item.id === runId);
        if (!run || req.headers.authorization !== `Bearer token-${run.id}`) {
          sendJson(res, {
            error: {
              code: 'missing_evidence',
              message: 'Questioner run token is missing or invalid.',
            },
          }, 409);
          return;
        }
        const output = body.output;
        const questionerOutput = {
          id: output.id,
          workflowId: 'wf-cli',
          createdAt: new Date().toISOString(),
          ...output,
        };
        questionerRuns = questionerRuns.map((item) => item.id === runId
          ? {
            ...item,
            status: 'validated',
            outputHash: output.attestation?.outputHash,
            outputArtifactRef: output.attestation?.outputArtifactRef,
            readonlyAudit: {
              ...(item.readonlyAudit || {}),
              enforced: true,
              violations: [],
              gitStatusAfter: body.runtimeAudit?.gitStatusAfter,
            },
            completedAt: new Date().toISOString(),
          }
          : item);
        invocations = invocations.map((item) => item.id === run.invocationId
          ? {
            ...item,
            status: 'completed',
            readonlyPolicy: {
              ...(item.readonlyPolicy || {}),
              enforced: true,
              violations: [],
              gitStatusAfter: body.runtimeAudit?.gitStatusAfter,
            },
            result: {
              questionerRunId: run.id,
              questionerOutput,
            },
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          : item);
        questionerOutputs.push(questionerOutput);
        events.push({ type: 'questioner.run.validated', payload: { questionerRunId: run.id, questionerOutputId: questionerOutput.id } });
        sendJson(res, {
          questionerRun: questionerRuns.find((item) => item.id === runId),
          questionerOutput,
          invocation: invocations.find((item) => item.id === run.invocationId),
        });
        return;
      }
      if (req.method === 'GET' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/questioner-runs\/[^/]+\/context$/)) {
        const runId = route.split('/').at(-2);
        const run = questionerRuns.find((item) => item.id === runId);
        if (!run || req.headers.authorization !== `Bearer token-${run.id}`) {
          sendJson(res, {
            error: {
              code: 'missing_evidence',
              message: 'Questioner run token is missing or invalid.',
            },
          }, 409);
          return;
        }
        sendJson(res, {
          questionerRun: run,
          context: {
            schemaVersion: 'questioner-context.v1',
            run: {
              questionerRunId: run.id,
              invocationId: run.invocationId,
              workflowId: 'wf-cli',
              intent: run.intent,
              headSha: run.headSha,
              contextHash: run.contextHash,
              submitUrl: `/v1/multi-agent/workflows/wf-cli/questioner-runs/${run.id}/output`,
              contextArtifactRef: run.contextArtifactRef,
            },
            workflow: {
              goal: workflow.goal,
              policy: workflow.policy || {},
              globalAcceptanceCriteria: graph?.globalAcceptanceCriteria || [],
            },
            subtask: run.subtaskId ? {
              id: run.subtaskId,
              title: graph?.subtasks?.find((item) => item.id === run.subtaskId)?.title || run.subtaskId,
              status: subtasks[run.subtaskId]?.status || 'pending',
              dependencies: [],
            } : undefined,
            contract: run.contractId ? {
              id: run.contractId,
              status: 'accepted',
              mustCriteria: [{ id: 'ac-1', statement: 'Accepted contract gates execution.', verificationMethod: 'command' }],
              shouldCriteria: [],
              outOfScope: [],
              requiredEvidence: ['cmd-test'],
            } : undefined,
            evaluation: run.evaluationRunId ? {
              id: run.evaluationRunId,
              readonly: true,
              headSha: run.headSha,
              verdict: 'pass',
              commands: [],
              artifacts: [],
              coverage: [],
              coverageGaps: [],
              logs: [],
            } : undefined,
            finalEvaluation: run.finalEvaluationRunId ? {
              id: run.finalEvaluationRunId,
              headSha: run.headSha,
              verdict: 'pass',
              globalCriteriaCoverage: [{ criterionId: 'global-ac-1', status: 'pass', evidence: 'Final evidence passed.' }],
              requiredEvidence: [],
              coverageGaps: [],
            } : undefined,
            diff: { headSha: run.headSha, files: [], excerpts: [] },
            relevantFiles: [],
            previousQuestionerOutputs: [],
            outputContract: {
              schemaVersion: 'questioner-output.v2',
              requiredFields: ['coverageMatrix'],
              allowedVerdicts: ['questions_blocking', 'evidence_needed', 'risk_found', 'no_blocking_questions', 'evidence_sufficient'],
            },
          },
        });
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
        assert.equal(typeof body.nonce, 'string');
        assert.ok(body.nonce.length > 0);
        hookStarts.push({ invocationId, body });
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
              nonce: body.nonce,
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
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/agent-invocations\/[^/]+\/start$/)) {
        const invocationId = route.split('/').at(-2);
        invocations = invocations.map((item) => item.id === invocationId
          ? {
            ...item,
            status: 'started',
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          : item);
        sendJson(res, { invocation: invocations.find((item) => item.id === invocationId) });
        return;
      }
      if (req.method === 'POST' && route.match(/^\/api\/v1\/multi-agent\/workflows\/wf-cli\/agent-invocations\/[^/]+\/result$/)) {
        const invocationId = route.split('/').at(-2);
        const body = await readRequestJson(req);
        invocations = invocations.map((item) => item.id === invocationId
          ? {
            ...item,
            ...body,
            status: body.status,
            result: body.result,
            headSha: body.headSha,
            evaluationRunId: body.evaluationRunId,
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
        const ifMatch = req.headers['if-match'];
        decisionIfMatchLog.push({ route, ifMatch, decisionId: body.decision?.id });
        if (forceConcurrentDecisionChange && route.endsWith('/decisions')) {
          workflow = {
            ...workflow,
            lastDecisionId: 'dec-concurrent-server-side',
          };
          forceConcurrentDecisionChange = false;
        }
        if (ifMatch && ifMatch !== '*' && ifMatch !== workflow.lastDecisionId) {
          sendJson(res, {
            decision: body.decision,
            guard: {
              accepted: false,
              code: 'invalid_transition',
              message: `Decision history changed; expected ${ifMatch}, current ${workflow.lastDecisionId || 'none'}.`,
              currentState: {
                expectedLastDecisionId: ifMatch,
                lastDecisionId: workflow.lastDecisionId,
              },
            },
            workflow,
          }, route.endsWith('/decisions') ? 409 : 200);
          return;
        }
        if (route.endsWith('/decisions')) {
          decisions.push(body.decision);
          workflow = {
            ...workflow,
            lastDecisionId: body.decision.id,
          };
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
          workflow,
        });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/worktree-review-rounds') {
        const body = await readRequestJson(req);
        assert.equal(body.labels.includes('external-claude-review'), true);
        assert.equal(body.rootTaskId, 'task-root');
        assert.equal(body.reviewInputSource, 'local_diff');
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
  assert.equal(init.mode, 'legacy');
  assert.match(init.deprecation, /Legacy compatibility mode is deprecated/);

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
      finalValidationCommands: [
        `${process.execPath} -e "console.log('final command one')"`,
        `${process.execPath} -e "console.log('final command two')"`,
      ],
    }),
  ]);
  assert.equal(putGraph.action, 'accepted-plan');

  const next = await run(['next', '--api-base-url', apiBaseUrl, '--workflow', 'wf-cli']);
  assert.equal(next.decision.action, 'execute_subtask');
  assert.equal(next.decision.subtaskId, 'st-api');
  assert.match(next.instruction, /Implement subtask st-api/);
  assert.equal(decisionIfMatchLog.at(-1).ifMatch, undefined);

  forceConcurrentDecisionChange = true;
  const staleNext = await run(['next', '--api-base-url', apiBaseUrl, '--workflow', 'wf-cli']);
  assert.equal(staleNext.guard.accepted, false);
  assert.equal(staleNext.guard.code, 'invalid_transition');
  assert.equal(decisionIfMatchLog.at(-1).ifMatch, next.decision.id);

  const builderStarted = await run([
    'start-builder',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--invocation', 'inv-builder-cli',
    '--parent-thread', 'workflow-thread-cli',
    '--thread', 'builder-thread-cli',
    '--nonce', 'nonce-builder-cli',
    '--path', repo,
  ]);
  assert.equal(builderStarted.action, 'builder-pending');
  assert.equal(builderStarted.invocation.status, 'created');
  assert.equal(builderStarted.invocation.threadId, 'builder-thread-cli');
  assert.equal(builderStarted.invocation.attestationToken, undefined);
  assert.equal(builderStarted.attestationToken, undefined);
  assert.match(builderStarted.instruction, /Codex hook will attest runtime start/);

  const builderHookStarted = await run([
    'complete-invocation',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--invocation', 'inv-builder-cli',
    '--attestation-token', 'att-inv-builder-cli',
    '--status', 'started',
    '--parent-thread', 'workflow-thread-cli',
    '--thread', 'builder-thread-cli',
    '--nonce', 'nonce-builder-cli',
  ]);
  assert.equal(builderHookStarted.action, 'invocation-started');
  assert.equal(builderHookStarted.invocation.status, 'started');
  assert.equal(hookStarts.at(-1).body.nonce, 'nonce-builder-cli');

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
    '--attestation-token', 'att-inv-builder-cli',
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

  const aliasExecution = await run([
    'record-implementation',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--summary', 'Alias implementation evidence',
    '--observed-changed-files', 'packages/kernel/src/server.ts',
  ]);
  assert.equal(aliasExecution.action, 'execution-recorded');

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

  const v1AcceptContractNext = decideNextAction({
    workflow: { ...workflow, policy: v1Policy },
    taskGraph: graph,
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'contract_drafting',
        evidenceRefs: [],
      },
    },
    contracts: [{
      id: 'contract-st-api-v1',
      subtaskId: 'st-api',
      status: 'draft',
      version: 1,
    }],
    evaluationRuns: [],
    questionerOutputs: [],
  });
  assert.equal(v1AcceptContractNext.action, 'accept_contract');
  assert.equal(v1AcceptContractNext.subtaskId, 'st-api');

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
    questionerRuns: [{
      id: 'qr-clear',
      status: 'validated',
      invocationId: 'inv-q-clear',
      contextHash: 'sha256:ctx-clear',
      contextArtifactRef: 'context://qr-clear',
      outputHash: 'sha256:out-clear',
    }],
    invocations: [{
      id: 'inv-q-clear',
      status: 'completed',
    }],
    questionerOutputs: [{
      schemaVersion: 'questioner-output.v2',
      id: 'q-clear',
      questionerRunId: 'qr-clear',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      actor: { invocationId: 'inv-q-clear' },
      references: { contractId: 'contract-st-api-v1', evaluationRunId: 'eval-pass' },
      attestation: {
        headSha: workflow.currentHeadSha,
        contextHash: 'sha256:ctx-clear',
        contextArtifactRef: 'context://qr-clear',
        outputHash: 'sha256:out-clear',
      },
      coverageMatrix: [{
        criterionId: 'ac-1',
        required: true,
        status: 'covered',
        evidenceRefs: ['eval-pass'],
        comment: 'covered',
      }],
      verdict: 'evidence_sufficient',
      questions: [],
      createdAt: new Date().toISOString(),
    }],
  });
  assert.equal(v1CompleteNext.action, 'complete_subtask');
  const v1CompleteNextOutput = { instruction: instructionForDecision(v1CompleteNext) };
  assert.match(v1CompleteNextOutput.instruction, /contract, implementation evidence, Codex evaluation evidence/);
  assert.match(v1CompleteNextOutput.instruction, /subagent-isolation guards/);
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
    questionerRuns: [{
      id: 'qr-final-clear',
      status: 'validated',
      invocationId: 'inv-q-final-clear',
      contextHash: 'sha256:ctx-final-clear',
      contextArtifactRef: 'context://qr-final-clear',
      outputHash: 'sha256:out-final-clear',
    }],
    invocations: [{
      id: 'inv-q-final-clear',
      status: 'completed',
    }],
    questionerOutputs: [{
      schemaVersion: 'questioner-output.v2',
      id: 'q-final-clear',
      questionerRunId: 'qr-final-clear',
      intent: 'question_final_evidence',
      actor: { invocationId: 'inv-q-final-clear' },
      references: { finalEvaluationRunId: 'eval-final-pass' },
      attestation: {
        headSha: workflow.currentHeadSha,
        contextHash: 'sha256:ctx-final-clear',
        contextArtifactRef: 'context://qr-final-clear',
        outputHash: 'sha256:out-final-clear',
      },
      coverageMatrix: [{
        criterionId: 'global-ac-1',
        required: true,
        status: 'covered',
        evidenceRefs: ['eval-final-pass'],
        comment: 'covered',
      }],
      verdict: 'evidence_sufficient',
      questions: [],
      createdAt: new Date().toISOString(),
    }],
  });
  assert.equal(v1WorkflowCompleteNext.action, 'complete_workflow');
  const v1WorkflowCompleteNextOutput = { instruction: instructionForDecision(v1WorkflowCompleteNext) };
  assert.match(v1WorkflowCompleteNextOutput.instruction, /final evaluation\/questioner evidence passes Tik guards/);

  workflow = {
    ...workflow,
    currentHeadSha: 'head-v1',
    policy: v1Policy,
  };

  const v1Init = await run([
    'init',
    '--api-base-url', apiBaseUrl,
    '--path', repo,
    '--goal', 'Implement v1 workflow',
    '--workflow', 'wf-cli-v1-init',
    '--v1',
  ]);
  assert.equal(v1Init.mode, 'v1');
  assert.match(v1Init.deprecation, /Legacy review\/process\/fix\/final-review commands are disabled/);

  await assert.rejects(
    run([
      'review',
      '--api-base-url', apiBaseUrl,
      '--workflow', 'wf-cli',
      '--subtask', 'st-api',
      '--path', repo,
    ]),
    /disabled for v1 workflows/,
  );

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
    '--nonce', 'nonce-evaluator-cli',
    '--path', repo,
    '--evaluator-artifact-path', 'reports/evaluator/',
    '--evaluator-artifact-path', 'custom-artifacts/result.json',
  ]);
  assert.equal(evaluatorStarted.action, 'evaluator-pending');
  assert.equal(evaluatorStarted.invocation.status, 'created');
  assert.equal(evaluatorStarted.invocation.threadId, 'evaluator-thread-cli');
  assert.equal(evaluatorStarted.invocation.attestationToken, undefined);
  assert.equal(evaluatorStarted.attestationToken, undefined);
  assert.match(evaluatorStarted.instruction, /Codex hook will attest runtime start/);
  assert.ok(evaluatorStarted.invocation.allowedPaths.includes('.tik/multi-agent/'));
  assert.ok(evaluatorStarted.invocation.allowedPaths.includes('reports/evaluator/'));
  assert.ok(evaluatorStarted.invocation.allowedPaths.includes('custom-artifacts/result.json'));

  const evaluatorHookStarted = await run([
    'complete-invocation',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--invocation', 'inv-evaluator-cli',
    '--attestation-token', 'att-inv-evaluator-cli',
    '--status', 'started',
    '--parent-thread', 'workflow-thread-cli',
    '--thread', 'evaluator-thread-cli',
    '--nonce', 'nonce-evaluator-cli',
  ]);
  assert.equal(evaluatorHookStarted.action, 'invocation-started');
  assert.equal(evaluatorHookStarted.invocation.status, 'started');
  assert.equal(hookStarts.at(-1).body.nonce, 'nonce-evaluator-cli');

  await writeFile(path.join(repo, 'builder-output.txt'), 'visible to evaluator sandbox\n', 'utf-8');
  const evaluated = await run([
    'evaluate',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--evaluation', 'eval-st-api-v1',
    '--evaluator-setup-command', `${process.execPath} -e "console.log('setup ok')"`,
    '--command', `${process.execPath} -e "const fs=require('fs'); if(!fs.existsSync('builder-output.txt')) process.exit(2); console.log(fs.readFileSync('builder-output.txt','utf8').trim()); console.log('evaluation ok')"`,
    '--invocation', 'inv-evaluator-cli',
    '--attestation-token', 'att-inv-evaluator-cli',
  ]);
  assert.equal(evaluated.action, 'evaluation-recorded');
  assert.equal(evaluated.passed, true);
  assert.equal(evaluated.invocation.status, 'completed');
  assert.equal(evaluated.invocation.evaluationRunId, 'eval-st-api-v1');
  assert.equal(evaluated.invocation.threadId, 'evaluator-thread-cli');
  assert.equal(evaluationRuns[0].status, 'passed');
  assert.equal(
    evaluated.evaluationRun.result.commandResults[1].stdoutArtifactId,
    '.tik/multi-agent/workflows/wf-cli/evaluations/eval-st-api-v1/stdout.log',
  );
  assert.equal(evaluated.evaluationRun.result.commandResults[0].commandId, 'cmd-evaluate-setup-1');
  assert.equal(evaluated.evaluationRun.result.commandResults[0].status, 'passed');
  assert.match(
    await readFile(path.join(repo, evaluated.evaluationRun.result.commandResults[0].stdoutArtifactId), 'utf-8'),
    /setup ok/,
  );
  assert.match(
    await readFile(path.join(repo, evaluated.evaluationRun.result.commandResults[1].stdoutArtifactId), 'utf-8'),
    /visible to evaluator sandbox/,
  );
  assert.match(
    await readFile(path.join(repo, evaluated.evaluationRun.result.commandResults[1].stdoutArtifactId), 'utf-8'),
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

  const questionerStarted = await run([
    'start-questioner',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--intent', 'question_evaluation',
    '--invocation', 'claude-questioner-cli',
    '--head-sha', 'head-v1',
    '--contract', 'contract-st-api-v1',
    '--evaluation', 'eval-st-api-v1',
    '--artifact-ref', '.tik/multi-agent/workflows/wf-cli/questioner/q-cli.json',
  ]);
  assert.equal(questionerStarted.action, 'questioner-run-started');
  assert.equal(questionerStarted.invocation.status, 'started');

  const runNextQuestioner = await run([
    'run-next',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--subtask', 'st-api',
    '--head-sha', 'head-v1',
    '--run', 'qr-run-next-cli',
    '--invocation', 'claude-questioner-run-next-cli',
    '--git-status-before', '',
  ]);
  assert.equal(runNextQuestioner.action, 'action-run');
  assert.equal(runNextQuestioner.workflowAction, 'ask_claude_question_evaluation');
  assert.equal(runNextQuestioner.created.kind, 'questioner_run');
  assert.equal(runNextQuestioner.questionerRunId, 'qr-run-next-cli');
  assert.equal(runNextQuestioner.invocationId, 'claude-questioner-run-next-cli');

  await assert.rejects(
    run([
      'complete-questioner',
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
    ]),
    /complete-questioner is legacy/,
  );

  const questionerOutputPath = path.join(tempRoot, 'questioner-output-cli.json');
  await writeFile(questionerOutputPath, `${JSON.stringify({
    id: 'q-cli',
    subtaskId: 'st-api',
    intent: 'question_evaluation',
    headSha: 'head-v1',
    evaluationRunId: 'eval-st-api-v1',
    contractId: 'contract-st-api-v1',
    artifactRef: '.tik/multi-agent/workflows/wf-cli/questioner/q-cli.json',
    verdict: 'evidence_sufficient',
    questions: [],
    risks: [],
    missingTests: [],
    suggestedContractChanges: [],
  }, null, 2)}\n`, 'utf-8');

  const questioned = await run([
    'complete-questioner',
    '--unsafe-legacy',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--invocation', 'claude-questioner-cli',
    '--output', questionerOutputPath,
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
	    '--command', `${process.execPath} -e "console.log('final command one')"`,
	    '--command', `${process.execPath} -e "console.log('final command two')"`,
	  ]);
	  assert.equal(finalEvaluated.action, 'evaluation-recorded');
	  assert.equal(finalEvaluated.passed, true);
	  assert.deepEqual(
	    finalEvaluated.evaluationRun.result.commandResults
	      .filter((result) => result.commandId.startsWith('cmd-evaluate'))
	      .map((result) => result.command),
	    graph.finalValidationCommands,
	  );
	  assert.equal(
	    finalEvaluated.evaluationRun.result.commandResults.find((result) => result.commandId === 'cmd-evaluate-1')?.stdoutArtifactId,
	    '.tik/multi-agent/workflows/wf-cli/evaluations/eval-final-v1/stdout-1.log',
	  );
	  assert.equal(
	    finalEvaluated.evaluationRun.result.commandResults.find((result) => result.commandId === 'cmd-evaluate-2')?.stdoutArtifactId,
	    '.tik/multi-agent/workflows/wf-cli/evaluations/eval-final-v1/stdout-2.log',
	  );
	  assert.match(
	    await readFile(path.join(repo, '.tik/multi-agent/workflows/wf-cli/evaluations/eval-final-v1/stdout-1.log'), 'utf-8'),
	    /final command one/,
	  );
	  assert.match(
	    await readFile(path.join(repo, '.tik/multi-agent/workflows/wf-cli/evaluations/eval-final-v1/stdout-2.log'), 'utf-8'),
	    /final command two/,
	  );

  const finalQuestionerStarted = await run([
    'start-questioner',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--intent', 'question_final_evidence',
    '--invocation', 'claude-final-questioner-cli',
    '--head-sha', 'head-v1',
    '--evaluation', 'eval-final-v1',
    '--artifact-ref', '.tik/multi-agent/workflows/wf-cli/questioner/q-final-cli.json',
  ]);
  assert.equal(finalQuestionerStarted.action, 'questioner-run-started');
  assert.equal(finalQuestionerStarted.invocation.input.finalEvaluationRunId, 'eval-final-v1');
  assert.equal(finalQuestionerStarted.invocation.input.evaluationRunId, undefined);

  const finalQuestionerOutputPath = path.join(tempRoot, 'final-questioner-output-cli.json');
  await writeFile(finalQuestionerOutputPath, `${JSON.stringify({
    id: 'q-final-cli',
    intent: 'question_final_evidence',
    headSha: 'head-v1',
    finalEvaluationRunId: 'eval-final-v1',
    artifactRef: '.tik/multi-agent/workflows/wf-cli/questioner/q-final-cli.json',
    verdict: 'evidence_sufficient',
    questions: [],
    risks: [],
    missingTests: [],
    suggestedContractChanges: [],
  }, null, 2)}\n`, 'utf-8');

  const finalQuestioned = await run([
    'complete-questioner',
    '--unsafe-legacy',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--invocation', 'claude-final-questioner-cli',
    '--output', finalQuestionerOutputPath,
  ]);
  assert.equal(finalQuestioned.action, 'questioner-output-recorded');
  assert.equal(finalQuestioned.questionerOutput.finalEvaluationRunId, 'eval-final-v1');
  assert.equal(finalQuestioned.questionerOutput.evaluationRunId, undefined);
  const finalQuestionerInvocation = invocations.find((item) => item.id === 'claude-final-questioner-cli');
  assert.equal(finalQuestionerInvocation?.result?.finalEvaluationRunId, 'eval-final-v1');
  assert.equal(finalQuestionerInvocation?.result?.questionerOutput?.finalEvaluationRunId, 'eval-final-v1');

  const v1CompletedWorkflow = await run([
    'complete-workflow',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
  ]);
  assert.equal(v1CompletedWorkflow.action, 'workflow-completed');
  assert.equal(v1CompletedWorkflow.decision.action, 'complete_workflow');
  assert.equal(workflow.status, 'completed');

  workflow = {
    ...workflow,
    status: 'active',
    completedAt: undefined,
    policy: undefined,
  };
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
    '--review-input-source', 'local_diff',
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
  assert.equal(subtasks['st-api'].status, 'implemented');
  assert.deepEqual(subtasks['st-api'].evidenceRefs.includes('ev_review_task-review-1'), true);

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
  assert.ok(contextSnapshots.main);
  assert.equal(contextSnapshots.main.target, 'main');
  assert.equal(contextSnapshots.main.objectiveSummary, workflow.goal);
  assert.match(await readFile(path.join(repo, '.tik/multi-agent/workflows/wf-cli/context/main.snapshot.md'), 'utf-8'), /Workflow Snapshot/);

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

  const continueToCompleteWorkflow = await run([
    'continue',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-cli',
    '--path', repo,
  ]);
  assert.equal(continueToCompleteWorkflow.action, 'continue');
  assert.equal(continueToCompleteWorkflow.status, 'completed');
  assert.equal(workflow.status, 'completed');

  workflow = {
    ...workflow,
    status: 'active',
    completedAt: undefined,
  };

  finalReviewTask = {
    id: 'task-final-review',
    shortIdentifier: 'TIK-FINAL',
    status: 'blocked',
    labels: ['agent-loop', 'external-claude-review', 'final-claude-review', 'stale-head'],
    agentLoop: {
      headSha: workflow.currentHeadSha,
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
  await assertReviewCommitUsesPreMutationState(repo);
  await assertRejectedProcessReviewDoesNotMutate(repo);
  await assertProcessReviewCommitPrecedesEvidenceAndStateMutation(repo);
  await assertContinueStopsForCurrentSessionActions(repo);
  await assertRejectedFinalReviewDoesNotCreateOrStartReview(repo);
  await assertRejectedProcessFinalReviewDoesNotCompleteWorkflow(repo);
  await assertProcessFinalReviewRecordsEvidenceBeforeCommit(repo);
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
        }, route.endsWith('/decisions') ? 409 : 200);
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
        }, route.endsWith('/decisions') ? 409 : 200);
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

async function assertReviewCommitUsesPreMutationState(repoPath) {
  const headSha = gitHead(repoPath);
  let reviewCreated = false;
  const operations = [];
  let decisions = [];
  let localWorkflow = {
    id: 'wf-review-commit-order',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Commit review decision before mutating subtask state',
    rootTaskId: 'wf-review-commit-order',
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
    workflowId: 'wf-review-commit-order',
    subtaskId: 'st-api',
    kind: 'validation',
    title: 'Validation',
    passed: true,
    headSha,
    createdAt: new Date().toISOString(),
  }];
  const localGraph = buildGraph('wf-review-commit-order');
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-review-commit-order') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions, evidence: localEvidence });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-review-commit-order/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-review-commit-order/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        operations.push(route.endsWith('/preflight') ? 'decision_preflight' : 'decision_commit');
        const allowed = ['validated', 'approved'].includes(localSubtasks['st-api'].status);
        if (!allowed) {
          sendJson(res, {
            decision: body.decision,
            guard: {
              accepted: false,
              code: 'invalid_transition',
              message: `request_claude_review rejected from ${localSubtasks['st-api'].status}.`,
            },
            workflow: localWorkflow,
          }, route.endsWith('/decisions') ? 409 : 200);
          return;
        }
        if (route.endsWith('/decisions')) {
          decisions.push(body.decision);
          localWorkflow = { ...localWorkflow, lastDecisionId: body.decision.id };
        }
        sendJson(res, { decision: body.decision, guard: { accepted: true, code: 'ok' }, workflow: localWorkflow });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/worktree-review-rounds') {
        operations.push('review_task_created');
        reviewCreated = true;
        sendJson(res, { task: { id: 'task-review-order', shortIdentifier: 'TIK-ORDER' } });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/tasks/task-review-order/claude-review-runs') {
        operations.push('review_started');
        sendJson(res, { run: { id: 'run-review-order' } });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-review-commit-order/subtasks/st-api') {
        operations.push('subtask_patch');
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
  const reviewed = await run([
    'review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-review-commit-order',
    '--subtask', 'st-api',
    '--path', repoPath,
    '--start',
  ]);
  assert.equal(reviewed.guard.accepted, true);
  assert.equal(reviewCreated, true);
  assert.equal(decisions.length, 1);
  assert.ok(operations.indexOf('decision_commit') < operations.indexOf('subtask_patch'));
  assert.ok(operations.indexOf('decision_commit') < operations.indexOf('review_started'));
  assert.equal(localSubtasks['st-api'].status, 'reviewing');
  assert.deepEqual(localSubtasks['st-api'].reviewRoundIds, ['task-review-order']);
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
        }, route.endsWith('/decisions') ? 409 : 200);
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

async function assertProcessReviewCommitPrecedesEvidenceAndStateMutation(repoPath) {
  const headSha = gitHead(repoPath);
  const operations = [];
  let decisions = [];
  let localWorkflow = {
    id: 'wf-process-review-order',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Commit process-review decision before evidence and subtask mutations',
    rootTaskId: 'wf-process-review-order',
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
    workflowId: 'wf-process-review-order',
    subtaskId: 'st-api',
    kind: 'validation',
    title: 'Validation',
    passed: true,
    headSha,
    createdAt: new Date().toISOString(),
  }];
  const localGraph = buildGraph('wf-process-review-order');
  const reviewTask = {
    id: 'task-review',
    shortIdentifier: 'TIK-PROCESS-ORDER',
    agentLoop: {
      reviewResult: {
        verdict: 'changes_requested',
        headShaReviewed: headSha,
        currentHeadSha: headSha,
        blockingIssues: [{
          title: 'Fix API edge case',
          severity: 'blocker',
        }],
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-process-review-order') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions, evidence: localEvidence });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: [reviewTask] });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-process-review-order/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-process-review-order/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        operations.push(route.endsWith('/preflight') ? 'decision_preflight' : 'decision_commit');
        const allowed = localSubtasks['st-api'].status === 'reviewing';
        if (!allowed) {
          sendJson(res, {
            decision: body.decision,
            guard: {
              accepted: false,
              code: 'invalid_transition',
              message: `process-review decision rejected from ${localSubtasks['st-api'].status}.`,
            },
            workflow: localWorkflow,
          }, route.endsWith('/decisions') ? 409 : 200);
          return;
        }
        if (route.endsWith('/decisions')) {
          decisions.push(body.decision);
          localWorkflow = { ...localWorkflow, lastDecisionId: body.decision.id };
        }
        sendJson(res, { decision: body.decision, guard: { accepted: true, code: 'ok' }, workflow: localWorkflow });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-process-review-order/evidence') {
        operations.push('evidence_recorded');
        const body = await readRequestJson(req);
        localEvidence.push({ id: body.id || 'ev-review', workflowId: localWorkflow.id, ...body });
        sendJson(res, { evidence: localEvidence.at(-1) });
        return;
      }
      if (req.method === 'PATCH' && route === '/api/v1/multi-agent/workflows/wf-process-review-order/subtasks/st-api') {
        operations.push('subtask_patch');
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
  const processed = await run([
    'process-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-process-review-order',
    '--subtask', 'st-api',
    '--task', 'task-review',
  ]);
  assert.equal(processed.guard.accepted, true);
  assert.equal(processed.decision.action, 'fix_claude_blockers');
  assert.equal(decisions.length, 1);
  assert.ok(operations.indexOf('decision_commit') < operations.indexOf('evidence_recorded'));
  assert.ok(operations.indexOf('decision_commit') < operations.indexOf('subtask_patch'));
  assert.equal(localEvidence.length, 2);
  const reviewEvidence = localEvidence.at(-1);
  assert.ok(decisions[0].evidenceRefs.includes(reviewEvidence.id));
  assert.ok(processed.decision.evidenceRefs.includes(reviewEvidence.id));
  assert.equal(localSubtasks['st-api'].status, 'needs_fix');
  assert.deepEqual(localSubtasks['st-api'].evidenceRefs, ['ev-validation', reviewEvidence.id]);
  await new Promise((resolve) => server.close(resolve));
}

async function assertContinueStopsForCurrentSessionActions(repoPath) {
  const headSha = gitHead(repoPath);
  const manualActionPolicy = {
    requireAcceptedContract: true,
    requireEvaluationPassForComplete: true,
    requireQuestionerAfterEvaluation: true,
    requireSameHeadShaForEvidence: true,
    loopContract: {
      budget: { maxRounds: 3 },
      stop: ['guard_rejected', 'human_required'],
    },
  };
  const loopOnlyPolicy = {
    loopContract: {
      budget: { maxRounds: 3 },
      stop: ['guard_rejected', 'human_required'],
    },
  };
  const acceptedContract = {
    id: 'contract-st-api-v1',
    subtaskId: 'st-api',
    status: 'accepted',
    version: 1,
    acceptedAt: new Date().toISOString(),
  };
  const implementationEvidence = {
    id: 'ev-impl',
    workflowId: 'wf-placeholder',
    subtaskId: 'st-api',
    kind: 'implementation',
    title: 'Implementation',
    headSha,
    createdAt: new Date().toISOString(),
  };
  const passedEvaluation = {
    id: 'eval-pass',
    subtaskId: 'st-api',
    status: 'passed',
    headSha,
    result: { verdict: 'pass', headSha },
    startedAt: new Date().toISOString(),
  };
  const cases = [
    {
      suffix: 'execute',
      expectedAction: 'execute_subtask',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'builder-pending',
      expectedInstruction: /After the Builder produces code changes/,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, loopOnlyPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'ready',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: [],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
      }),
    },
    {
      suffix: 'draft-contract',
      expectedAction: 'draft_contract',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'builder-pending',
      expectedInstruction: /After the Builder produces code changes/,
      expectedDecisionsPosted: 2,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'ready',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: [],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
        contracts: [],
      }),
    },
    {
      suffix: 'question-contract',
      expectedAction: 'accept_contract',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'builder-pending',
      expectedInstruction: /After the Builder produces code changes/,
      expectedDecisionsPosted: 1,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'ready',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: [],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
        contracts: [{
          ...acceptedContract,
          status: 'draft',
        }],
      }),
    },
    {
      suffix: 'run-evaluator',
      expectedAction: 'run_codex_evaluator',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'evaluator-pending',
      expectedInstruction: /After the Evaluator finishes/,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'implemented',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: ['ev-impl'],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
        contracts: [acceptedContract],
        evidence: [{
          ...implementationEvidence,
          workflowId,
        }],
        evaluationRuns: [],
      }),
    },
    {
      suffix: 'fix-evaluation-findings',
      expectedAction: 'fix_evaluation_findings',
      expectedOutputAction: 'continue-instruction',
      expectedInstruction: /Fix Codex Evaluator or Claude Questioner findings/,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'evaluation_failed',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: ['ev-impl'],
            blockerFindingIds: [],
            fixRound: 1,
          },
        },
        evidence: [{
          ...implementationEvidence,
          workflowId,
        }],
        evaluationRuns: [{
          id: 'eval-fail',
          subtaskId: 'st-api',
          status: 'failed',
          headSha,
          result: { verdict: 'fail', headSha },
          startedAt: new Date().toISOString(),
        }, {
          id: 'eval-created-after-fail',
          subtaskId: 'st-api',
          status: 'created',
          headSha,
          startedAt: new Date(Date.now() + 1000).toISOString(),
        }],
      }),
    },
    {
      suffix: 'question-evaluation',
      expectedAction: 'ask_claude_question_evaluation',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'questioner-run-started',
      expectedInstruction: /After Claude submits QuestionerOutputV2/,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'evaluation_passed',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: ['ev-impl'],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
        contracts: [acceptedContract],
        evidence: [{
          ...implementationEvidence,
          workflowId,
        }],
        evaluationRuns: [passedEvaluation],
        questionerOutputs: [],
      }),
    },
    {
      suffix: 'run-final-evaluation',
      expectedAction: 'run_final_evaluation',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'evaluator-pending',
      expectedInstruction: /After the final Evaluator finishes/,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'done',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: ['ev-impl'],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
        evaluationRuns: [],
        questionerOutputs: [],
      }),
    },
    {
      suffix: 'question-final-evidence',
      expectedAction: 'ask_claude_question_final_evidence',
      expectedOutputAction: 'continue-instruction',
      expectedPendingAction: 'questioner-run-started',
      expectedInstruction: /After Claude submits QuestionerOutputV2/,
      build: (workflowId) => ({
        workflow: buildContinueWorkflow(workflowId, headSha, manualActionPolicy),
        taskGraph: buildGraph(workflowId),
        subtasks: {
          'st-api': {
            subtaskId: 'st-api',
            status: 'done',
            reviewRoundIds: [],
            validationRunIds: [],
            evidenceRefs: ['ev-impl'],
            blockerFindingIds: [],
            fixRound: 0,
          },
        },
        evaluationRuns: [{
          id: 'eval-final-pass',
          subtaskId: '__final__',
          status: 'passed',
          headSha,
          result: { verdict: 'pass', headSha },
          startedAt: new Date().toISOString(),
        }],
        questionerOutputs: [],
      }),
    },
  ];

  for (const testCase of cases) {
    const workflowId = `wf-continue-manual-${testCase.suffix}`;
    const localState = {
      evidence: [],
      contracts: [],
      evaluationRuns: [],
      questionerOutputs: [],
      invocations: [],
      events: [],
      ...testCase.build(workflowId),
    };
    let decisionsPosted = 0;
    const preflightActions = [];
    let contextSnapshotsSaved = 0;
    const server = http.createServer(async (req, res) => {
      try {
        const route = req.url || '/';
        if (req.method === 'GET' && route === `/api/v1/multi-agent/workflows/${workflowId}`) {
          sendJson(res, localState);
          return;
        }
        if (req.method === 'GET' && pathname(route) === `/api/v1/multi-agent/workflows/${workflowId}/next-action`) {
          sendJson(res, mockNextActionPayload(localState));
          return;
        }
        if (req.method === 'GET' && route === `/api/v1/multi-agent/workflows/${workflowId}/context-snapshots/main`) {
          sendJson(res, { error: { message: 'Context snapshot not found' } }, 404);
          return;
        }
        if (req.method === 'POST' && route === `/api/v1/multi-agent/workflows/${workflowId}/context-snapshots`) {
          contextSnapshotsSaved += 1;
          const body = await readRequestJson(req);
          sendJson(res, {
            snapshot: {
              ...body.snapshot,
              etag: `sn-${contextSnapshotsSaved}`,
              renderedMarkdown: '# Workflow Snapshot\n',
            },
            guard: { accepted: true, code: 'ok' },
          });
          return;
        }
        if (req.method === 'POST' && route === `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api/contracts`) {
          const body = await readRequestJson(req);
          const contract = {
            id: body.id || 'contract-st-api-v1',
            workflowId,
            subtaskId: 'st-api',
            ...body,
          };
          localState.contracts = (localState.contracts || []).filter((item) => item.id !== contract.id).concat(contract);
          sendJson(res, { contract });
          return;
        }
        if (req.method === 'POST' && route === `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api/contracts/contract-st-api-v1/accept`) {
          const body = await readRequestJson(req);
          const contract = {
            ...(localState.contracts || []).find((item) => item.id === 'contract-st-api-v1'),
            id: 'contract-st-api-v1',
            workflowId,
            subtaskId: 'st-api',
            status: 'accepted',
            acceptedBy: body.acceptedBy,
            acceptedAt: new Date().toISOString(),
            headShaAtAcceptance: body.headShaAtAcceptance,
          };
          localState.contracts = (localState.contracts || []).filter((item) => item.id !== contract.id).concat(contract);
          sendJson(res, { contract });
          return;
        }
        if (req.method === 'PATCH' && route === `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api`) {
          const body = await readRequestJson(req);
          localState.subtasks['st-api'] = {
            ...localState.subtasks['st-api'],
            ...body,
          };
          sendJson(res, { subtask: localState.subtasks['st-api'] });
          return;
        }
        if (req.method === 'POST' && route === `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations`) {
          const body = await readRequestJson(req);
          const invocation = {
            id: body.id || `inv-${localState.invocations.length + 1}`,
            workflowId,
            status: 'created',
            attestationToken: `att-${body.id || localState.invocations.length + 1}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...body,
          };
          localState.invocations.push(invocation);
          sendJson(res, { invocation });
          return;
        }
        if (req.method === 'POST' && route === `/api/v1/multi-agent/workflows/${workflowId}/questioner-runs`) {
          const body = await readRequestJson(req);
          const runId = body.id || `qr-${localState.questionerRuns?.length || 0}`;
          const invocationId = body.invocationId || `inv-${runId}`;
          const run = {
            id: runId,
            workflowId,
            subtaskId: body.subtaskId,
            intent: body.intent,
            status: body.start === false ? 'created' : 'started',
            invocationId,
            contractId: body.contractId,
            evaluationRunId: body.evaluationRunId,
            finalEvaluationRunId: body.finalEvaluationRunId,
            headSha: body.headSha,
            contextArtifactRef: `.tik/multi-agent/workflows/${workflowId}/questioner-runs/${runId}/context.json`,
            contextHash: `sha256:${runId}`,
            expectedOutputArtifactRef: `.tik/multi-agent/workflows/${workflowId}/questioner-runs/${runId}/output.json`,
            tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          };
          const invocation = {
            id: invocationId,
            workflowId,
            subtaskId: body.subtaskId,
            role: 'questioner',
            runner: 'claude-code',
            status: body.start === false ? 'created' : 'started',
            input: body,
            headSha: body.headSha,
          };
          localState.questionerRuns = [...(localState.questionerRuns || []), run];
          localState.invocations.push(invocation);
          sendJson(res, {
            questionerRunId: run.id,
            invocationId,
            contextArtifactRef: run.contextArtifactRef,
            contextHash: run.contextHash,
            expectedOutputArtifactRef: run.expectedOutputArtifactRef,
            submitUrl: `/v1/multi-agent/workflows/${workflowId}/questioner-runs/${run.id}/output`,
            contextUrl: `/v1/multi-agent/workflows/${workflowId}/questioner-runs/${run.id}/context`,
            token: `token-${run.id}`,
            tokenExpiresAt: run.tokenExpiresAt,
            questionerRun: run,
            invocation,
          });
          return;
        }
        if (
          req.method === 'POST'
          && (route === `/api/v1/multi-agent/workflows/${workflowId}/decisions`
            || route === `/api/v1/multi-agent/workflows/${workflowId}/decisions/preflight`)
        ) {
          const body = await readRequestJson(req);
          if (route.endsWith('/decisions')) {
            decisionsPosted += 1;
          } else {
            preflightActions.push(body.decision?.action);
          }
          sendJson(res, { decision: body.decision, guard: { accepted: true, code: 'ok' }, workflow: localState.workflow });
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
    const continued = await run([
      'continue',
      '--api-base-url', apiBaseUrl,
      '--workflow', workflowId,
      '--path', repoPath,
    ]);
    assert.equal(continued.action, testCase.expectedOutputAction || 'continue-instruction', testCase.suffix);
    assert.ok(preflightActions.includes(testCase.expectedAction), `${testCase.suffix}: expected preflight for ${testCase.expectedAction}, got ${preflightActions.join(',')}`);
    if (testCase.expectedPendingAction) {
      assert.equal(continued.pendingAction, testCase.expectedPendingAction, testCase.suffix);
    } else {
      assert.equal(continued.decision.action, testCase.expectedAction, testCase.suffix);
    }
    assert.match(continued.instruction, testCase.expectedInstruction, testCase.suffix);
    assert.equal(continued.guard.accepted, true, testCase.suffix);
    if (testCase.suffix === 'fix-evaluation-findings') {
      assert.equal(continued.decision.inputs.evaluationRunId, 'eval-fail');
    }
    assert.equal(decisionsPosted, testCase.expectedDecisionsPosted || 0, testCase.suffix);
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildContinueWorkflow(workflowId, headSha, policy) {
  return {
    id: workflowId,
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Continue should pause for current Codex work',
    rootTaskId: workflowId,
    repo: 'repo',
    baseRef: 'main',
    headRef: 'main',
    currentHeadSha: headSha,
    maxRounds: 3,
    policy: {
      ...policy,
      loopContract: {
        budget: { maxRounds: 3, ...(policy?.loopContract?.budget || {}) },
        stop: policy?.loopContract?.stop || ['guard_rejected', 'human_required'],
      },
    },
  };
}

async function assertRejectedProcessFinalReviewDoesNotCompleteWorkflow(repoPath) {
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
        }, route.endsWith('/decisions') ? 409 : 200);
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
  const decisionCountBefore = decisions.length;
  const rejected = await run([
    'process-final-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-reject-process-final-review',
    '--task', 'task-final-review',
  ]);
  assert.equal(rejected.guard.accepted, false);
  assert.equal(localEvidence.length, 1);
  assert.equal(decisions.length, decisionCountBefore);
  assert.equal(localWorkflow.status, 'active');
  await new Promise((resolve) => server.close(resolve));
}

async function assertRejectedFinalReviewDoesNotCreateOrStartReview(repoPath) {
  const headSha = gitHead(repoPath);
  let reviewCreated = false;
  let reviewStarted = false;
  const localWorkflow = {
    id: 'wf-reject-final-review',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Reject final review',
    rootTaskId: 'wf-reject-final-review',
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
  const localEvidence = [
    {
      id: 'ev-validation',
      workflowId: localWorkflow.id,
      subtaskId: 'st-api',
      kind: 'validation',
      title: 'Validation',
      passed: true,
      headSha,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'ev-review',
      workflowId: localWorkflow.id,
      subtaskId: 'st-api',
      kind: 'review',
      title: 'Review',
      headSha,
      payload: { result: { verdict: 'approve', blockingIssues: [] } },
      createdAt: new Date().toISOString(),
    },
  ];
  const localGraph = buildGraph('wf-reject-final-review');
  const server = http.createServer(async (req, res) => {
    try {
      const route = req.url || '/';
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-reject-final-review') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions: [], evidence: localEvidence });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-reject-final-review/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-reject-final-review/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        sendJson(res, {
          decision: body.decision,
          guard: {
            accepted: !route.endsWith('/decisions'),
            code: route.endsWith('/decisions') ? 'invalid_transition' : 'ok',
            message: route.endsWith('/decisions') ? 'Rejected by test guard.' : undefined,
          },
          workflow: localWorkflow,
        }, route.endsWith('/decisions') ? 409 : 200);
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/worktree-review-rounds') {
        reviewCreated = true;
        sendJson(res, { task: { id: 'task-final-review', shortIdentifier: 'TIK-FINAL-REJECT' } });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/agent-loop/tasks/task-final-review/claude-review-runs') {
        reviewStarted = true;
        sendJson(res, { run: { id: 'run-final-review' } });
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
    'final-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-reject-final-review',
    '--path', repoPath,
    '--start',
  ]);
  assert.equal(rejected.guard.accepted, false);
  assert.equal(reviewCreated, false);
  assert.equal(reviewStarted, false);
  await new Promise((resolve) => server.close(resolve));
}

async function assertProcessFinalReviewRecordsEvidenceBeforeCommit(repoPath) {
  const headSha = gitHead(repoPath);
  const operations = [];
  let localWorkflow = {
    id: 'wf-process-final-review-order',
    driver: 'codex-workflow',
    status: 'active',
    goal: 'Record process-final-review evidence before decision',
    rootTaskId: 'wf-process-final-review-order',
    repo: 'repo',
    baseRef: 'main',
    headRef: 'main',
    currentHeadSha: headSha,
    maxRounds: 3,
  };
  const decisions = [];
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
  const localGraph = buildGraph('wf-process-final-review-order');
  const reviewTask = {
    id: 'task-final-review',
    shortIdentifier: 'TIK-FINAL-ORDER',
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
      if (req.method === 'GET' && route === '/api/v1/multi-agent/workflows/wf-process-final-review-order') {
        sendJson(res, { workflow: localWorkflow, taskGraph: localGraph, subtasks: localSubtasks, decisions, evidence: localEvidence });
        return;
      }
      if (req.method === 'GET' && route === '/api/v1/tasks') {
        sendJson(res, { tasks: [reviewTask] });
        return;
      }
      if (
        req.method === 'POST'
        && (route === '/api/v1/multi-agent/workflows/wf-process-final-review-order/decisions'
          || route === '/api/v1/multi-agent/workflows/wf-process-final-review-order/decisions/preflight')
      ) {
        const body = await readRequestJson(req);
        operations.push(route.endsWith('/preflight') ? 'decision_preflight' : 'decision_commit');
        if (route.endsWith('/decisions')) {
          decisions.push(body.decision);
          localWorkflow = { ...localWorkflow, lastDecisionId: body.decision.id, status: 'completed' };
        }
        sendJson(res, { decision: body.decision, guard: { accepted: true, code: 'ok' }, workflow: localWorkflow });
        return;
      }
      if (req.method === 'POST' && route === '/api/v1/multi-agent/workflows/wf-process-final-review-order/evidence') {
        operations.push('evidence_recorded');
        const body = await readRequestJson(req);
        localEvidence.push({ id: body.id || 'ev-final-review', workflowId: localWorkflow.id, ...body });
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
  const processed = await run([
    'process-final-review',
    '--api-base-url', apiBaseUrl,
    '--workflow', 'wf-process-final-review-order',
    '--task', 'task-final-review',
  ]);
  assert.equal(processed.guard.accepted, true);
  assert.equal(processed.action, 'workflow-completed');
  assert.equal(decisions.length, 1);
  assert.ok(operations.indexOf('evidence_recorded') < operations.indexOf('decision_preflight'));
  assert.ok(operations.indexOf('evidence_recorded') < operations.indexOf('decision_commit'));
  assert.equal(localEvidence.length, 1);
  assert.ok(processed.decision.evidenceRefs.includes(localEvidence[0].id));
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

function mockNextActionPayload(state) {
  const plannedAction = decideNextAction(state);
  return {
    plannedAction: {
      phase: 'test',
      reasonCode: 'test',
      refs: [],
      commandHint: `tik-multi-agent-workflow ${plannedAction.action}`,
      ...plannedAction,
    },
  };
}

function createMockQuestionerRun(body) {
  const runId = body.id || `qr-${questionerRuns.length + 1}`;
  const invocationId = body.invocationId || body.invocation || `inv-questioner-${questionerRuns.length + 1}`;
  const contextArtifactRef = `.tik/multi-agent/workflows/wf-cli/questioner-runs/${runId}/context.json`;
  const expectedOutputArtifactRef = `.tik/multi-agent/workflows/wf-cli/questioner-runs/${runId}/output.json`;
  const contextHash = `sha256:${runId}`;
  const invocation = {
    id: invocationId,
    workflowId: 'wf-cli',
    subtaskId: body.subtaskId,
    role: 'questioner',
    runner: 'claude-code',
    promptContract: 'claude-questioner.v2',
    input: {
      intent: body.intent,
      subtaskId: body.subtaskId,
      contractId: body.contractId,
      evaluationRunId: body.finalEvaluationRunId ? undefined : body.evaluationRunId,
      finalEvaluationRunId: body.finalEvaluationRunId,
      headSha: body.headSha,
      questionerRunId: runId,
      contextArtifactRef,
      expectedOutputArtifactRef,
    },
    headSha: body.headSha,
    evaluationRunId: body.evaluationRunId || body.finalEvaluationRunId,
    readonlyPolicy: {
      enforced: true,
      allowedWritePaths: ['.tik/multi-agent/'],
      forbiddenWritePaths: ['src/', 'app/', 'packages/', 'server/', 'client/', 'tests/', 'package.json', 'pnpm-lock.yaml'],
      violations: [],
      gitStatusBefore: body.runtimeAudit?.gitStatusBefore,
    },
    status: body.start === false ? 'created' : 'started',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: body.start === false ? undefined : new Date().toISOString(),
  };
  invocations.push(invocation);
  const run = {
    id: runId,
    workflowId: 'wf-cli',
    subtaskId: body.subtaskId,
    intent: body.intent,
    status: body.start === false ? 'created' : 'started',
    invocationId,
    runner: 'claude-code',
    pluginSkill: 'question-tik-agent-loop',
    contractId: body.contractId,
    evaluationRunId: body.evaluationRunId,
    finalEvaluationRunId: body.finalEvaluationRunId,
    headSha: body.headSha,
    contextArtifactRef,
    contextHash,
    expectedOutputArtifactRef,
    tokenId: `tok-${runId}`,
    tokenHash: `sha256:${runId}-token`,
    tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    runtimePolicy: { filesystem: 'read-only', network: 'tik-api-only', shell: 'read-only', permissionMode: 'dontAsk' },
    readonlyAudit: {
      enforced: true,
      allowedWritePaths: body.runtimeAudit?.allowedWritePaths || ['.tik/multi-agent/'],
      forbiddenWritePaths: body.runtimeAudit?.forbiddenWritePaths || ['src/', 'app/', 'packages/', 'server/', 'client/', 'tests/', 'package.json', 'pnpm-lock.yaml'],
      violations: [],
      gitStatusBefore: body.runtimeAudit?.gitStatusBefore,
    },
    createdAt: new Date().toISOString(),
    startedAt: body.start === false ? undefined : new Date().toISOString(),
  };
  questionerRuns.push(run);
  return {
    questionerRunId: run.id,
    invocationId,
    contextArtifactRef,
    contextHash,
    expectedOutputArtifactRef,
    submitUrl: `/v1/multi-agent/workflows/wf-cli/questioner-runs/${run.id}/output`,
    contextUrl: `/v1/multi-agent/workflows/wf-cli/questioner-runs/${run.id}/context`,
    token: `token-${run.id}`,
    tokenExpiresAt: run.tokenExpiresAt,
    questionerRun: run,
    invocation,
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

function pathname(route) {
  return String(route || '/').split('?')[0] || '/';
}
