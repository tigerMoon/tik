#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideNextAction } from '../lib/loop-gate.mjs';
import { decideAfterReview } from '../lib/review-policy.mjs';
import { findSubtask } from '../lib/task-graph.mjs';
import { buildWorkspaceBinding, git, resolveProjectPath } from '../lib/git.mjs';
import {
  acceptContract,
  createContract,
  createInvocation,
  createTask,
  createEvaluationRun,
  commentTask,
  completeInvocation,
  readTask,
  readWorkflow,
  recordDecision,
  recordEvidence,
  recordEvaluationResult,
  recordQuestionerOutput,
  preflightDecision,
  startInvocation,
  tikFetch,
  transitionTask,
  updateSubtask,
  validateEvaluationReadonly,
} from '../lib/tik-client.mjs';
import { instructionForDecision, printJson } from '../lib/output.mjs';

const EXTERNAL_OWNER_LABEL = 'external-claude-review';

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
      case 'execute':
        await execute(options);
        break;
      case 'start-builder':
        await startBuilder(options);
        break;
      case 'start-evaluator':
        await startEvaluator(options);
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
        await recordQuestioner(options);
        break;
      case 'complete-subtask':
        await completeSubtask(options);
        break;
      case 'complete-workflow':
        await completeWorkflow(options);
        break;
      case 'review':
        await requestReview(options);
        break;
      case 'process-review':
        await processReview(options);
        break;
      case 'final-review':
        await requestFinalReview(options);
        break;
      case 'process-final-review':
        await processFinalReview(options);
        break;
      case 'fix':
        await fix(options);
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
    policy: options.v1 || options.codexEvaluatorQuestioner
      ? codexEvaluatorQuestionerPolicy()
      : undefined,
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
  const recorded = await safeRecordDecision(options, workflowId, decision);
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
  const decision = buildDecision(state.workflow, decideNextAction(state));
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: 'next',
    workflowId,
    decision,
    guard: recorded.guard,
    instruction: instructionForDecision(decision, state),
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
  const headSha = git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const decision = buildDecision(state.workflow, {
    action: 'execute_subtask',
    subtaskId,
    reason: options.summary || 'Codex is about to record implementation evidence.',
    evidenceRefs: [],
    inputs: { currentHeadSha: headSha },
  });
  const preflight = await safePreflightDecision(options, workflowId, decision);
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
  const changedFiles = splitList(options.changedFiles)?.map((file) => ({
    path: file,
    changeType: 'modified',
  }));
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
      builderInvocationId: invocationId,
      builderThreadId: threadId,
    }),
  });
  let invocation = null;
  if (invocationId) {
    invocation = await completeInvocation(options, workflowId, invocationId, {
      status: 'completed',
      threadId,
      headSha,
      evidenceRefs: [evidence.evidence.id],
      result: omitUndefined({
        threadId,
        headSha,
        evidenceRefs: [evidence.evidence.id],
        changedFiles,
      }),
    });
  }
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: 'implemented',
    implementationHeadSha: headSha,
    evidenceRefs: [evidence.evidence.id],
  });
  const finalDecision = {
    ...decision,
    action: 'validate_subtask',
    evidenceRefs: [evidence.evidence.id],
    reason: 'Codex recorded implementation evidence; validation is next.',
  };
  const recorded = await safeRecordDecision(options, workflowId, finalDecision);
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
  const started = await startInvocation(options, workflowId, invocation.invocation.id);
  printJson({
    action: 'builder-started',
    workflowId,
    subtaskId,
    invocation: started.invocation,
    instruction: 'Run the Builder in a dedicated Codex subagent thread, then call execute with --invocation and --thread.',
  });
}

async function startEvaluator(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
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
    allowedPaths: [
      '.tik/multi-agent/',
      'test-results/',
      'playwright-report/',
      'coverage/',
      '.tmp/evaluation/',
    ],
    validationCommands: collectSubtaskValidationCommands(state, subtaskId),
    threadId: stringOption(options.thread),
    headSha,
    readonlyPolicy: {
      enforced: true,
      violations: [],
    },
  });
  const started = await startInvocation(options, workflowId, invocation.invocation.id);
  printJson({
    action: 'evaluator-started',
    workflowId,
    subtaskId,
    invocation: started.invocation,
    instruction: 'Run the Evaluator in a separate readonly Codex subagent thread, then call evaluate with --invocation and --thread.',
  });
}

