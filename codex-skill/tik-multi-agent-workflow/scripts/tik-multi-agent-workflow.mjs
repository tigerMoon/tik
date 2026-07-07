#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideNextAction } from '../lib/loop-gate.mjs';
import { findSubtask } from '../lib/task-graph.mjs';
import { buildWorkspaceBinding, git, resolveProjectPath } from '../lib/git.mjs';
import {
  acceptContract,
  createContract,
  createInvocation,
  createQuestionerRun,
  createTask,
  createEvaluationRun,
  commentTask,
  hookStartInvocation,
  hookStopInvocation,
  readNextAction,
  readTask,
  readWorkflow,
  recordDecision,
  recordEvidence,
  recordEvaluationResult,
  recordQuestionerOutput,
  readContextSnapshot,
  preflightDecision,
  runWorkflowAction,
  saveContextSnapshot,
  tikFetch,
  transitionTask,
  updateSubtask,
  validateEvaluationReadonly,
} from '../lib/tik-client.mjs';
import { instructionForDecision, printJson } from '../lib/output.mjs';

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = parseArgs(args);

  try {
    switch (command) {
      case 'init':
        await initWorkflow(options);
        break;
      case 'create-task':
        await createWorkflowTask(options);
        break;
      case 'comment-task':
        await commentWorkflowTask(options);
        break;
      case 'transition-task':
        await transitionWorkflowTask(options);
        break;
      case 'plan':
        await requestPlan(options);
        break;
      case 'accept-plan':
        await acceptPlan(options);
        break;
      case 'draft-contract':
        await draftContract(options);
        break;
      case 'accept-contract':
        await acceptSprintContract(options);
        break;
      case 'next':
        await next(options);
        break;
      case 'run-next':
        await runNext(options);
        break;
      case 'run-action':
        await runAction(options);
        break;
      case 'execute':
      case 'record-implementation':
        await execute(options);
        break;
      case 'start-builder':
        await startBuilder(options);
        break;
      case 'start-evaluator':
        await startEvaluator(options);
        break;
      case 'start-questioner':
        await startQuestioner(options);
        break;
      case 'complete-questioner':
      case 'import-questioner-output':
        await completeQuestioner(options);
        break;
      case 'complete-invocation':
        await finishInvocation(options);
        break;
      case 'validate':
        await validate(options);
        break;
      case 'evaluate':
        await evaluate(options);
        break;
      case 'record-questioner':
      case 'ask-claude':
        await recordQuestioner(options);
        break;
      case 'complete-subtask':
        await completeSubtask(options);
        break;
      case 'complete-workflow':
        await completeWorkflow(options);
        break;
      case 'continue':
        await continueWorkflow(options);
        break;
      case 'resume':
      case 'status':
        await status(options);
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error?.payload) {
      console.error(JSON.stringify(error.payload, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

async function initWorkflow(options) {
  const projectPath = resolveProjectPath(options.path);
  const repo = options.repo || path.basename(projectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD']);
  const headRef = options.headRef || git(projectPath, ['branch', '--show-current'], { optional: true }) || 'HEAD';
  const body = {
    id: stringOption(options.workflow),
    goal: requireOption(options.goal, '--goal is required'),
    rootTaskId: stringOption(options.rootTask) || stringOption(options.workflow),
    repo,
    baseRef: options.base || 'HEAD~1',
    headRef,
    headSha,
    maxRounds: numberOption(options.maxRounds, 3),
    workspaceBinding: buildWorkspaceBinding(projectPath, options),
    metadata: omitUndefined({
      parentCodexThreadId: stringOption(options.parentThread),
    }),
    policy: codexEvaluatorQuestionerPolicy(),
  };
  const response = await tikFetch(options, '/v1/multi-agent/workflows', {
    method: 'POST',
    body,
  });
  await writeJsonIfRequested(options.output, response);
  printJson({
    action: 'initialized',
    workflowId: response.workflow?.id,
    rootTaskId: response.workflow?.rootTaskId,
    status: response.workflow?.status,
    driver: response.workflow?.driver,
    headSha: response.workflow?.currentHeadSha,
    policy: response.workflow?.policy,
    mode: 'v1',
    breakingChange: 'v1.1 removed legacy multi-agent Claude review commands; use the contract/evaluator/questioner loop.',
    nextCommand: `node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs next --workflow ${response.workflow?.id}`,
  });
}

async function createWorkflowTask(options) {
  const projectPath = resolveProjectPath(options.path);
  const title = requireOption(options.title, '--title is required');
  const goal = requireOption(options.goal, '--goal is required');
  const response = await createTask(options, {
    id: stringOption(options.task),
    title,
    goal,
    description: stringOption(options.description),
    status: stringOption(options.status) || 'todo',
    priority: numberOption(options.priority, undefined),
    labels: splitList(options.label) || ['multi-agent'],
    workspaceBinding: buildWorkspaceBinding(projectPath, options),
  });
  printJson({
    action: 'task-created',
    taskId: response.task?.id,
    shortIdentifier: response.task?.shortIdentifier || response.task?.identifier,
    status: response.task?.status,
    title: response.task?.title,
    nextCommand: `node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs init --root-task ${response.task?.id} --goal "${escapeDoubleQuoted(goal)}"`,
  });
}

async function commentWorkflowTask(options) {
  const taskRef = requireOption(options.task, '--task is required');
  const task = await readTask(options, taskRef);
  const response = await commentTask(options, task.id, {
    authorKind: stringOption(options.authorKind) || 'agent',
    authorId: stringOption(options.authorId) || 'codex',
    body: requireOption(options.body, '--body is required'),
  });
  printJson({
    action: 'task-commented',
    taskId: response.task?.id,
    shortIdentifier: response.task?.shortIdentifier || response.task?.identifier,
    commentCount: response.task?.comments?.length || 0,
  });
}

async function transitionWorkflowTask(options) {
  const taskRef = requireOption(options.task, '--task is required');
  const task = await readTask(options, taskRef);
  const response = await transitionTask(options, task.id, {
    to: requireOption(options.to, '--to is required'),
    reason: stringOption(options.reason),
    actor: stringOption(options.actor) || 'agent',
  });
  printJson({
    action: 'task-transitioned',
    taskId: response.task?.id,
    shortIdentifier: response.task?.shortIdentifier || response.task?.identifier,
    status: response.task?.status,
  });
}

async function requestPlan(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const workflow = state.workflow;
  const decision = buildDecision(workflow, {
    action: 'request_dynamic_plan',
    reason: 'Codex workflow requested Claude dynamic planning.',
    evidenceRefs: [],
    inputs: {
      baseRef: workflow.baseRef,
      currentHeadSha: workflow.currentHeadSha,
    },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  const invocation = await tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations`, {
    method: 'POST',
    body: {
      role: 'planner',
      runner: 'claude-code',
      promptContract: 'task-graph.v1',
      input: {
        goal: workflow.goal,
        constraints: splitList(options.constraint) || [],
        baseRef: workflow.baseRef,
        currentHeadSha: workflow.currentHeadSha,
      },
    },
  });
  printJson({
    action: 'plan-requested',
    workflowId,
    decision: recorded.decision,
    guard: recorded.guard,
    invocation: invocation.invocation,
    instruction: 'Launch or inspect the Claude planner invocation, then store the returned TaskGraph with accept-plan.',
  });
}

async function acceptPlan(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const graph = options.taskGraphJson
    ? JSON.parse(String(options.taskGraphJson))
    : await readJsonFile(requireOption(options.taskGraph, '--task-graph or --task-graph-json is required'));
  const response = await tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/task-graph`, {
    method: 'PUT',
    body: { graph },
  });
  printJson({
    action: 'accepted-plan',
    workflowId,
    version: response.graph?.version,
    subtaskCount: response.graph?.subtasks?.length || 0,
    readySubtasks: Object.values(response.subtasks || {}).filter((state) => state.status === 'ready').map((state) => state.subtaskId),
  });
}

async function next(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const nextAction = await resolveNextAction(options, workflowId, state);
  const decision = buildDecision(state.workflow, nextAction);
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  printJson({
    action: 'next',
    workflowId,
    plannedAction: nextAction,
    decision,
    guard: recorded.guard,
    commandHint: nextAction.commandHint,
    instruction: instructionForDecision(decision, state),
  });
}

async function runNext(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const nextAction = await resolveNextAction(options, workflowId, state);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = stringOption(options.headSha)
    || git(projectPath, ['rev-parse', 'HEAD'], { optional: true })
    || state.workflow.currentHeadSha;
  await runAction({
    ...options,
    action: nextAction.action,
    subtask: options.subtask || nextAction.subtaskId,
    headSha,
  }, nextAction);
}

async function runAction(options, plannedAction) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const actionId = requireOption(options.action, '--action is required');
  const response = await runWorkflowAction(options, workflowId, actionId, {
    subtaskId: stringOption(options.subtask) || plannedAction?.subtaskId,
    headSha: stringOption(options.headSha),
    options: omitUndefined({
      start: options.start === false || options.start === 'false' ? false : undefined,
      id: stringOption(options.run),
      invocationId: stringOption(options.invocationId) || stringOption(options.invocation),
      tokenTtlMs: stringOption(options.tokenTtlMs) ? Number(stringOption(options.tokenTtlMs)) : undefined,
      runtimeAudit: stringOption(options.gitStatusBefore)
        ? { gitStatusBefore: stringOption(options.gitStatusBefore) }
        : undefined,
    }),
  });
  printJson({
    action: 'action-run',
    workflowId,
    workflowAction: response.action || actionId,
    plannedAction: response.plannedAction,
    created: response.created,
    questionerRunId: response.questionerRunId,
    invocationId: response.invocationId,
    contextArtifactRef: response.contextArtifactRef,
    contextHash: response.contextHash,
    expectedOutputArtifactRef: response.expectedOutputArtifactRef,
    submitUrl: response.submitUrl,
    contextUrl: response.contextUrl,
    tokenExpiresAt: response.tokenExpiresAt,
    token: response.token,
    invocation: response.invocation,
    guard: response.guard,
    instruction: response.token
      ? 'Spawn a Codex native subagent to run the Claude Questioner plugin/runtime with the printed TIK_QUESTIONER_* values, then return; the plugin hook/callback should POST QuestionerOutputV2 to submitUrl.'
      : response.guard?.message,
    env: response.token
      ? {
        TIK_QUESTIONER_RUN_ID: response.questionerRunId,
        TIK_QUESTIONER_CONTEXT_URL: absoluteApiUrl(options, response.contextUrl),
        TIK_QUESTIONER_SUBMIT_URL: absoluteApiUrl(options, response.submitUrl),
        TIK_QUESTIONER_TOKEN: response.token,
        TIK_EXPECTED_HEAD_SHA: response.questionerRun?.headSha || stringOption(options.headSha),
        TIK_QUESTIONER_OUTPUT_PATH: response.expectedOutputArtifactRef,
      }
      : undefined,
  });
}

async function draftContract(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const subtask = findSubtask(state.taskGraph, subtaskId);
  if (!subtask) {
    throw new Error(`Subtask not found in TaskGraph: ${subtaskId}`);
  }
  const headSha = options.headSha || state.workflow.currentHeadSha || git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true });
  const contract = options.contractJson
    ? JSON.parse(String(options.contractJson))
    : options.contract
      ? await readJsonFile(options.contract)
      : buildDefaultContract(state, subtask, headSha);
  const response = await createContract(options, workflowId, subtaskId, contract);
  await updateSubtask(options, workflowId, subtaskId, { status: 'contract_drafting' });
  printJson({
    action: 'contract-drafted',
    workflowId,
    subtaskId,
    contract: response.contract,
    nextCommand: `node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs accept-contract --workflow ${workflowId} --subtask ${subtaskId} --contract ${response.contract?.id}`,
  });
}

async function acceptSprintContract(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const contractId = requireOption(options.contract, '--contract is required');
  const state = await readWorkflow(options, workflowId);
  const headSha = options.headSha || state.workflow.currentHeadSha || git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true });
  const response = await acceptContract(options, workflowId, subtaskId, contractId, {
    acceptedBy: 'codex-workflow-plugin',
    headShaAtAcceptance: headSha,
    questionerOutputRefs: splitList(options.questionerOutputRefs) || [],
  });
  const subtask = await updateSubtask(options, workflowId, subtaskId, { status: 'contract_accepted' });
  printJson({
    action: 'contract-accepted',
    workflowId,
    subtaskId,
    contract: response.contract,
    subtask: subtask.subtask,
  });
}

async function execute(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const decision = buildDecision(state.workflow, {
    action: 'execute_subtask',
    subtaskId,
    reason: options.summary || 'Codex is about to record implementation evidence.',
    evidenceRefs: [],
    inputs: { currentHeadSha: headSha },
  });
  const preflight = await safePreflightDecision(options, workflowId, decision, state);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'execution-rejected',
      workflowId,
      subtaskId,
      decision,
      guard: preflight.guard,
    });
    return;
  }
  const currentStatus = state.subtasks?.[subtaskId]?.status;
  if (currentStatus === 'pending') {
    await updateSubtask(options, workflowId, subtaskId, { status: 'ready' });
  }
  await updateSubtask(options, workflowId, subtaskId, { status: 'executing' });
  const declaredChangedFiles = (splitList(options.changedFiles) || []).map((file) => ({
    path: file,
    changeType: 'modified',
  }));
  const observedChangedFiles = deriveObservedChangedFiles(projectPath, state, subtaskId, options).map((file) => ({
    path: file,
    changeType: 'modified',
  }));
  const existingEvidenceRefs = state.subtasks?.[subtaskId]?.evidenceRefs || [];
  const changedFiles = observedChangedFiles;
  const scopeCheck = buildImplementationScopeCheck(state, subtaskId, observedChangedFiles.map((file) => file.path));
  const invocationId = stringOption(options.invocation);
  const threadId = stringOption(options.thread);
  const evidence = await recordEvidence(options, workflowId, {
    id: stringOption(options.evidenceId),
    kind: 'implementation',
    title: options.title || `Codex implementation for ${subtaskId}`,
    summary: options.summary || 'Codex session recorded implementation evidence.',
    subtaskId,
    headSha,
    payload: omitUndefined({
      changedFiles,
      declaredChangedFiles,
      observedChangedFiles,
      scopeCheck,
      builderInvocationId: invocationId,
      builderThreadId: threadId,
    }),
  });
  let invocation = null;
  if (invocationId) {
    invocation = await hookStopInvocation(options, workflowId, invocationId, {
      attestationToken: requireOption(options.attestationToken, '--attestation-token is required to complete a Codex Builder invocation'),
      status: 'completed',
      headSha,
      evidenceRefs: [evidence.evidence.id],
      result: omitUndefined({
        threadId,
        headSha,
        evidenceRefs: [evidence.evidence.id],
        changedFiles,
        declaredChangedFiles,
        observedChangedFiles,
        scopeCheck,
      }),
    });
  }
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: 'implemented',
    implementationHeadSha: headSha,
    evidenceRefs: mergeEvidenceRefs(existingEvidenceRefs, [evidence.evidence.id]),
  });
  const finalDecision = {
    ...decision,
    action: 'validate_subtask',
    evidenceRefs: mergeEvidenceRefs(existingEvidenceRefs, [evidence.evidence.id]),
    reason: 'Codex recorded implementation evidence; validation is next.',
  };
  const recorded = await safeRecordDecision(options, workflowId, finalDecision, state);
  printJson({
    action: 'execution-recorded',
    workflowId,
    subtaskId,
    evidence: evidence.evidence,
    invocation: invocation?.invocation,
    subtask: subtask.subtask,
    decision: finalDecision,
    guard: recorded.guard,
  });
}

