#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { canonicalOutputHash } from '../claude-plugin/agent-loop-claude-review/scripts/_generated/questioner-hash.mjs';

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
  const verificationHeadSha = readGitHead(projectPath) || 'real-service-head-1';

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
    headSha: verificationHeadSha,
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

  const contract = await createAcceptedContract(client, workflowId, {
    subtaskId: 'st-real-service',
    headSha: verificationHeadSha,
  });
  report.contract = contract.contract;

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
    headSha: verificationHeadSha,
    payload: {
      servicePid: child.process.pid,
      apiBaseUrl: child.apiBaseUrl,
      changedFiles: [{
        path: 'scripts/verify-multi-agent-real-service.mjs',
        changeType: 'modified',
      }],
      scopeCheck: {
        allowed: true,
        violations: [],
      },
    },
  });
  recordStep('evidence.implementation', implementationEvidence);

  const subtaskImplemented = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'implemented',
    implementationHeadSha: verificationHeadSha,
    evidenceRefs: ['ev-real-service-implementation'],
  });
  recordStep('subtask.implemented', subtaskImplemented);

  const taskNeedsV1Evidence = await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    to: 'needs_review',
    actor: 'agent',
    reason: 'Implementation evidence was recorded; v1 evaluator and questioner gates are pending.',
  });
  recordStep('task.transition.needs_v1_evidence', taskNeedsV1Evidence);
  await captureTask(client, taskId, 'needs_v1_evidence');

  const validationEvidence = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/evidence`, {
    id: 'ev-real-service-validation',
    kind: 'validation',
    title: 'Real-service validation evidence',
    summary: 'Validation evidence recorded through the external Tik service.',
    subtaskId: 'st-real-service',
    command: 'node scripts/verify-multi-agent-real-service.mjs',
    passed: true,
    headSha: verificationHeadSha,
  });
  recordStep('evidence.validation', validationEvidence);

  const subtaskValidated = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'validated',
    validationRunIds: ['ev-real-service-validation'],
    evidenceRefs: ['ev-real-service-validation'],
    lastValidatedHeadSha: verificationHeadSha,
  });
  recordStep('subtask.validated', subtaskValidated);

  const builderInvocation = await createCompletedCodexInvocation(client, workflowId, {
    id: 'inv-real-service-builder',
    subtaskId: 'st-real-service',
    role: 'executor',
    runner: 'codex',
    promptContract: 'codex-builder.v1',
    threadId: 'real-service-builder-thread',
    headSha: verificationHeadSha,
    evidenceRefs: ['ev-real-service-implementation'],
  });
  recordStep('invocation.builder.completed', builderInvocation);

  const evaluationRun = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service/evaluations`, {
    id: 'eval-real-service',
    contractId: contract.contract.id,
    headSha: verificationHeadSha,
    evaluator: { kind: 'codex-evaluator', sessionId: 'real-service-evaluator' },
  });
  recordStep('evaluation.created', evaluationRun);

  const subtaskEvaluating = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'evaluating',
  });
  recordStep('subtask.evaluating', subtaskEvaluating);

  const evaluationResult = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service/evaluations/eval-real-service/result`, {
    result: {
      workflowId,
      subtaskId: 'st-real-service',
      contractId: contract.contract.id,
      evaluatorRunId: 'eval-real-service',
      headSha: verificationHeadSha,
      verdict: 'pass',
      criteriaResults: [
        { criterionId: 'ac-1', status: 'pass', evidence: 'Real Tik service APIs persisted workflow state.' },
        { criterionId: 'ac-2', status: 'pass', evidence: 'Workbench task content remained visible through HTTP.' },
      ],
      commandResults: [{
        commandId: 'cmd-real-service',
        command: 'node scripts/verify-multi-agent-real-service.mjs',
        status: 'passed',
        exitCode: 0,
        summary: 'Real-service verifier exercised HTTP workflow APIs.',
      }],
      runtimeFindings: [],
      coverageGaps: [],
      confidence: 0.9,
    },
  });
  recordStep('evaluation.result', evaluationResult);

  const evaluatorInvocation = await createCompletedCodexInvocation(client, workflowId, {
    id: 'inv-real-service-evaluator',
    subtaskId: 'st-real-service',
    role: 'evaluator',
    runner: 'codex-evaluator',
    promptContract: 'codex-evaluator.v1',
    threadId: 'real-service-evaluator-thread',
    headSha: verificationHeadSha,
    evaluationRunId: 'eval-real-service',
    readonlyPolicy: { enforced: true, violations: [] },
  });
  recordStep('invocation.evaluator.completed', evaluatorInvocation);

  const subtaskEvaluationPassed = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'evaluation_passed',
    evidenceRefs: ['ev-real-service-implementation', 'ev-real-service-validation'],
  });
  recordStep('subtask.evaluation_passed', subtaskEvaluationPassed);

  const evaluationQuestioner = await submitQuestionerOutput(client, workflowId, {
    runId: 'qr-real-service-evaluation',
    invocationId: 'inv-real-service-questioner',
    subtaskId: 'st-real-service',
    intent: 'question_evaluation',
    contractId: contract.contract.id,
    evaluationRunId: 'eval-real-service',
    headSha: verificationHeadSha,
    outputId: 'q-real-service-evaluation',
    coverageMatrix: [
      {
        criterionId: 'ac-1',
        criterionText: 'The workflow records evidence and a guarded decision.',
        required: true,
        status: 'covered',
        evidenceRefs: ['eval-real-service', 'cmd-real-service'],
        comment: 'Evaluator result and command evidence cover workflow persistence.',
      },
      {
        criterionId: 'ac-2',
        criterionText: 'The root workbench task exposes every state and full content through HTTP.',
        required: true,
        status: 'covered',
        evidenceRefs: ['eval-real-service', 'task.timeline'],
        comment: 'HTTP task snapshots and evaluator evidence cover workbench visibility.',
      },
    ],
  });
  recordStep('questioner.evaluation.validated', evaluationQuestioner);

  const subtaskQuestioned = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'questioning_evidence',
  });
  recordStep('subtask.questioning_evidence', subtaskQuestioned);

  const decision = {
    id: 'dec-real-service-complete-subtask',
    workflowId,
    rootTaskId: taskId,
    subtaskId: 'st-real-service',
    decidedBy: 'codex-workflow',
    decidedAt: new Date().toISOString(),
    action: 'complete_subtask',
    reason: 'External Tik service accepted v1 contract, implementation, evaluator, and Questioner evidence.',
    evidenceRefs: ['ev-real-service-implementation', 'ev-real-service-validation'],
    inputs: {
      currentHeadSha: verificationHeadSha,
      evaluationRunId: 'eval-real-service',
      questionerOutputId: 'q-real-service-evaluation',
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

  const subtaskDone = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/st-real-service`, {
    status: 'done',
  });
  recordStep('subtask.done', subtaskDone);

  const completeWithoutFinalEvaluation = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions`, {
    decision: {
      id: 'dec-real-service-complete-without-final-evaluation',
      workflowId,
      rootTaskId: taskId,
      decidedBy: 'codex-workflow',
      decidedAt: new Date().toISOString(),
      action: 'complete_workflow',
      reason: 'Intentional guard check: final v1 evidence is required.',
      evidenceRefs: [],
      inputs: {
        currentHeadSha: verificationHeadSha,
      },
    },
  }, { okStatuses: [409] });
  recordStep('workflow.decision.complete_without_final_evaluation_guard', completeWithoutFinalEvaluation);

  const finalEvaluationRun = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/__final__/evaluations`, {
    id: 'eval-real-service-final',
    contractId: `${workflowId}__final__`,
    headSha: verificationHeadSha,
    evaluator: { kind: 'codex-evaluator', sessionId: 'real-service-final-evaluator' },
  });
  recordStep('final_evaluation.created', finalEvaluationRun);

  const finalEvaluationResult = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/__final__/evaluations/eval-real-service-final/result`, {
    result: {
      workflowId,
      subtaskId: '__final__',
      contractId: `${workflowId}__final__`,
      evaluatorRunId: 'eval-real-service-final',
      headSha: verificationHeadSha,
      verdict: 'pass',
      criteriaResults: [{
        criterionId: 'global-ac-1',
        status: 'pass',
        evidence: 'Task and workflow state are visible through real Tik APIs.',
      }],
      commandResults: [{
        commandId: 'node scripts/verify-multi-agent-real-service.mjs',
        command: 'node scripts/verify-multi-agent-real-service.mjs',
        status: 'passed',
        exitCode: 0,
        summary: 'Final evaluator covered the configured final validation command.',
      }],
      runtimeFindings: [],
      coverageGaps: [],
      confidence: 0.9,
    },
  });
  recordStep('final_evaluation.result', finalEvaluationResult);

  const finalQuestioner = await submitQuestionerOutput(client, workflowId, {
    runId: 'qr-real-service-final',
    invocationId: 'inv-real-service-final-questioner',
    intent: 'question_final_evidence',
    finalEvaluationRunId: 'eval-real-service-final',
    headSha: verificationHeadSha,
    outputId: 'q-real-service-final',
    coverageMatrix: [{
      criterionId: 'global-ac-1',
      criterionText: 'Task and workflow state are visible through real Tik APIs.',
      required: true,
      status: 'covered',
      evidenceRefs: ['eval-real-service-final'],
      comment: 'Final evaluator evidence covers the workflow-level must criterion.',
    }],
  });
  recordStep('questioner.final.validated', finalQuestioner);

  const workflowCompletedDecision = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions`, {
    decision: {
      id: 'dec-real-service-complete-workflow',
      workflowId,
      rootTaskId: taskId,
      decidedBy: 'codex-workflow',
      decidedAt: new Date().toISOString(),
      action: 'complete_workflow',
      reason: 'Final Codex evaluation and Claude Questioner evidence passed the v1 workflow gate.',
      evidenceRefs: [],
      inputs: {
        currentHeadSha: verificationHeadSha,
        evaluationRunId: 'eval-real-service-final',
        questionerOutputId: 'q-real-service-final',
      },
      confidence: 0.95,
    },
  });
  recordStep('workflow.decision.complete_workflow', workflowCompletedDecision);
  await captureWorkflow(client, workflowId, 'workflow_completed');

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
    finalEvidenceGuard: completeWithoutFinalEvaluation.body.guard,
    workflowStatus: workflowCompletedDecision.body.workflow?.status,
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