async function finishInvocation(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const invocationId = requireOption(options.invocation, '--invocation is required');
  const response = await completeInvocation(options, workflowId, invocationId, {
    status: stringOption(options.status) || 'completed',
    threadId: stringOption(options.thread),
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
  const result = spawnSync(command, {
    cwd: projectPath,
    encoding: 'utf-8',
    shell: true,
  });
  const passed = result.status === 0;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
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
  const preflight = await safePreflightDecision(options, workflowId, preflightDecision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'validation-rejected',
      workflowId,
      subtaskId,
      passed,
      exitCode: result.status,
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
    payload: {
      exitCode: result.status,
      output: output.slice(0, 20_000),
    },
    headSha,
  });
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: passed ? 'validated' : 'validation_failed',
    lastValidatedHeadSha: headSha,
    validationRunIds: [evidence.evidence.id],
    evidenceRefs: [evidence.evidence.id],
  });
  const reviewAction = shouldRequestReReviewAfterValidation(state, subtaskId)
    ? 'request_re_review'
    : 'request_claude_review';
  const decision = buildDecision(state.workflow, {
    action: passed ? reviewAction : 'execute_subtask',
    subtaskId,
    reason: passed
      ? (reviewAction === 'request_re_review'
        ? 'Validation passed after fixing Claude blockers; request Claude re-review through Tik.'
        : 'Validation passed; request Claude review through Tik.')
      : 'Validation failed; current Codex session must inspect and fix.',
    evidenceRefs: mergeEvidenceRefs(state.subtasks?.[subtaskId]?.evidenceRefs, [evidence.evidence.id]),
    inputs: {
      currentHeadSha: headSha,
      validationPassed: passed,
      fixRecorded: reviewAction === 'request_re_review',
    },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: 'validation-recorded',
    workflowId,
    subtaskId,
    passed,
    exitCode: result.status,
    evidence: evidence.evidence,
    subtask: subtask.subtask,
    decision,
    guard: recorded.guard,
  });
  if (!passed && options.failOnValidationError) {
    process.exitCode = result.status || 1;
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
  const command = options.command || inferEvaluationCommand(state, subtaskId);
  let commandResult = null;
  if (command) {
    const result = spawnSync(command, {
      cwd: projectPath,
      encoding: 'utf-8',
      shell: true,
    });
    commandResult = {
      commandId: stringOption(options.commandId) || 'cmd-evaluate',
      command,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      summary: result.status === 0 ? 'Evaluation command passed.' : 'Evaluation command failed.',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  const gitStatusAfter = git(projectPath, ['status', '--porcelain=v1'], { optional: true }) || '';
  const readonly = await safeValidateEvaluationReadonly(options, workflowId, subtaskId, evaluationRun.evaluationRun.id, {
    gitStatusBefore,
    gitStatusAfter,
  });
  const verdict = readonly.guard?.accepted === false
    ? 'fail'
    : commandResult && commandResult.status !== 'passed'
      ? 'fail'
      : 'pass';
  const result = {
    workflowId,
    subtaskId,
    contractId,
    evaluatorRunId: evaluationRun.evaluationRun.id,
    headSha,
    verdict,
    criteriaResults: [],
    commandResults: commandResult
      ? [{
        commandId: commandResult.commandId,
        command: commandResult.command,
        status: commandResult.status,
        exitCode: commandResult.exitCode,
        summary: commandResult.summary,
      }]
      : [],
    runtimeFindings: verdict === 'pass'
      ? []
      : [{
        id: 'evaluation_failed',
        severity: 'blocker',
        title: 'Evaluation failed',
        observed: commandResult?.summary || readonly.guard?.message || 'Evaluation did not pass.',
        expected: 'Evaluation passes without readonly violations.',
        reproductionSteps: command ? [command] : ['Inspect evaluator artifacts and readonly guard output.'],
      }],
    coverageGaps: [],
    confidence: verdict === 'pass' ? 0.85 : 0.25,
  };
  const recorded = await recordEvaluationResult(options, workflowId, subtaskId, evaluationRun.evaluationRun.id, result);
  let invocation = null;
  if (options.invocation) {
    invocation = await completeInvocation(options, workflowId, String(options.invocation), {
      status: verdict === 'pass' ? 'completed' : 'failed',
      threadId: stringOption(options.thread),
      headSha,
      evaluationRunId: evaluationRun.evaluationRun.id,
      readonlyPolicy: {
        enforced: readonly.guard?.accepted !== false,
        violations: recorded.evaluationRun?.readonlyPolicy?.violations || readonly.evaluationRun?.readonlyPolicy?.violations || [],
      },
      result: {
        threadId: stringOption(options.thread),
        headSha,
        evaluationRunId: evaluationRun.evaluationRun.id,
        readonlyPolicy: {
          enforced: readonly.guard?.accepted !== false,
          violations: recorded.evaluationRun?.readonlyPolicy?.violations || readonly.evaluationRun?.readonlyPolicy?.violations || [],
        },
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
    } : undefined,
  });
  if (verdict !== 'pass' && options.failOnValidationError) {
    process.exitCode = commandResult?.exitCode || 1;
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
    await updateSubtask(options, workflowId, output.subtaskId, {
      status: output.questions?.some((question) => question.priority === 'blocking') ? 'needs_fix' : 'questioning_evidence',
      blockerFindingIds: (output.questions || [])
        .filter((question) => question.priority === 'blocking')
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
  const preflight = await safePreflightDecision(options, workflowId, decision);
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
  const recorded = await safeRecordDecision(options, workflowId, decision);
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
  const preflight = await safePreflightDecision(options, workflowId, decision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'workflow-complete-rejected',
      workflowId,
      decision,
      guard: preflight.guard,
    });
    return;
  }
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: 'workflow-completed',
    workflowId,
    decision,
    guard: recorded.guard,
    workflow: recorded.workflow,
  });
}

async function requestReview(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const subtask = findSubtask(state.taskGraph, subtaskId);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD']);
  const headRef = options.headRef || git(projectPath, ['branch', '--show-current'], { optional: true }) || 'HEAD';
  const round = numberOption(options.round, nextReviewRound(state.subtasks?.[subtaskId]));
  const maxRounds = numberOption(options.maxRounds, state.workflow.maxRounds || 3);
  const repo = options.repo || state.workflow.repo || path.basename(projectPath);
  const decision = buildDecision(state.workflow, {
    action: round > 1 ? 'request_re_review' : 'request_claude_review',
    subtaskId,
    reason: 'Codex workflow is about to request a Tik-owned Claude review.',
    evidenceRefs: state.subtasks?.[subtaskId]?.evidenceRefs || [],
    inputs: { round, maxRounds, currentHeadSha: headSha, fixRecorded: round > 1 },
  });
  const preflight = await safePreflightDecision(options, workflowId, decision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'review-rejected',
      workflowId,
      subtaskId,
      round,
      headSha,
      decision,
      guard: preflight.guard,
    });
    return;
  }
  const response = await tikFetch(options, '/v1/agent-loop/worktree-review-rounds', {
    method: 'POST',
    body: {
      rootTaskId: state.workflow.rootTaskId,
      round,
      maxRounds,
      repo,
      title: options.title || `Claude review for ${subtaskId}: ${subtask?.title || state.workflow.goal}`,
      baseRef: options.base || state.workflow.baseRef || 'HEAD~1',
      headRef,
      headSha,
      idempotencyKey: options.idempotencyKey || [
        'multi_agent_claude_review',
        repo,
        workflowId,
        subtaskId,
        headSha,
        `r${round}`,
      ].join(':'),
      labels: mergeLabels(options.label, [EXTERNAL_OWNER_LABEL]),
      allowedScope: splitList(options.allowedScope) || subtask?.allowedPaths,
      acceptanceCriteria: splitList(options.acceptanceCriteria) || subtask?.acceptanceCriteria,
      reviewFocus: splitList(options.reviewFocus) || subtask?.reviewFocus,
      createdBy: 'codex',
      workspaceBinding: state.workflow.workspaceBinding || buildWorkspaceBinding(projectPath, options),
    },
  });
  const taskId = response.task?.id;
  await updateSubtask(options, workflowId, subtaskId, {
      status: 'reviewing',
      lastReviewedHeadSha: headSha,
      reviewRoundIds: taskId ? [taskId] : [],
  });
  const finalDecision = {
    ...decision,
    reviewRoundId: taskId,
    reason: 'Codex workflow requested a Tik-owned Claude review.',
    inputs: { ...decision.inputs, reviewTaskId: taskId },
  };
  const recorded = await safeRecordDecision(options, workflowId, finalDecision);
  let started = null;
  if (options.start) {
    started = await tikFetch(options, `/v1/agent-loop/tasks/${encodeURIComponent(taskId)}/claude-review-runs`, {
      method: 'POST',
    });
  }
  printJson({
    action: 'review-requested',
    workflowId,
    subtaskId,
    taskId,
    shortIdentifier: response.task?.shortIdentifier,
    round,
    headSha,
    decision: finalDecision,
    guard: recorded.guard,
    started,
  });
}