async function startBuilder(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const invocation = await createInvocation(options, workflowId, {
    id: stringOption(options.invocation),
    subtaskId,
    role: 'executor',
    runner: 'codex',
    promptContract: stringOption(options.promptContract) || 'codex-builder.v1',
    input: {
      goal: state.workflow.goal,
      subtaskId,
      contractId: latestContractId(state, subtaskId),
      currentHeadSha: headSha,
    },
    allowedPaths: collectSubtaskAllowedPaths(state, subtaskId),
    validationCommands: collectSubtaskValidationCommands(state, subtaskId),
    threadId: stringOption(options.thread),
    headSha,
  });
  const attestationToken = requireInvocationToken(invocation.invocation);
  printJson({
    action: 'builder-pending',
    workflowId,
    subtaskId,
    invocation: redactInvocationToken(invocation.invocation),
    instruction: 'Spawn a Codex Builder subagent; Codex hook will attest runtime start.',
  });
}

async function startEvaluator(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const evaluatorAllowedPaths = mergeEvidenceRefs(defaultEvaluatorAllowedPaths(), splitList(options.evaluatorArtifactPath));
  const invocation = await createInvocation(options, workflowId, {
    id: stringOption(options.invocation),
    subtaskId,
    role: 'evaluator',
    runner: 'codex-evaluator',
    promptContract: stringOption(options.promptContract) || 'codex-evaluator.v1',
    input: {
      goal: state.workflow.goal,
      subtaskId,
      contractId: latestContractId(state, subtaskId) || (subtaskId === '__final__' ? '__final__' : undefined),
      currentHeadSha: headSha,
      readonly: true,
    },
    allowedPaths: evaluatorAllowedPaths,
    validationCommands: collectSubtaskValidationCommands(state, subtaskId),
    threadId: stringOption(options.thread),
    headSha,
    readonlyPolicy: {
      enforced: true,
      violations: [],
    },
  });
  const attestationToken = requireInvocationToken(invocation.invocation);
  printJson({
    action: 'evaluator-pending',
    workflowId,
    subtaskId,
    invocation: redactInvocationToken(invocation.invocation),
    instruction: 'Spawn a Codex Evaluator subagent; Codex hook will attest runtime start.',
  });
}

async function startQuestioner(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const intent = requireOption(options.intent, '--intent is required');
  const state = await readWorkflow(options, workflowId);
  const subtaskId = stringOption(options.subtask);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const gitStatusBefore = git(projectPath, ['status', '--porcelain=v1'], { optional: true }) || '';
  const evaluationRunId = stringOption(options.evaluation) || (
    intent === 'question_final_evidence'
      ? latestEvaluationId(state, '__final__')
      : subtaskId ? latestEvaluationId(state, subtaskId) : undefined
  );
  const finalEvaluationRunId = intent === 'question_final_evidence'
    ? evaluationRunId
    : undefined;
  const contractId = stringOption(options.contract) || (
    intent === 'question_final_evidence'
      ? undefined
      : subtaskId ? latestContractId(state, subtaskId) : undefined
  );
  const run = await createQuestionerRun(options, workflowId, {
    id: stringOption(options.run),
    invocationId: stringOption(options.invocationId) || stringOption(options.invocation),
    subtaskId,
    intent,
    contractId,
    evaluationRunId: finalEvaluationRunId ? undefined : evaluationRunId,
    finalEvaluationRunId,
    headSha,
    start: options.start === false || options.start === 'false' ? false : true,
    runtimeAudit: {
      gitStatusBefore,
    },
  });
  printJson({
    action: run.invocation.status === 'started' ? 'questioner-run-started' : 'questioner-run-created',
    workflowId,
    questionerRunId: run.questionerRunId,
    invocationId: run.invocationId,
    contextArtifactRef: run.contextArtifactRef,
    contextHash: run.contextHash,
    expectedOutputArtifactRef: run.expectedOutputArtifactRef,
    submitUrl: run.submitUrl,
    contextUrl: run.contextUrl,
    tokenExpiresAt: run.tokenExpiresAt,
    token: run.token,
    invocation: run.invocation,
    instruction: 'Spawn a Codex native subagent to run the Claude Questioner plugin/runtime with the printed TIK_QUESTIONER_* values, then return; the plugin hook/callback should POST QuestionerOutputV2 to submitUrl.',
    env: {
      TIK_QUESTIONER_RUN_ID: run.questionerRunId,
      TIK_QUESTIONER_CONTEXT_URL: absoluteApiUrl(options, run.contextUrl),
      TIK_QUESTIONER_SUBMIT_URL: absoluteApiUrl(options, run.submitUrl),
      TIK_QUESTIONER_TOKEN: run.token,
      TIK_EXPECTED_HEAD_SHA: headSha,
      TIK_QUESTIONER_OUTPUT_PATH: run.expectedOutputArtifactRef,
      TIK_QUESTIONER_GIT_STATUS_BEFORE: gitStatusBefore,
    },
  });
}