async function createAcceptedContract(client, workflowId, input) {
  const created = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(input.subtaskId)}/contracts`, {
    id: `contract-${input.subtaskId}-v1`,
    status: 'draft',
    goal: 'Verify real Tik service contract',
    scope: {
      allowedPaths: ['packages/kernel/src/**', 'packages/shared/src/**', 'codex-skill/tik-multi-agent-workflow/**', 'scripts/verify-multi-agent-real-service.mjs'],
      blockedPaths: [],
    },
    deliverables: [{
      id: 'deliver-real-service',
      description: 'Real-service verification evidence is recorded through Tik APIs.',
      expectedFiles: ['scripts/verify-multi-agent-real-service.mjs'],
    }],
    acceptanceCriteria: [
      {
        id: 'ac-1',
        statement: 'The workflow records evidence and a guarded decision.',
        priority: 'must',
        verificationMethod: 'test',
      },
      {
        id: 'ac-2',
        statement: 'The root workbench task exposes every state and full content through HTTP.',
        priority: 'must',
        verificationMethod: 'test',
      },
    ],
    verificationPlan: {
      commands: [{
        id: 'cmd-real-service',
        command: 'node scripts/verify-multi-agent-real-service.mjs',
        required: true,
      }],
    },
    headShaAtAcceptance: input.headSha,
  });
  recordStep('contract.created', created);
  const subtaskContractDrafting = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(input.subtaskId)}`, {
    status: 'contract_drafting',
  });
  recordStep('subtask.contract_drafting', subtaskContractDrafting);
  const accepted = await client.post(
    `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(input.subtaskId)}/contracts/${encodeURIComponent(created.body.contract.id)}/accept`,
    { acceptedBy: 'codex-workflow-plugin', headShaAtAcceptance: input.headSha },
  );
  recordStep('contract.accepted', accepted);
  const subtaskContractAccepted = await client.patch(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(input.subtaskId)}`, {
    status: 'contract_accepted',
  });
  recordStep('subtask.contract_accepted', subtaskContractAccepted);
  return accepted.body;
}

async function createCompletedCodexInvocation(client, workflowId, input) {
  const created = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations`, {
    id: input.id,
    subtaskId: input.subtaskId,
    role: input.role,
    runner: input.runner,
    promptContract: input.promptContract,
    threadId: input.threadId,
    headSha: input.headSha,
    evidenceRefs: input.evidenceRefs,
    evaluationRunId: input.evaluationRunId,
    readonlyPolicy: input.readonlyPolicy,
  });
  const token = created.body.invocation.attestationToken;
  await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(input.id)}/hook-start`, {
    attestationToken: token,
    nonce: `nonce-${input.id}`,
    parentThreadId: 'real-service-parent-thread',
    actualSubagentThreadId: input.threadId,
    role: input.role,
    startedAt: '2026-07-03T00:00:00.000Z',
  });
  return client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(input.id)}/hook-stop`, {
    attestationToken: token,
    status: 'completed',
    stoppedAt: '2026-07-03T00:01:00.000Z',
    headSha: input.headSha,
    evidenceRefs: input.evidenceRefs,
    evaluationRunId: input.evaluationRunId,
    readonlyPolicy: input.readonlyPolicy,
    result: {
      threadId: input.threadId,
      headSha: input.headSha,
      evidenceRefs: input.evidenceRefs,
      evaluationRunId: input.evaluationRunId,
      readonlyPolicy: input.readonlyPolicy,
    },
  });
}