async function processReview(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const taskId = requireOption(options.task, '--task is required');
  const state = await readWorkflow(options, workflowId);
  const task = await readTask(options, taskId);
  const result = task.agentLoop?.reviewResult;
  if (!result) {
    throw new Error(`Task ${taskId} does not have an agentLoop.reviewResult yet.`);
  }
  const validationEvidence = findPassedValidationForReviewedHead(state, subtaskId, result);
  const validationPassed = Boolean(validationEvidence);
  const policy = decideAfterReview({
    workflow: state.workflow,
    subtaskId,
    task,
    result,
    validationPassed,
    validationEvidence,
  });
  const plannedDecision = buildDecision(state.workflow, {
    ...policy,
    reviewRoundId: task.id,
    evidenceRefs: state.subtasks?.[subtaskId]?.evidenceRefs || [],
    inputs: {
      ...(policy.inputs || {}),
      plannedReviewResult: result,
    },
  });
  const preflight = await safePreflightDecision(options, workflowId, plannedDecision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'review-process-rejected',
      workflowId,
      subtaskId,
      reviewTaskId: task.id,
      verdict: result.verdict,
      decision: plannedDecision,
      guard: preflight.guard,
    });
    return;
  }
  const evidence = await recordEvidence(options, workflowId, {
    kind: 'review',
    title: `Claude review ${task.shortIdentifier || task.id}`,
    summary: `${result.verdict} with ${(result.blockingIssues || []).length} blocking issue(s).`,
    subtaskId,
    headSha: result.headShaReviewed,
    payload: {
      taskId: task.id,
      result,
    },
  });
  const decision = buildDecision(state.workflow, {
    ...policy,
    reviewRoundId: task.id,
    evidenceRefs: [...(state.subtasks?.[subtaskId]?.evidenceRefs || []), evidence.evidence.id],
  });
  if (decision.action === 'validate_subtask') {
    await updateSubtask(options, workflowId, subtaskId, {
      status: 'implemented',
      lastReviewedHeadSha: result.headShaReviewed,
      evidenceRefs: [evidence.evidence.id],
      blockerFindingIds: [],
    });
  }
  const recorded = await safeRecordDecision(options, workflowId, decision);
  const blockerFindingIds = (result.blockingIssues || []).map((issue, index) => `${task.id}:blocking:${index + 1}`);
  const fixRound = decision.action === 'fix_claude_blockers'
    ? (state.subtasks?.[subtaskId]?.fixRound || 0) + 1
    : state.subtasks?.[subtaskId]?.fixRound || 0;
  if (decision.action === 'complete_subtask') {
    await updateSubtask(options, workflowId, subtaskId, {
      status: 'review_approved',
      lastReviewedHeadSha: result.headShaReviewed,
      evidenceRefs: [evidence.evidence.id],
      blockerFindingIds: [],
      fixRound,
    });
    await updateSubtask(options, workflowId, subtaskId, {
      status: 'done',
      lastReviewedHeadSha: result.headShaReviewed,
      evidenceRefs: [evidence.evidence.id],
      blockerFindingIds: [],
      fixRound,
    });
  } else if (decision.action !== 'validate_subtask') {
    await updateSubtask(options, workflowId, subtaskId, {
      status: statusForReviewDecision(decision.action),
      lastReviewedHeadSha: result.headShaReviewed,
      evidenceRefs: [evidence.evidence.id],
      blockerFindingIds,
      fixRound,
    });
  }
  printJson({
    action: 'review-processed',
    workflowId,
    subtaskId,
    reviewTaskId: task.id,
    verdict: result.verdict,
    blockingIssueCount: (result.blockingIssues || []).length,
    decision,
    guard: recorded.guard,
    instruction: instructionForDecision(decision, state),
  });
}