async function completeQuestioner(options) {
  if (!options.unsafeLegacy) {
    throw new Error('complete-questioner is legacy. Use the QuestionerRun submit API, or pass --unsafe-legacy to import an explicit legacy output.');
  }
  if (!options.outputJson && !options.output) {
    throw new Error('--output or --output-json is required; default QuestionerOutput is not allowed.');
  }
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const invocationId = requireOption(options.invocation, '--invocation is required');
  const output = options.outputJson
    ? JSON.parse(String(options.outputJson))
    : await readJsonFile(options.output);
  output.actor = {
    ...(output.actor || {}),
    kind: 'claude-code-questioner',
    invocationId,
  };
  output.source = 'claude-plugin';
  output.id = output.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const invocation = await tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(invocationId)}/result`, {
    method: 'POST',
    body: {
      status: stringOption(options.status) || 'completed',
      headSha: output.headSha,
      evaluationRunId: output.evaluationRunId || output.finalEvaluationRunId,
      result: omitUndefined({
        evaluationRunId: output.evaluationRunId || output.finalEvaluationRunId,
        finalEvaluationRunId: output.finalEvaluationRunId,
        questionerOutput: output,
      }),
    },
  });
  const recorded = await recordQuestionerOutput(options, workflowId, output);
  if (output.subtaskId && output.intent === 'question_evaluation') {
    const blockingQuestions = blockingQuestionerQuestions(output);
    await updateSubtask(options, workflowId, output.subtaskId, {
      status: blockingQuestions.length > 0 ? 'needs_fix' : 'questioning_evidence',
      blockerFindingIds: blockingQuestions
        .map((question) => `${output.id || recorded.questionerOutput.id}:${question.id}`),
    });
  }
  printJson({
    action: 'questioner-output-recorded',
    workflowId,
    invocation: invocation.invocation,
    questionerOutput: recorded.questionerOutput,
  });
}

async function finishInvocation(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const invocationId = requireOption(options.invocation, '--invocation is required');
  const status = stringOption(options.status) || 'completed';
  if (status === 'started') {
    const state = await readWorkflow(options, workflowId);
    const invocation = (state.invocations || []).find((item) => item.id === invocationId);
    const role = stringOption(options.role) || invocation?.role;
    if (!role) {
      throw new Error('--role is required for hook-start attestation when invocation role cannot be read from workflow state');
    }
    const response = await hookStartInvocation(options, workflowId, invocationId, buildHookStartPayload(
      options,
      role,
      requireOption(options.attestationToken, '--attestation-token is required for Codex hook-start attestation'),
    ));
    printJson({
      action: 'invocation-started',
      workflowId,
      invocation: response.invocation,
    });
    return;
  }
  const response = await hookStopInvocation(options, workflowId, invocationId, {
    attestationToken: requireOption(options.attestationToken, '--attestation-token is required for Codex hook-stop attestation'),
    status,
    headSha: stringOption(options.headSha),
    evidenceRefs: splitList(options.evidenceRefs),
    evaluationRunId: stringOption(options.evaluation),
    readonlyPolicy: buildReadonlyPolicyFromOptions(options),
    result: omitUndefined({
      threadId: stringOption(options.thread),
      headSha: stringOption(options.headSha),
      evidenceRefs: splitList(options.evidenceRefs),
      evaluationRunId: stringOption(options.evaluation),
      readonlyPolicy: buildReadonlyPolicyFromOptions(options),
    }),
  });
  printJson({
    action: 'invocation-completed',
    workflowId,
    invocation: response.invocation,
  });
}

async function validate(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path);
  const command = options.command || inferValidationCommand(state, subtaskId);
  if (!command) {
    throw new Error('--command is required when subtask has no validationCommands');
  }
  const commandResult = await runCommandWithArtifacts({
    command,
    cwd: projectPath,
    hardTimeoutMs: numberOption(options.timeoutMs, 120000),
    idleTimeoutMs: numberOption(options.idleTimeoutMs, 0),
    maxOutputBytes: numberOption(options.maxOutputBytes, 20000),
    stdoutArtifactPath: path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'validation', subtaskId, `${stringOption(options.evidenceId) || 'validation'}.stdout.log`),
    stderrArtifactPath: path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'validation', subtaskId, `${stringOption(options.evidenceId) || 'validation'}.stderr.log`),
  });
  const passed = commandResult.status === 'passed';
  const output = [commandResult.stdout, commandResult.stderr].filter(Boolean).join('\n');
  const headSha = git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const preflightDecision = buildDecision(state.workflow, {
    action: 'validate_subtask',
    subtaskId,
    reason: 'Codex is about to record validation evidence.',
    evidenceRefs: state.subtasks?.[subtaskId]?.evidenceRefs || [],
    inputs: {
      currentHeadSha: headSha,
    },
  });
  const preflight = await safePreflightDecision(options, workflowId, preflightDecision, state);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'validation-rejected',
      workflowId,
      subtaskId,
      passed,
      exitCode: commandResult.exitCode,
      decision: preflightDecision,
      guard: preflight.guard,
    });
    return;
  }
  const evidence = await recordEvidence(options, workflowId, {
    id: stringOption(options.evidenceId),
    kind: 'validation',
    title: options.title || `Validation for ${subtaskId}`,
    summary: passed ? 'Validation passed.' : 'Validation failed.',
    subtaskId,
    command,
    passed,
    artifactRef: commandResult.stdoutArtifactId || commandResult.stderrArtifactId,
    payload: {
      status: commandResult.status,
      exitCode: commandResult.exitCode,
      output: output.slice(0, 20_000),
      stdoutArtifactId: commandResult.stdoutArtifactId,
      stderrArtifactId: commandResult.stderrArtifactId,
    },
    headSha,
  });
  const evidenceRefs = mergeEvidenceRefs(state.subtasks?.[subtaskId]?.evidenceRefs, [evidence.evidence.id]);
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: passed ? 'validated' : 'validation_failed',
    lastValidatedHeadSha: headSha,
    validationRunIds: [evidence.evidence.id],
    evidenceRefs,
  });
  const decision = buildDecision(state.workflow, {
    action: passed ? 'run_codex_evaluator' : 'execute_subtask',
    subtaskId,
    reason: passed
      ? 'Validation passed; run an isolated Codex Evaluator.'
      : 'Validation failed; current Codex session must inspect and fix.',
    evidenceRefs,
    inputs: {
      currentHeadSha: headSha,
      validationPassed: passed,
    },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  printJson({
    action: 'validation-recorded',
    workflowId,
    subtaskId,
    passed,
    exitCode: commandResult.exitCode,
    evidence: evidence.evidence,
    subtask: subtask.subtask,
    decision,
    guard: recorded.guard,
  });
  if (!passed && options.failOnValidationError) {
    process.exitCode = commandResult.exitCode || 1;
  }
}

async function evaluate(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const contractId = options.contract || latestContractId(state, subtaskId) || (subtaskId === '__final__' ? '__final__' : undefined);
  if (!contractId) {
    throw new Error('--contract is required when no accepted contract is stored');
  }
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const gitStatusBefore = git(projectPath, ['status', '--porcelain=v1'], { optional: true }) || '';
  const sandbox = await prepareEvaluatorSandbox(projectPath, headSha, options);
  const evaluationCwd = sandbox.path || projectPath;
  const evaluationRun = await createEvaluationRun(options, workflowId, subtaskId, {
    id: stringOption(options.evaluation),
    contractId,
    headSha,
    evaluator: {
      kind: 'codex-evaluator',
      sessionId: stringOption(options.thread) || stringOption(options.session),
      runnerId: stringOption(options.invocation),
    },
  });
  if (subtaskId !== '__final__') {
    await updateSubtask(options, workflowId, subtaskId, { status: 'evaluating' });
  }
  const structuredResult = options.resultJson
    ? JSON.parse(String(options.resultJson))
    : options.result
      ? await readJsonFile(options.result)
      : null;
  const commands = evaluationCommandsFromOptions(options, state, subtaskId);
  const setupCommands = splitList(options.evaluatorSetupCommand) || splitList(options.setupCommand) || [];
  const commandResults = [];
  let commandResult = null;
  let setupFailure = null;
  try {
    for (const [index, setupCommand] of setupCommands.entries()) {
      const setupResult = await runCommandWithArtifacts({
        command: setupCommand,
        cwd: evaluationCwd,
        artifactBasePath: projectPath,
        hardTimeoutMs: numberOption(options.setupTimeoutMs, numberOption(options.timeoutMs, 120000)),
        idleTimeoutMs: numberOption(options.idleTimeoutMs, 0),
        maxOutputBytes: numberOption(options.maxOutputBytes, 20000),
        stdoutArtifactPath: path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'evaluations', evaluationRun.evaluationRun.id, `setup-${index + 1}.stdout.log`),
        stderrArtifactPath: path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'evaluations', evaluationRun.evaluationRun.id, `setup-${index + 1}.stderr.log`),
      });
      setupResult.commandId = `cmd-evaluate-setup-${index + 1}`;
      commandResults.push(setupResult);
      if (setupResult.status !== 'passed') {
        setupFailure = setupResult;
        break;
      }
    }
    if (commands.length > 0 && !setupFailure) {
      const commandIds = splitList(options.commandId) || [];
      for (const [index, command] of commands.entries()) {
        const artifactSuffix = commands.length === 1 ? '' : `-${index + 1}`;
        const currentResult = await runCommandWithArtifacts({
          command,
          cwd: evaluationCwd,
          artifactBasePath: projectPath,
          hardTimeoutMs: numberOption(options.timeoutMs, 120000),
          idleTimeoutMs: numberOption(options.idleTimeoutMs, 0),
          maxOutputBytes: numberOption(options.maxOutputBytes, 20000),
          stdoutArtifactPath: path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'evaluations', evaluationRun.evaluationRun.id, `stdout${artifactSuffix}.log`),
          stderrArtifactPath: path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'evaluations', evaluationRun.evaluationRun.id, `stderr${artifactSuffix}.log`),
        });
        currentResult.commandId = commandIds[index]
          || (commands.length === 1 ? 'cmd-evaluate' : `cmd-evaluate-${index + 1}`);
        commandResults.push(currentResult);
        commandResult = currentResult;
        if (currentResult.status !== 'passed') {
          break;
        }
      }
    }
  } finally {
    await cleanupEvaluatorSandbox(sandbox);
  }
  const gitStatusAfter = git(projectPath, ['status', '--porcelain=v1'], { optional: true }) || '';
  const readonly = await safeValidateEvaluationReadonly(options, workflowId, subtaskId, evaluationRun.evaluationRun.id, {
    gitStatusBefore,
    gitStatusAfter,
  });
  let verdict = readonly.guard?.accepted === false
    ? 'fail'
    : structuredResult?.verdict
      ? structuredResult.verdict
      : setupFailure || evaluationCommandResults(commandResults).some((result) => result.status !== 'passed')
      ? 'fail'
      : !hasEvaluationCommandResult(commandResults)
        ? 'inconclusive'
      : 'pass';
  const coverageGaps = Array.isArray(structuredResult?.coverageGaps)
    ? structuredResult.coverageGaps
    : !hasEvaluationCommandResult(commandResults)
      ? [{
        criterionId: 'all',
        description: 'Evaluator did not provide command, criteria, artifact, or reproduction evidence.',
        reason: 'No evaluator command, criteria result, or artifact evidence was provided.',
      }]
      : [];
  const failedCommandResult = evaluationCommandResults(commandResults).find((result) => result.status !== 'passed');
  const decisiveCommandResult = setupFailure || failedCommandResult || commandResult;
  const criteriaResults = Array.isArray(structuredResult?.criteriaResults)
    ? structuredResult.criteriaResults
    : buildCriteriaResultsFromCommands(state, subtaskId, evaluationCommandResults(commandResults), decisiveCommandResult, coverageGaps);
  const runtimeFindings = Array.isArray(structuredResult?.runtimeFindings)
    ? structuredResult.runtimeFindings
    : verdict === 'pass'
    ? []
    : [{
      id: 'evaluation_failed',
      severity: 'blocker',
      title: 'Evaluation failed',
      observed: decisiveCommandResult?.summary || readonly.guard?.message || 'Evaluation did not pass.',
      expected: 'Evaluation passes without readonly violations.',
      reproductionSteps: decisiveCommandResult?.command
        ? [decisiveCommandResult.command]
        : commands.length > 0
          ? commands
          : ['Inspect evaluator artifacts and readonly guard output.'],
    }];
  const hasCommandEvidence = hasEvaluationCommandResult(commandResults);
  const hasStructuredCriteriaEvidence = Array.isArray(structuredResult?.criteriaResults)
    && structuredResult.criteriaResults.length > 0;
  const hasArtifactEvidence = Array.isArray(structuredResult?.artifacts) && structuredResult.artifacts.length > 0;
  const hasReproductionEvidence = criteriaResults.some((criterion) => (criterion.reproductionSteps?.length || 0) > 0)
    || runtimeFindings.some((finding) => (finding.reproductionSteps?.length || 0) > 0);
  if (
    verdict === 'pass'
    && !hasCommandEvidence
    && !hasStructuredCriteriaEvidence
    && !hasArtifactEvidence
    && !hasReproductionEvidence
  ) {
    verdict = 'inconclusive';
    coverageGaps.push({
      criterionId: 'all',
      description: 'Evaluator did not provide command, criteria, artifact, or reproduction evidence.',
      reason: 'No evaluator command, criteria result, or artifact evidence was provided.',
    });
  }
  const result = {
    workflowId,
    subtaskId,
    contractId,
    evaluatorRunId: evaluationRun.evaluationRun.id,
    headSha,
    verdict,
    criteriaResults,
    commandResults: hasEvaluationCommandResult(commandResults) || setupFailure
      ? commandResults.map((result) => ({
        commandId: result.commandId,
        command: result.command,
        status: result.status,
        exitCode: result.exitCode,
        stdoutArtifactId: result.stdoutArtifactId,
        stderrArtifactId: result.stderrArtifactId,
        summary: result.summary,
      }))
      : [],
    runtimeFindings,
    coverageGaps,
    confidence: verdict === 'pass' ? 0.85 : 0.25,
  };
  const recorded = await recordEvaluationResult(options, workflowId, subtaskId, evaluationRun.evaluationRun.id, result);
  let invocation = null;
  if (options.invocation) {
    const readonlyPolicy = {
      enforced: readonly.guard?.accepted !== false,
      violations: recorded.evaluationRun?.readonlyPolicy?.violations || readonly.evaluationRun?.readonlyPolicy?.violations || [],
      allowedWritePaths: defaultEvaluatorAllowedPaths(),
      forbiddenWritePaths: ['**/*'],
    };
    invocation = await hookStopInvocation(options, workflowId, String(options.invocation), {
      attestationToken: requireOption(options.attestationToken, '--attestation-token is required to complete a Codex Evaluator invocation'),
      status: verdict === 'pass' ? 'completed' : 'failed',
      headSha,
      evaluationRunId: evaluationRun.evaluationRun.id,
      readonlyPolicy,
      result: {
        threadId: stringOption(options.thread),
        headSha,
        evaluationRunId: evaluationRun.evaluationRun.id,
        readonlyPolicy,
        sandbox: sandbox.summary,
      },
    });
  }
  if (subtaskId !== '__final__') {
    await updateSubtask(options, workflowId, subtaskId, {
      status: verdict === 'pass' ? 'evaluation_passed' : 'evaluation_failed',
      validationRunIds: [evaluationRun.evaluationRun.id],
    });
  }
  printJson({
    action: 'evaluation-recorded',
    workflowId,
    subtaskId,
    passed: verdict === 'pass',
    evaluationRun: recorded.evaluationRun,
    invocation: invocation?.invocation,
    readonly: readonly.guard,
    command: commandResult ? {
      command: commandResult.command,
      status: commandResult.status,
      exitCode: commandResult.exitCode,
      commands: evaluationCommandResults(commandResults)
        .map((result) => ({ command: result.command, status: result.status, exitCode: result.exitCode })),
      setupCommands: commandResults
        .filter((result) => result.commandId?.startsWith('cmd-evaluate-setup-'))
        .map((result) => ({ command: result.command, status: result.status, exitCode: result.exitCode })),
    } : undefined,
  });
  if (verdict !== 'pass' && options.failOnValidationError) {
    process.exitCode = (setupFailure || failedCommandResult || commandResult)?.exitCode || 1;
  }
}

async function recordQuestioner(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const output = options.outputJson
    ? JSON.parse(String(options.outputJson))
    : options.output
      ? await readJsonFile(options.output)
      : buildDefaultQuestionerOutput(options);
  const response = await recordQuestionerOutput(options, workflowId, output);
  if (output.subtaskId && output.intent === 'question_evaluation') {
    const blockingQuestions = blockingQuestionerQuestions(output);
    await updateSubtask(options, workflowId, output.subtaskId, {
      status: blockingQuestions.length > 0 ? 'needs_fix' : 'questioning_evidence',
      blockerFindingIds: blockingQuestions
        .map((question) => `${output.id || response.questionerOutput.id}:${question.id}`),
    });
  }
  printJson({
    action: 'questioner-output-recorded',
    workflowId,
    questionerOutput: response.questionerOutput,
  });
}

async function completeSubtask(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const decision = buildDecision(state.workflow, {
    action: 'complete_subtask',
    subtaskId,
    reason: stringOption(options.reason) || 'Codex Evaluator passed and Claude Questioner found no blocking evidence questions.',
    evidenceRefs: state.subtasks?.[subtaskId]?.evidenceRefs || [],
    inputs: {
      currentHeadSha: state.workflow.currentHeadSha,
      contractId: latestContractId(state, subtaskId),
      evaluationRunId: latestEvaluationId(state, subtaskId),
      questionerOutputId: latestQuestionerOutputId(state, subtaskId, 'question_evaluation'),
    },
  });
  const preflight = await safePreflightDecision(options, workflowId, decision, state);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'subtask-complete-rejected',
      workflowId,
      subtaskId,
      decision,
      guard: preflight.guard,
    });
    return;
  }
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: 'done',
  });
  printJson({
    action: 'subtask-completed',
    workflowId,
    subtaskId,
    decision,
    guard: recorded.guard,
    subtask: subtask.subtask,
  });
}

async function completeWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const decision = buildDecision(state.workflow, {
    action: 'complete_workflow',
    reason: stringOption(options.reason) || 'All subtasks are done, final evaluation passed, and final Questioner found no blocking questions.',
    evidenceRefs: collectSubtaskEvidenceRefs(state),
    inputs: {
      currentHeadSha: state.workflow.currentHeadSha,
      taskGraphVersion: state.taskGraph?.version,
      evaluationRunId: latestEvaluationId(state, '__final__'),
      questionerOutputId: latestQuestionerOutputId(state, undefined, 'question_final_evidence'),
    },
  });
  const preflight = await safePreflightDecision(options, workflowId, decision, state);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'workflow-complete-rejected',
      workflowId,
      decision,
      guard: preflight.guard,
    });
    return;
  }
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  printJson({
    action: 'workflow-completed',
    workflowId,
    decision,
    guard: recorded.guard,
    workflow: recorded.workflow,
  });
}

async function continueWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const initialState = await readWorkflow(options, workflowId);
  const maxRounds = loopMaxRounds(initialState.workflow, options);
  const stopOn = new Set(initialState.workflow?.policy?.loopContract?.stop || ['guard_rejected', 'human_required']);
  const rounds = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const state = await readWorkflow(options, workflowId);
    await refreshMainSnapshot(options, state, {
      round,
      nextActionHint: 'Codex workflow continue round started.',
    });

    if (state.workflow?.status === 'completed' || state.workflow?.status === 'aborted') {
      const snapshot = await refreshMainSnapshot(options, state, {
        round,
        nextActionHint: `Workflow is ${state.workflow.status}.`,
      });
      printJson({
        action: 'continue',
        workflowId,
        status: state.workflow.status,
        rounds,
        snapshot,
      });
      return;
    }
    if (state.workflow?.status === 'blocked' || state.workflow?.status === 'human_review_required') {
      const snapshot = await refreshMainSnapshot(options, state, {
        round,
        nextActionHint: `Workflow is ${state.workflow.status}.`,
      });
      printJson({
        action: 'continue-blocked',
        workflowId,
        status: state.workflow.status,
        rounds,
        snapshot,
      });
      return;
    }

    const nextAction = await resolveNextAction(options, workflowId, state);
    const decision = buildDecision(state.workflow, {
      ...nextAction,
      inputs: {
        ...(nextAction.inputs || {}),
        loopRound: round,
      },
    });
    const terminalActionResult = await executeContinueDecision(options, state, decision);
    rounds.push({
      round,
      decision: decision.action,
      guard: terminalActionResult?.guard,
      action: terminalActionResult?.action,
    });

    const nextState = await readWorkflow(options, workflowId).catch(() => state);
    await refreshMainSnapshot(options, nextState, {
      round,
      latestDecision: decision,
      nextActionHint: instructionForDecision(decision, nextState),
    });

    if (terminalActionResult?.directOutput) {
      printJson({
        ...terminalActionResult.directOutput,
        loopRound: round,
        loopMaxRounds: maxRounds,
      });
      return;
    }
    if (terminalActionResult?.guard?.accepted === false && stopOn.has('guard_rejected')) {
      printJson({
        action: 'continue-blocked',
        workflowId,
        decision,
        guard: terminalActionResult.guard,
        rounds,
      });
      return;
    }
    if (decision.action === 'complete_workflow' || nextState.workflow?.status === 'completed') {
      printJson({
        action: 'continue',
        workflowId,
        status: 'completed',
        rounds,
      });
      return;
    }
  }

  printJson({
    action: 'continue-blocked',
    workflowId,
    status: 'blocked',
    pauseReason: 'max_rounds_reached',
    rounds,
    maxRounds,
  });
}

async function executeContinueDecision(options, state, decision) {
  const workflowId = state.workflow.id;
  if (decision.action === 'request_dynamic_plan') {
    const output = await capturePrintedJson(() => requestPlan(options));
    return { directOutput: output, action: output.action, guard: output.guard };
  }
  if (decision.action === 'draft_contract') {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const recorded = await safeRecordDecision(options, workflowId, decision, state);
    if (recorded.guard?.accepted === false) {
      return continueBlockedOutput(workflowId, decision, state, recorded.guard);
    }
    const output = await capturePrintedJson(() => draftContract({ ...options, subtask: decision.subtaskId }));
    return { action: output.action, guard: recorded.guard };
  }
  if (decision.action === 'accept_contract') {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const recorded = await safeRecordDecision(options, workflowId, decision, state);
    if (recorded.guard?.accepted === false) {
      return continueBlockedOutput(workflowId, decision, state, recorded.guard);
    }
    const contractId = stringOption(options.contract) || stringOption(decision.inputs?.contractId);
    const output = await capturePrintedJson(() => acceptSprintContract({
      ...options,
      subtask: decision.subtaskId,
      contract: contractId,
    }));
    return { action: output.action, guard: recorded.guard };
  }
  if (decision.action === 'validate_subtask') {
    const output = await capturePrintedJson(() => validate({ ...options, subtask: decision.subtaskId }));
    return { directOutput: output, action: output.action, guard: output.guard };
  }
  if (decision.action === 'execute_subtask') {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const output = await capturePrintedJson(() => startBuilder({ ...options, subtask: decision.subtaskId }));
    return {
      directOutput: {
        ...output,
        action: 'continue-instruction',
        decision,
        guard: { accepted: true, code: 'ok' },
        pendingAction: output.action,
        instruction: [
          output.instruction,
          'After the Builder produces code changes, record evidence with execute.',
        ].filter(Boolean).join(' '),
      },
      action: output.action,
      guard: preflight.guard,
    };
  }
  if (decision.action === 'run_codex_evaluator' || decision.action === 're_evaluate') {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const output = await capturePrintedJson(() => startEvaluator({ ...options, subtask: decision.subtaskId }));
    return {
      directOutput: {
        ...output,
        action: 'continue-instruction',
        decision,
        guard: { accepted: true, code: 'ok' },
        pendingAction: output.action,
        instruction: [
          output.instruction,
          'After the Evaluator finishes, record its result with evaluate.',
        ].filter(Boolean).join(' '),
      },
      action: output.action,
      guard: preflight.guard,
    };
  }
  if (decision.action === 'run_final_evaluation') {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const output = await capturePrintedJson(() => startEvaluator({ ...options, subtask: '__final__' }));
    return {
      directOutput: {
        ...output,
        action: 'continue-instruction',
        decision,
        guard: { accepted: true, code: 'ok' },
        pendingAction: output.action,
        instruction: [
          output.instruction,
          'After the final Evaluator finishes, record its result with evaluate --subtask __final__.',
        ].filter(Boolean).join(' '),
      },
      action: output.action,
      guard: preflight.guard,
    };
  }
  if (isQuestionerDecision(decision.action)) {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const output = await capturePrintedJson(() => startQuestioner({
      ...options,
      subtask: decision.action === 'ask_claude_question_final_evidence' ? undefined : decision.subtaskId,
      intent: intentForQuestionerDecision(decision.action),
      contract: stringOption(options.contract) || stringOption(decision.inputs?.contractId),
      evaluation: stringOption(options.evaluation) || stringOption(decision.inputs?.evaluationRunId),
    }));
    return {
      directOutput: {
        ...output,
        action: 'continue-instruction',
        decision,
        guard: { accepted: true, code: 'ok' },
        pendingAction: output.action,
        instruction: [
          output.instruction,
          'Do not wait synchronously for Claude; after Tik records the QuestionerOutputV2 callback, continue the workflow.',
        ].filter(Boolean).join(' '),
      },
      action: output.action,
      guard: preflight.guard,
    };
  }
  if (requiresCurrentCodexSession(decision.action)) {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    return {
      action: 'continue-instruction',
      guard: preflight.guard,
      directOutput: {
        action: preflight.guard?.accepted === false ? 'continue-blocked' : 'continue-instruction',
        workflowId,
        decision,
        guard: preflight.guard,
        instruction: instructionForDecision(decision, state),
      },
    };
  }
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  return {
    action: 'continue',
    guard: recorded.guard,
  };
}

async function resolveNextAction(options, workflowId, state) {
  if (!options.offlineNext) {
    try {
      const response = await readNextAction(options, workflowId, {
        subtaskId: stringOption(options.subtask),
        headSha: stringOption(options.headSha),
      });
      const plannedAction = response.plannedAction || response;
      return {
        action: plannedAction.action,
        subtaskId: plannedAction.subtaskId,
        reason: plannedAction.reason,
        evidenceRefs: plannedAction.evidenceRefs || [],
        inputs: plannedAction.inputs || {},
        phase: plannedAction.phase,
        reasonCode: plannedAction.reasonCode,
        refs: plannedAction.refs || [],
        commandHint: plannedAction.commandHint,
        actionDefinition: plannedAction.actionDefinition,
      };
    } catch (error) {
      if (!options.allowOfflineNextFallback) {
        throw error;
      }
    }
  }
  return decideNextAction(state);
}

async function capturePrintedJson(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = function patchedWrite(chunk, encoding, callback) {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    if (typeof encoding === 'function') {
      encoding();
    } else if (callback) {
      callback();
    }
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output);
}

function continueBlockedOutput(workflowId, decision, state, guard) {
  return {
    action: 'continue-blocked',
    guard,
    directOutput: {
      action: 'continue-blocked',
      workflowId,
      decision,
      guard,
      instruction: instructionForDecision(decision, state),
    },
  };
}

async function status(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const timeline = await readWorkflowTimeline(options, workflowId);
  printJson({
    action: 'status',
    workflow: state.workflow,
    taskGraphVersion: state.taskGraph?.version,
    subtasks: state.subtasks,
    decisionCount: state.decisions?.length || 0,
    evidenceCount: state.evidence?.length || 0,
    timeline: timeline.map((event) => event.type),
    recentEvents: timeline.slice(-20),
  });
}

function buildDecision(workflow, partial) {
  return {
    id: partial.id || `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    workflowId: workflow.id,
    rootTaskId: workflow.rootTaskId,
    decidedBy: 'codex-workflow',
    decidedAt: new Date().toISOString(),
    evidenceRefs: [],
    ...partial,
  };
}