async function submitQuestionerOutput(client, workflowId, input) {
  const run = await client.post(`/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/questioner-runs`, {
    id: input.runId,
    invocationId: input.invocationId,
    subtaskId: input.subtaskId,
    intent: input.intent,
    contractId: input.contractId,
    evaluationRunId: input.evaluationRunId,
    finalEvaluationRunId: input.finalEvaluationRunId,
    headSha: input.headSha,
    start: true,
    runtimeAudit: { gitStatusBefore: '' },
  });
  const output = buildQuestionerOutput({
    id: input.outputId,
    runResponse: run.body,
    workflowId,
    subtaskId: input.subtaskId,
    intent: input.intent,
    contractId: input.contractId,
    evaluationRunId: input.evaluationRunId,
    finalEvaluationRunId: input.finalEvaluationRunId,
    headSha: input.headSha,
    coverageMatrix: input.coverageMatrix,
  });
  return client.post(
    `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/questioner-runs/${encodeURIComponent(input.runId)}/output`,
    { output, runtimeAudit: { gitStatusAfter: '' } },
    { headers: { authorization: `Bearer ${run.body.token}` } },
  );
}

function buildQuestionerOutput(input) {
  const output = {
    schemaVersion: 'questioner-output.v2',
    id: input.id,
    questionerRunId: input.runResponse.questionerRunId,
    workflowId: input.workflowId,
    subtaskId: input.subtaskId,
    intent: input.intent,
    source: 'claude-plugin',
    actor: {
      kind: 'claude-code-questioner',
      invocationId: input.runResponse.invocationId,
      pluginName: 'agent-loop-claude-review',
      skillName: 'question-tik-agent-loop',
    },
    attestation: {
      headSha: input.headSha,
      contextArtifactRef: input.runResponse.contextArtifactRef,
      contextHash: input.runResponse.contextHash,
      outputArtifactRef: input.runResponse.expectedOutputArtifactRef,
      outputHash: '',
      generatedAt: '2026-07-03T00:02:00.000Z',
    },
    references: {
      contractId: input.contractId,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
    },
    verdict: 'evidence_sufficient',
    coverageMatrix: input.coverageMatrix,
    questions: [],
    risks: [],
    missingTests: [],
    advisoryNotes: [],
  };
  output.attestation.outputHash = canonicalOutputHash(output);
  return output;
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
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.headers || {}),
      },
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
    workflowEventTypes: result.workflowEventTypes,
    invalidTransitionStatus: result.invalidTransitionStatus,
    missingEvidenceGuard: result.missingEvidenceGuard,
    finalEvidenceGuard: result.finalEvidenceGuard,
    error: result.message,
  }, null, 2));
}