async function requestFinalReview(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const headRef = options.headRef || git(projectPath, ['branch', '--show-current'], { optional: true }) || 'HEAD';
  const repo = options.repo || state.workflow.repo || path.basename(projectPath);
  const decision = buildDecision(state.workflow, {
    action: 'request_final_review',
    reason: 'All subtasks are done; Codex workflow is about to request final Claude review.',
    evidenceRefs: collectSubtaskEvidenceRefs(state),
    inputs: {
      currentHeadSha: headSha,
      taskGraphVersion: state.taskGraph?.version,
    },
  });
  const preflight = await safePreflightDecision(options, workflowId, decision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'final-review-rejected',
      workflowId,
      decision,
      guard: preflight.guard,
    });
    return;
  }
  const response = await tikFetch(options, '/v1/agent-loop/worktree-review-rounds', {
    method: 'POST',
    body: {
      rootTaskId: state.workflow.rootTaskId,
      round: 1,
      maxRounds: 1,
      repo,
      title: options.title || `Final Claude review for workflow ${workflowId}: ${state.workflow.goal}`,
      baseRef: options.base || state.workflow.baseRef || 'HEAD~1',
      headRef,
      headSha,
      idempotencyKey: options.idempotencyKey || [
        'multi_agent_final_claude_review',
        repo,
        workflowId,
        headSha,
      ].join(':'),
      labels: mergeLabels(options.label, [EXTERNAL_OWNER_LABEL, 'final-claude-review']),
      allowedScope: collectAllowedPaths(state),
      acceptanceCriteria: state.taskGraph?.globalAcceptanceCriteria || [],
      reviewFocus: ['final workflow integration', 'all subtasks done', 'regression risk'],
      createdBy: 'codex',
      workspaceBinding: state.workflow.workspaceBinding || buildWorkspaceBinding(projectPath, options),
    },
  });
  const taskId = response.task?.id;
  const finalDecision = {
    ...decision,
    reviewRoundId: taskId,
    reason: 'Codex workflow requested final Tik-owned Claude review.',
    inputs: { ...decision.inputs, reviewTaskId: taskId },
  };
  const recorded = await safeRecordDecision(options, workflowId, finalDecision);
  let started = null;
  if (options.start) {
    started = await tikFetch(options, `/v1/agent-loop/tasks/${encodeURIComponent(taskId)}/claude-review-runs`, {
      method: 'POST',
    });
  }
  printJson({
    action: 'final-review-requested',
    workflowId,
    taskId,
    shortIdentifier: response.task?.shortIdentifier,
    headSha,
    decision: finalDecision,
    guard: recorded.guard,
    started,
  });
}