async function safeRecordDecision(options, workflowId, decision, state) {
  try {
    const currentState = state || await readWorkflow(options, workflowId);
    return await recordDecision(options, workflowId, decision, {
      ifMatch: currentState.workflow?.lastDecisionId,
    });
  } catch (error) {
    if (error?.status === 409 && error.payload?.guard) {
      return error.payload;
    }
    throw error;
  }
}

async function safePreflightDecision(options, workflowId, decision, state) {
  const currentState = state || await readWorkflow(options, workflowId);
  return preflightDecision(options, workflowId, decision, {
    ifMatch: currentState.workflow?.lastDecisionId,
  });
}

async function safeValidateEvaluationReadonly(options, workflowId, subtaskId, evaluationRunId, input) {
  try {
    return await validateEvaluationReadonly(options, workflowId, subtaskId, evaluationRunId, input);
  } catch (error) {
    if (error?.status === 409 && error.payload?.guard) {
      return error.payload;
    }
    throw error;
  }
}

function inferValidationCommand(state, subtaskId) {
  const subtask = findSubtask(state.taskGraph, subtaskId);
  return subtask?.validationCommands?.[0];
}

function inferEvaluationCommand(state, subtaskId) {
  if (subtaskId === '__final__') {
    return state.taskGraph?.finalValidationCommands?.[0];
  }
  const contract = latestAcceptedContract(state, subtaskId);
  return contract?.verificationPlan?.commands?.find((command) => command.required)?.command
    || contract?.verificationPlan?.commands?.[0]?.command
    || inferValidationCommand(state, subtaskId);
}

function evaluationCommandsFromOptions(options, state, subtaskId) {
  if (options.command) {
    return Array.isArray(options.command) ? options.command.map(String) : [String(options.command)];
  }
  if (options.inferCommand === 'false') {
    return [];
  }
  const command = inferEvaluationCommand(state, subtaskId);
  return command ? [command] : [];
}

function evaluationCommandResults(commandResults) {
  return (commandResults || []).filter((result) => !isSetupCommandResult(result));
}

function isSetupCommandResult(result) {
  return result.commandId?.startsWith('cmd-evaluate-setup-');
}

function hasEvaluationCommandResult(commandResults) {
  return evaluationCommandResults(commandResults).length > 0;
}

function latestContractId(state, subtaskId) {
  return latestAcceptedContract(state, subtaskId)?.id || latestContract(state, subtaskId)?.id;
}

function latestEvaluationId(state, subtaskId) {
  return latestEvaluation(state, subtaskId)?.id;
}

function latestEvaluation(state, subtaskId) {
  return (state.evaluationRuns || [])
    .filter((run) => run.subtaskId === subtaskId)
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))[0];
}

function latestQuestionerOutputId(state, subtaskId, intent) {
  return (state.questionerOutputs || [])
    .filter((output) => output.subtaskId === subtaskId && output.intent === intent)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0]?.id;
}