async function processFinalReview(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const taskId = requireOption(options.task, '--task is required');
  const state = await readWorkflow(options, workflowId);
  const task = await readTask(options, taskId);
  const result = task.agentLoop?.reviewResult;
  if (!result) {
    throw new Error(`Task ${taskId} does not have an agentLoop.reviewResult yet.`);
  }
  const approved = result.verdict === 'approve' && (result.blockingIssues || []).length === 0;
  const plannedDecision = buildDecision(state.workflow, {
    action: approved ? 'complete_workflow' : 'request_human_review',
    reviewRoundId: task.id,
    reason: approved
      ? 'Final Claude review approved the workflow.'
      : 'Final Claude review did not approve the workflow.',
    evidenceRefs: [],
    inputs: {
      currentHeadSha: result.headShaReviewed || result.currentHeadSha || state.workflow.currentHeadSha,
      reviewTaskId: task.id,
      finalReviewApproved: approved,
      plannedFinalReviewResult: result,
    },
    risks: (result.blockingIssues || []).map((issue) => issue.title || issue.reason).filter(Boolean),
  });
  const preflight = await safePreflightDecision(options, workflowId, plannedDecision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'final-review-process-rejected',
      workflowId,
      reviewTaskId: task.id,
      verdict: result.verdict,
      blockingIssueCount: (result.blockingIssues || []).length,
      decision: plannedDecision,
      guard: preflight.guard,
    });
    return;
  }
  const evidence = await recordEvidence(options, workflowId, {
    kind: 'review',
    title: `Final Claude review ${task.shortIdentifier || task.id}`,
    summary: `${result.verdict} with ${(result.blockingIssues || []).length} blocking issue(s).`,
    headSha: result.headShaReviewed || result.currentHeadSha || state.workflow.currentHeadSha,
    payload: {
      taskId: task.id,
      final: true,
      result,
    },
  });
  const decision = {
    ...plannedDecision,
    evidenceRefs: [evidence.evidence.id],
    inputs: omitUndefined({
      ...plannedDecision.inputs,
      plannedFinalReviewResult: undefined,
    }),
  };
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: approved ? 'workflow-completed' : 'final-review-needs-human',
    workflowId,
    reviewTaskId: task.id,
    verdict: result.verdict,
    blockingIssueCount: (result.blockingIssues || []).length,
    evidence: evidence.evidence,
    decision,
    guard: recorded.guard,
  });
}