function loopMaxRounds(workflow, options) {
  return numberOption(options.maxRounds, workflow?.policy?.loopContract?.budget?.maxRounds || workflow?.maxRounds || 3);
}

function requiresCurrentCodexSession(action) {
  return [
    'fix_evaluation_findings',
    'request_human_review',
  ].includes(action);
}

function isQuestionerDecision(action) {
  return [
    'ask_claude_question_contract',
    'ask_claude_question_evaluation',
    'ask_claude_question_final_evidence',
  ].includes(action);
}

function intentForQuestionerDecision(action) {
  switch (action) {
    case 'ask_claude_question_contract':
      return 'question_contract';
    case 'ask_claude_question_final_evidence':
      return 'question_final_evidence';
    case 'ask_claude_question_evaluation':
      return 'question_evaluation';
    default:
      throw new Error(`Unsupported Questioner decision: ${action}`);
  }
}

async function refreshMainSnapshot(options, state, input = {}) {
  const workflowId = state.workflow?.id;
  if (!workflowId) {
    return null;
  }
  const snapshot = buildMainSnapshot(state, input);
  let current = null;
  try {
    current = await readContextSnapshot(options, workflowId, 'main');
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
  }
  try {
    const saved = await saveContextSnapshot(options, workflowId, snapshot, {
      ifMatch: current?.snapshot?.etag,
    });
    await mirrorLocalSnapshot(options, workflowId, 'main', saved.snapshot?.renderedMarkdown);
    return saved.snapshot;
  } catch (error) {
    if (error?.status === 404 || error?.status === 409) {
      return null;
    }
    throw error;
  }
}

function buildMainSnapshot(state, input = {}) {
  const workflow = state.workflow;
  const activeSubtaskId = input.latestDecision?.subtaskId || selectActiveSubtaskId(state);
  const activeSubtask = activeSubtaskId ? findSubtask(state.taskGraph, activeSubtaskId) : null;
  const latestImplementation = latestEvidence(state, activeSubtaskId, ['implementation', 'fix']);
  const latestEval = activeSubtaskId ? latestEvaluation(state, activeSubtaskId) : latestEvaluation(state, '__final__');
  const latestQuestioner = activeSubtaskId
    ? latestQuestionerOutput(state, activeSubtaskId, 'question_evaluation')
    : latestQuestionerOutput(state, undefined, 'question_final_evidence');
  const artifactRefs = Array.from(new Set([
    ...(state.evidence || []).slice(-5).map((item) => item.artifactRef || item.id).filter(Boolean),
    ...(latestEval?.artifactRefs || []),
  ]));
  return {
    workflowId: workflow.id,
    headSha: workflow.currentHeadSha || '',
    activeSubtaskId,
    target: 'main',
    objectiveSummary: workflow.goal || '',
    completedSubtasks: Object.values(state.subtasks || {})
      .filter((subtask) => subtask.status === 'done')
      .map((subtask) => subtask.subtaskId),
    currentContractSummary: activeSubtask
      ? [
        `${activeSubtask.id}: ${activeSubtask.title || activeSubtask.goal}`,
        `Allowed paths: ${(activeSubtask.allowedPaths || []).join(', ') || 'none'}`,
        `Blocked paths: ${(activeSubtask.blockedPaths || []).join(', ') || 'none'}`,
      ].join('\n')
      : undefined,
    latestImplementationSummary: latestImplementation?.summary || latestImplementation?.title,
    latestEvaluationSummary: latestEval?.result
      ? `${latestEval.result.verdict} (${latestEval.status})`
      : latestEval?.status,
    latestQuestionerSummary: latestQuestioner
      ? `${latestQuestioner.verdict} (${latestQuestioner.intent})`
      : undefined,
    unresolvedBlockers: collectUnresolvedBlockers(state),
    nextActionHint: input.nextActionHint,
    artifactRefs,
    maxChars: workflow.policy?.snapshotMaxChars?.main || 4000,
  };
}

function selectActiveSubtaskId(state) {
  const activeStatuses = new Set([
    'ready',
    'contract_drafting',
    'contract_questioning',
    'contract_accepted',
    'building',
    'executing',
    'implemented',
    'evaluating',
    'evaluation_failed',
    'evaluation_passed',
    'questioning_evidence',
    'needs_fix',
    'fixing',
    'blocked',
    'human_review_required',
  ]);
  const graphOrder = (state.taskGraph?.subtasks || []).map((subtask) => subtask.id);
  return graphOrder.find((subtaskId) => activeStatuses.has(state.subtasks?.[subtaskId]?.status))
    || graphOrder[0];
}

function latestEvidence(state, subtaskId, kinds) {
  return (state.evidence || [])
    .filter((item) => (!subtaskId || item.subtaskId === subtaskId) && kinds.includes(item.kind))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
}

function latestQuestionerOutput(state, subtaskId, intent) {
  return (state.questionerOutputs || [])
    .filter((output) => output.subtaskId === subtaskId && output.intent === intent)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
}

function collectUnresolvedBlockers(state) {
  const blockers = Object.values(state.subtasks || {}).flatMap((subtask) => subtask.blockerFindingIds || []);
  const guard = state.workflow?.metadata?.lastGuardRejection || state.workflow?.metadata?.guardRejection;
  if (guard?.message) {
    blockers.push(String(guard.message));
  }
  return blockers;
}

async function mirrorLocalSnapshot(options, workflowId, target, markdown) {
  if (!markdown) {
    return;
  }
  const projectPath = resolveProjectPath(options.path);
  const filePath = path.join(projectPath, '.tik', 'multi-agent', 'workflows', workflowId, 'context', `${target}.snapshot.md`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, 'utf-8');
}

function codexEvaluatorQuestionerPolicy() {
  return {
    requireAcceptedContract: true,
    requireEvaluationPassForComplete: true,
    requireQuestionerAfterEvaluation: true,
    requireSameHeadShaForEvidence: true,
    allowHumanOverride: false,
  };
}

function latestAcceptedContract(state, subtaskId) {
  return (state.contracts || [])
    .filter((contract) => contract.subtaskId === subtaskId && contract.status === 'accepted')
    .sort((left, right) => (right.version || 0) - (left.version || 0) || String(right.acceptedAt || '').localeCompare(String(left.acceptedAt || '')))[0];
}

function latestContract(state, subtaskId) {
  return (state.contracts || [])
    .filter((contract) => contract.subtaskId === subtaskId)
    .sort((left, right) => (right.version || 0) - (left.version || 0) || String(right.acceptedAt || '').localeCompare(String(left.acceptedAt || '')))[0];
}

function buildDefaultContract(state, subtask, headSha) {
  const criteria = (subtask.acceptanceCriteria || []).map((criterion, index) => {
    if (typeof criterion === 'object' && criterion) {
      return {
        id: criterion.id || `ac-${index + 1}`,
        statement: criterion.statement || String(criterion),
        priority: criterion.priority || 'must',
        verificationMethod: criterion.verificationMethod || 'command',
      };
    }
    return {
      id: `ac-${index + 1}`,
      statement: String(criterion),
      priority: 'must',
      verificationMethod: 'command',
    };
  });
  return {
    status: 'draft',
    goal: subtask.goal,
    scope: {
      allowedPaths: subtask.allowedPaths || [],
      blockedPaths: subtask.blockedPaths || [],
    },
    deliverables: [{
      id: `deliver-${subtask.id}`,
      description: subtask.goal || subtask.title,
      expectedFiles: subtask.expectedChangedFiles,
    }],
    acceptanceCriteria: criteria.length ? criteria : [{
      id: 'ac-1',
      statement: `Complete ${subtask.title || subtask.id}.`,
      priority: 'must',
      verificationMethod: 'command',
    }],
    verificationPlan: {
      commands: (subtask.validationCommands || state.taskGraph?.finalValidationCommands || []).map((command, index) => ({
        id: `cmd-${index + 1}`,
        command,
        hardTimeoutMs: 120000,
        required: true,
      })),
    },
    questionerOutputRefs: [],
    headShaAtAcceptance: headSha,
  };
}

function buildDefaultQuestionerOutput(options) {
  const intent = requireOption(options.intent, '--intent is required');
  const blockingQuestions = splitList(options.blockingQuestion) || [];
  const invocationId = requireOption(options.invocation, '--invocation is required for Claude plugin Questioner output');
  const headSha = requireOption(options.headSha, '--head-sha is required for Claude plugin Questioner output');
  const artifactRef = requireOption(options.artifactRef, '--artifact-ref is required for Claude plugin Questioner output');
  const evaluationRunId = (intent === 'question_evaluation' || intent === 'question_final_evidence')
    ? requireOption(options.evaluation, '--evaluation is required for evaluation Questioner output')
    : stringOption(options.evaluation);
  const finalEvaluationRunId = intent === 'question_final_evidence'
    ? evaluationRunId
    : undefined;
  const contractId = (intent === 'question_contract' || intent === 'question_evaluation')
    ? requireOption(options.contract, '--contract is required for contract/evaluation Questioner output')
    : stringOption(options.contract);
  return {
    id: stringOption(options.questionerOutput),
    subtaskId: stringOption(options.subtask),
    intent,
    actor: {
      kind: 'claude-code-questioner',
      invocationId,
    },
    source: 'claude-plugin',
    headSha,
    evaluationRunId: finalEvaluationRunId ? undefined : evaluationRunId,
    finalEvaluationRunId,
    contractId,
    artifactRef,
    verdict: blockingQuestions.length > 0
      ? 'need_clarification'
      : stringOption(options.verdict) || 'evidence_sufficient',
    questions: blockingQuestions.map((question, index) => ({
      id: `q-${index + 1}`,
      priority: 'blocking',
      question,
      whyItMatters: 'Questioner marked this as blocking evidence or contract risk.',
      expectedAnswerType: 'evidence',
    })),
    risks: [],
    missingTests: [],
    suggestedContractChanges: [],
  };
}

function blockingQuestionerQuestions(output) {
  return (output.questions || []).filter((question) =>
    question.priority === 'blocking' || question.priority === 'evidence_needed'
  );
}

function mergeEvidenceRefs(...groups) {
  return Array.from(new Set(groups.flatMap((group) => group || [])));
}

function defaultEvaluatorAllowedPaths() {
  return [
    '.tik/multi-agent/',
    'test-results/',
    'playwright-report/',
    'coverage/',
    '.tmp/evaluation/',
  ];
}

function withoutRef(values, value) {
  return (values || []).filter((entry) => entry !== value);
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function collectSubtaskEvidenceRefs(state) {
  return mergeEvidenceRefs(...Object.values(state.subtasks || {}).map((subtask) => subtask.evidenceRefs || []));
}

function collectAllowedPaths(state) {
  return Array.from(new Set((state.taskGraph?.subtasks || []).flatMap((subtask) => subtask.allowedPaths || [])));
}

function collectSubtaskAllowedPaths(state, subtaskId) {
  return findSubtask(state.taskGraph, subtaskId)?.allowedPaths || [];
}

function collectSubtaskValidationCommands(state, subtaskId) {
  if (subtaskId === '__final__') {
    return state.taskGraph?.finalValidationCommands || [];
  }
  return findSubtask(state.taskGraph, subtaskId)?.validationCommands || [];
}

function deriveObservedChangedFiles(projectPath, state, subtaskId, options) {
  const explicitObserved = splitList(options.observedChangedFiles);
  if (explicitObserved?.length) {
    return explicitObserved;
  }
  const contract = latestAcceptedContract(state, subtaskId);
  const base = contract?.headShaAtAcceptance || state.workflow.currentHeadSha || state.workflow.baseRef;
  const fromGit = base
    ? splitLines(git(projectPath, ['diff', '--name-only', `${base}..HEAD`], { optional: true }))
    : [];
  if (fromGit.length > 0) {
    return fromGit;
  }
  return splitLines(git(projectPath, ['diff', '--name-only'], { optional: true }));
}

function buildImplementationScopeCheck(state, subtaskId, observedChangedFiles) {
  const contract = latestAcceptedContract(state, subtaskId);
  if (!contract) {
    return undefined;
  }
  const allowedPaths = contract.scope?.allowedPaths || [];
  const blockedPaths = contract.scope?.blockedPaths || [];
  const blocked = observedChangedFiles.filter((file) => matchesAnyPath(file, blockedPaths));
  const outside = allowedPaths.length > 0
    ? observedChangedFiles.filter((file) => !matchesAnyPath(file, allowedPaths))
    : [];
  const violations = [
    ...blocked.map((file) => `blocked:${file}`),
    ...outside.map((file) => `outside:${file}`),
  ];
  return {
    allowed: violations.length === 0,
    violations,
  };
}

function matchesAnyPath(filePath, patterns) {
  const normalizedFile = normalizeEvidencePath(filePath);
  return (patterns || []).some((pattern) => {
    const normalizedPattern = normalizeEvidencePath(pattern);
    if (normalizedPattern.includes('*')) {
      return globPathToRegExp(normalizedPattern).test(normalizedFile);
    }
    return normalizedPattern.endsWith('/')
      ? normalizedFile === normalizedPattern.slice(0, -1) || normalizedFile.startsWith(normalizedPattern)
      : normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
  });
}

function normalizeEvidencePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function globPathToRegExp(pattern) {
  const source = pattern
    .split(/(\*\*)/g)
    .map((part) => {
      if (part === '**') return '.*';
      return part
        .split('*')
        .map(escapeRegExp)
        .join('[^/]*');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function buildCriteriaResultsFromCommands(state, subtaskId, commandResults, decisiveCommandResult, coverageGaps) {
  const allCommandsPassed = commandResults.length > 0 && commandResults.every((result) => result.status === 'passed');
  const reproductionSteps = commandResults.length > 0
    ? commandResults.map((result) => result.command)
    : decisiveCommandResult
      ? [decisiveCommandResult.command]
      : undefined;
  const evidenceSummary = decisiveCommandResult?.summary || (
    allCommandsPassed ? 'All evaluator commands passed.' : 'No evaluator command or structured criterion result was provided.'
  );
  if (subtaskId === '__final__') {
    const finalCriteria = (state.taskGraph?.globalAcceptanceCriteria || []).map((statement, index) => ({
      id: `global-ac-${index + 1}`,
      statement,
      priority: 'must',
    }));
    return finalCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: commandResults.length === 0 || coverageGaps.length > 0 ? 'not_tested' : allCommandsPassed ? 'pass' : 'fail',
      evidence: evidenceSummary,
      reproductionSteps,
    }));
  }
  const contract = latestAcceptedContract(state, subtaskId);
  const mustCriteria = contract?.acceptanceCriteria?.filter((criterion) => criterion.priority === 'must') || [];
  if (commandResults.length === 0 || coverageGaps.length > 0) {
    return mustCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'not_tested',
      evidence: 'No evaluator command or structured criterion result was provided.',
    }));
  }
  return mustCriteria.map((criterion) => ({
    criterionId: criterion.id,
    status: allCommandsPassed ? 'pass' : 'fail',
    evidence: evidenceSummary,
    reproductionSteps,
  }));
}

async function runCommandWithArtifacts(input) {
  const hardTimeoutMs = Math.max(1, input.hardTimeoutMs || 120000);
  const idleTimeoutMs = Math.max(0, input.idleTimeoutMs || 0);
  const maxOutputBytes = Math.max(1, input.maxOutputBytes || 20000);
  await mkdir(path.dirname(input.stdoutArtifactPath), { recursive: true });
  await mkdir(path.dirname(input.stderrArtifactPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutStream = createWriteStream(input.stdoutArtifactPath, { encoding: 'utf-8' });
    const stderrStream = createWriteStream(input.stderrArtifactPath, { encoding: 'utf-8' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let idleTimedOut = false;

    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000).unref();
    }, hardTimeoutMs);
    hardTimer.unref();

    let idleTimer;
    const resetIdleTimer = () => {
      if (!idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 5000).unref();
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    resetIdleTimer();

    const collect = (chunk, stream, target) => {
      resetIdleTimer();
      const text = chunk.toString('utf-8');
      stream.write(text);
      if (target === 'stdout') {
        stdout = appendBounded(stdout, text, maxOutputBytes);
      } else {
        stderr = appendBounded(stderr, text, maxOutputBytes);
      }
    };

    child.stdout.on('data', (chunk) => collect(chunk, stdoutStream, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, stderrStream, 'stderr'));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      finishStreams(stdoutStream, stderrStream).finally(() => reject(error));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      const timeout = timedOut || idleTimedOut;
      const status = timeout
        ? 'timeout'
        : code === 0
          ? 'passed'
          : 'failed';
      finishStreams(stdoutStream, stderrStream).then(() => resolve({
        command: input.command,
        status,
        exitCode: code,
        signal,
        stdout,
        stderr,
        stdoutArtifactId: toProjectRelative(input.artifactBasePath || input.cwd, input.stdoutArtifactPath),
        stderrArtifactId: toProjectRelative(input.artifactBasePath || input.cwd, input.stderrArtifactPath),
        summary: timeout
          ? (idleTimedOut ? 'Command timed out after idle timeout.' : 'Command timed out.')
          : code === 0 ? 'Command passed.' : 'Command failed.',
      })).catch(reject);
    });
  });
}