async function fix(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const headSha = git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const preflightDecision = buildDecision(state.workflow, {
    action: 'fix_claude_blockers',
    subtaskId,
    reviewRoundId: stringOption(options.reviewRound),
    reason: 'Codex is about to record a fix for Claude blocking issues.',
    evidenceRefs: state.subtasks?.[subtaskId]?.evidenceRefs || [],
    inputs: { currentHeadSha: headSha },
  });
  const preflight = await safePreflightDecision(options, workflowId, preflightDecision);
  if (!preflight.guard?.accepted) {
    printJson({
      action: 'fix-rejected',
      workflowId,
      subtaskId,
      decision: preflightDecision,
      guard: preflight.guard,
    });
    return;
  }
  await updateSubtask(options, workflowId, subtaskId, { status: 'fixing' });
  const evidence = await recordEvidence(options, workflowId, {
    kind: 'fix',
    title: options.title || `Codex fix for ${subtaskId}`,
    summary: options.summary || 'Codex recorded fix evidence for Claude blockers.',
    subtaskId,
    headSha,
    payload: {
      reviewRoundId: stringOption(options.reviewRound),
    },
  });
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: 'implemented',
    implementationHeadSha: headSha,
    evidenceRefs: [evidence.evidence.id],
  });
  const decision = buildDecision(state.workflow, {
    action: 'validate_subtask',
    subtaskId,
    reviewRoundId: stringOption(options.reviewRound),
    reason: 'Codex recorded a fix for Claude blockers; validation is required before re-review.',
    evidenceRefs: [evidence.evidence.id],
    inputs: { currentHeadSha: headSha, fixRecorded: true },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: 'fix-recorded',
    workflowId,
    subtaskId,
    evidence: evidence.evidence,
    subtask: subtask.subtask,
    decision,
    guard: recorded.guard,
  });
}

async function continueWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const decision = buildDecision(state.workflow, decideNextAction(state));
  if (decision.action === 'request_dynamic_plan') {
    await requestPlan(options);
    return;
  }
  if (decision.action === 'validate_subtask') {
    await validate({ ...options, subtask: decision.subtaskId });
    return;
  }
  if (decision.action === 'request_claude_review' || decision.action === 'request_re_review') {
    await requestReview({ ...options, subtask: decision.subtaskId });
    return;
  }
  if (decision.action === 'request_final_review') {
    await requestFinalReview(options);
    return;
  }
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: 'continue',
    workflowId,
    decision,
    guard: recorded.guard,
    instruction: instructionForDecision(decision, state),
  });
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

async function safeRecordDecision(options, workflowId, decision) {
  try {
    return await recordDecision(options, workflowId, decision);
  } catch (error) {
    if (error?.status === 409 && error.payload?.guard) {
      return error.payload;
    }
    throw error;
  }
}

async function safePreflightDecision(options, workflowId, decision) {
  try {
    return await preflightDecision(options, workflowId, decision);
  } catch (error) {
    if (error?.status === 409 && error.payload?.guard) {
      return error.payload;
    }
    throw error;
  }
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
    version: 1,
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
  return {
    id: stringOption(options.questionerOutput),
    subtaskId: stringOption(options.subtask),
    intent,
    actor: {
      kind: 'claude-code-questioner',
      invocationId: stringOption(options.invocation),
    },
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

function nextReviewRound(subtask) {
  return (subtask?.reviewRoundIds?.length || 0) + 1;
}

function statusForReviewDecision(action) {
  if (action === 'complete_subtask') return 'review_approved';
  if (action === 'fix_claude_blockers') return 'needs_fix';
  if (action === 'request_human_review') return 'human_review_required';
  if (action === 'validate_subtask') return 'implemented';
  if (action === 'request_re_review') return 'reviewing';
  return 'reviewing';
}

function shouldRequestReReviewAfterValidation(state, subtaskId) {
  const subtask = state.subtasks?.[subtaskId];
  if ((subtask?.fixRound || 0) > 0 || (subtask?.reviewRoundIds || []).length > 0) {
    return (state.evidence || []).some((item) => item.subtaskId === subtaskId && item.kind === 'fix');
  }
  return false;
}

function mergeEvidenceRefs(...groups) {
  return Array.from(new Set(groups.flatMap((group) => group || [])));
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

async function readWorkflowTimeline(options, workflowId) {
  try {
    const response = await tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/timeline`);
    return response.events || [];
  } catch (error) {
    if (error?.status === 404) return [];
    throw error;
  }
}

function findPassedValidationForReviewedHead(state, subtaskId, result) {
  const reviewedHeadSha = result?.headShaReviewed || result?.currentHeadSha;
  if (!reviewedHeadSha) return null;
  const subtask = state.subtasks?.[subtaskId];
  const validationRunIds = new Set(subtask?.validationRunIds || []);
  return [...(state.evidence || [])]
    .filter((item) =>
      item.subtaskId === subtaskId
      && item.kind === 'validation'
      && item.passed === true
      && item.headSha === reviewedHeadSha
      && (validationRunIds.size === 0 || validationRunIds.has(item.id))
    )
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    [0] || null;
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
      options[key] = value;
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
  return !value || value === true ? undefined : String(value);
}

function splitList(value) {
  if (!value || value === true) return undefined;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function mergeLabels(value, required) {
  return Array.from(new Set([...(splitList(value) || []), ...required])).sort();
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
  node ${script} complete-invocation --workflow <workflow-id> --invocation <id>
  node ${script} record-questioner --workflow <workflow-id> --intent <intent> [--subtask <id>]
  node ${script} complete-subtask --workflow <workflow-id> --subtask <id>
  node ${script} complete-workflow --workflow <workflow-id>
  node ${script} review --workflow <workflow-id> --subtask <id> [--start]
  node ${script} process-review --workflow <workflow-id> --subtask <id> --task <review-task-id>
  node ${script} final-review --workflow <workflow-id> [--start]
  node ${script} process-final-review --workflow <workflow-id> --task <review-task-id>
  node ${script} fix --workflow <workflow-id> --subtask <id> --review-round <id>
  node ${script} continue --workflow <workflow-id>
  node ${script} status --workflow <workflow-id>

Options:
  --api-base-url <url>       Tik API base URL. Defaults to TIK_API_BASE_URL or http://127.0.0.1:3300/api
  --api-token <token>        Tik API bearer token. Defaults to TIK_API_TOKEN.
  --path <repo>              Repository/worktree path. Defaults to cwd.
  --workspace-root <path>    Tik workspace root.
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
  --round <n>                Review round.
  --max-rounds <n>           Max review rounds. Defaults to 3.
  --output <path>            Write full JSON response to a file.
`);
}

await main();