function finishStreams(...streams) {
  return Promise.all(streams.map((stream) => new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  })));
}

function appendBounded(current, chunk, maxBytes) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf-8') <= maxBytes) {
    return next;
  }
  return next.slice(Math.max(0, next.length - maxBytes));
}

function toProjectRelative(projectPath, artifactPath) {
  return path.relative(projectPath, artifactPath).replace(/\\/g, '/');
}

function requireInvocationToken(invocation) {
  if (!invocation?.attestationToken) {
    throw new Error('Tik did not return an attestationToken for this Codex invocation.');
  }
  return invocation.attestationToken;
}

function redactInvocationToken(invocation) {
  if (!invocation || typeof invocation !== 'object') {
    return invocation;
  }
  const { attestationToken: _attestationToken, ...redacted } = invocation;
  return redacted;
}

function buildHookStartPayload(options, role, attestationToken) {
  const actualSubagentThreadId = stringOption(options.actualSubagentThread) || stringOption(options.thread);
  const parentThreadId = stringOption(options.parentThread);
  if (!actualSubagentThreadId && !parentThreadId) {
    return null;
  }
  if (!actualSubagentThreadId || !parentThreadId) {
    throw new Error('--parent-thread and --thread or --actual-subagent-thread are both required for hook-start attestation');
  }
  return omitUndefined({
    attestationToken,
    nonce: stringOption(options.nonce) || randomUUID(),
    parentThreadId,
    actualSubagentThreadId,
    role,
    nonce: requireOption(options.nonce, '--nonce is required for hook-start attestation'),
    startedAt: stringOption(options.subagentStartedAt),
  });
}

async function prepareEvaluatorSandbox(projectPath, headSha, options) {
  if (options.evaluatorSandbox === 'false' || options.sandbox === 'false') {
    return {
      path: projectPath,
      cleanup: async () => {},
      summary: {
        kind: 'main-worktree-audit-only',
        path: projectPath,
      },
    };
  }

  const gitDir = git(projectPath, ['rev-parse', '--git-dir'], { optional: true });
  if (!gitDir) {
    const tempPath = await mkdtemp(path.join(os.tmpdir(), 'tik-evaluator-copy-'));
    await cp(projectPath, tempPath, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`),
    });
    return {
      path: tempPath,
      cleanup: async () => rm(tempPath, { recursive: true, force: true }),
      summary: {
        kind: 'throwaway-copy',
        path: tempPath,
      },
    };
  }

  const tempPath = await mkdtemp(path.join(os.tmpdir(), 'tik-evaluator-worktree-'));
  try {
    git(projectPath, ['worktree', 'add', '--detach', tempPath, headSha || 'HEAD']);
    await overlayCurrentGitChanges(projectPath, tempPath);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    throw error;
  }
  return {
    path: tempPath,
    cleanup: async () => {
      git(projectPath, ['worktree', 'remove', '--force', tempPath], { optional: true });
      await rm(tempPath, { recursive: true, force: true });
    },
    summary: {
      kind: 'throwaway-git-worktree',
      path: tempPath,
      headSha,
    },
  };
}

async function overlayCurrentGitChanges(projectPath, sandboxPath) {
  const diff = git(projectPath, ['diff', '--binary', '--no-ext-diff', 'HEAD'], { optional: true });
  if (diff) {
    const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: sandboxPath,
      input: `${diff}\n`,
      encoding: 'utf-8',
    });
    if (applied.status !== 0) {
      throw new Error(`git apply current diff failed in evaluator sandbox: ${applied.stderr || applied.stdout}`);
    }
  }

  const untracked = git(projectPath, ['ls-files', '--others', '--exclude-standard'], { optional: true });
  for (const relativePath of splitLines(untracked)) {
    const source = path.join(projectPath, relativePath);
    const target = path.join(sandboxPath, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

async function cleanupEvaluatorSandbox(sandbox) {
  if (sandbox?.cleanup) {
    await sandbox.cleanup();
  }
}

function buildReadonlyPolicyFromOptions(options) {
  if (!options.readonly && !options.readonlyViolations && !options.allowedWritePaths && !options.forbiddenWritePaths) {
    return undefined;
  }
  return {
    enforced: options.readonly !== 'false',
    allowedWritePaths: splitList(options.allowedWritePaths),
    forbiddenWritePaths: splitList(options.forbiddenWritePaths),
    violations: splitList(options.readonlyViolations) || [],
  };
}

function splitLines(value) {
  if (!value) return [];
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function readWorkflowTimeline(options, workflowId) {
  try {
    const response = await tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/timeline`);
    return response.events || [];
  } catch (error) {
    if (error?.status === 404) return [];
    throw error;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = appendOptionValue(options[key], value);
      index += 1;
    }
  }
  return options;
}

function requireOption(value, message) {
  if (!value || value === true) {
    throw new Error(message);
  }
  return String(value);
}

function stringOption(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : stringOption(value[value.length - 1]);
  }
  return !value || value === true ? undefined : String(value);
}

function splitList(value) {
  if (!value || value === true) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => String(entry).split(',')).map((item) => item.trim()).filter(Boolean);
}

function absoluteApiUrl(options, route) {
  if (!route) return undefined;
  if (/^https?:\/\//.test(route)) return route;
  const baseUrl = String(options.apiBaseUrl || process.env.TIK_API_BASE_URL || 'http://127.0.0.1:3300/api').replace(/\/$/, '');
  return `${baseUrl}${route.startsWith('/v1/') ? route : route.replace(/^\/api/, '')}`;
}

function appendOptionValue(current, value) {
  if (current === undefined) return value;
  return Array.isArray(current) ? [...current, value] : [current, value];
}

function numberOption(value, fallback) {
  if (value === undefined || value === true || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got ${value}`);
  }
  return parsed;
}

function escapeDoubleQuoted(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

async function readJsonFile(filePath) {
  const resolved = path.resolve(String(filePath));
  return JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(resolved, 'utf-8')));
}

async function writeJsonIfRequested(filePath, value) {
  if (!filePath || filePath === true) return;
  const resolved = path.resolve(String(filePath));
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function printHelp() {
  const script = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.log(`
Usage:
  node ${script} create-task --title <title> --goal <goal> [--path <repo>]
  node ${script} comment-task --task <task-id> --body <text>
  node ${script} transition-task --task <task-id> --to <status>
  node ${script} init --goal <goal> [--path <repo>]
  node ${script} plan --workflow <workflow-id>
  node ${script} accept-plan --workflow <workflow-id> --task-graph <file>
  node ${script} draft-contract --workflow <workflow-id> --subtask <id>
  node ${script} accept-contract --workflow <workflow-id> --subtask <id> --contract <contract-id>
  node ${script} next --workflow <workflow-id>
  node ${script} start-builder --workflow <workflow-id> --subtask <id> --invocation <id> --thread <thread-id>
  node ${script} execute --workflow <workflow-id> --subtask <id> --summary <text> [--changed-files <comma-list>]
  node ${script} start-evaluator --workflow <workflow-id> --subtask <id> --invocation <id> --thread <thread-id>
  node ${script} validate --workflow <workflow-id> --subtask <id> --command <cmd>
  node ${script} evaluate --workflow <workflow-id> --subtask <id> --command <cmd>
  node ${script} start-questioner --workflow <workflow-id> --intent <intent> [--subtask <id>]
  node ${script} complete-questioner --unsafe-legacy --workflow <workflow-id> --invocation <id> --output <file>
  node ${script} import-questioner-output --unsafe-legacy --workflow <workflow-id> --invocation <id> --output <file>
  node ${script} complete-invocation --workflow <workflow-id> --invocation <id> [--status started|completed]
  node ${script} record-questioner --workflow <workflow-id> --intent <intent> [--subtask <id>]
  node ${script} complete-subtask --workflow <workflow-id> --subtask <id>
  node ${script} complete-workflow --workflow <workflow-id>
  node ${script} continue --workflow <workflow-id>
  node ${script} status --workflow <workflow-id>

Options:
  --api-base-url <url>       Tik API base URL. Defaults to TIK_API_BASE_URL or http://127.0.0.1:3300/api
  --api-token <token>        Tik API bearer token. Defaults to TIK_API_TOKEN.
  --path <repo>              Repository/worktree path. Defaults to cwd.
  --workspace-root <path>    Tik workspace root; must match the API server's tik serve --project root.
  --workspace-name <name>    Dashboard/workbench workspace name. Defaults to basename of workspace root.
  --source-path <path>       Source project path for a managed worktree binding.
  --lane <id>                Workspace/worktree lane id. Defaults to codex-multi-agent-workflow.
  --worktree-kind <kind>     Binding kind such as root or git-worktree. Defaults to root.
  --workflow <id>            Workflow id.
  --root-task <id>           Root task id.
  --repo <name>              Repository name.
  --base <ref>               Base ref. Defaults to HEAD~1.
  --head-ref <ref>           Head ref. Defaults to current branch or HEAD.
  --head-sha <sha>           Head sha. Defaults to git rev-parse HEAD.
  --changed-files <list>     Comma-separated changed files for implementation evidence.
  --invocation <id>          Tik AgentInvocation id for a Codex subagent thread.
  --thread <id>              Codex subagent thread/session id.
  --v1                       Enable Codex Evaluator / Claude Questioner gates.
  --max-rounds <n>           Max loop rounds. Defaults to 3.
  --evaluator-artifact-path <path>  Extra evaluator artifact path allowed by readonly policy. Repeat or comma-separate.
  --output <path>            (init only) Write full JSON response to a file.
`);
}

await main();
