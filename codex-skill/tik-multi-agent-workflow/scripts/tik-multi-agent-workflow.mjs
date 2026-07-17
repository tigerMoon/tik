#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideNextAction } from '../lib/loop-gate.mjs';
import { parseLastJsonObject } from '../lib/structured-output.mjs';
import { collectSurefireEvidence } from '../lib/surefire-evidence.mjs';
import { findSubtask } from '../lib/task-graph.mjs';
import { buildWorkspaceBinding, git, resolveProjectPath } from '../lib/git.mjs';
import {
  acceptContracts,
  createContract,
  createTask,
  createEvaluationRun,
  commentTask,
  hookStartInvocation,
  hookStopInvocation,
  launchNativeInvocation,
  launchNativeQuestionerRun,
  linkNativeInvocationResult,
  executeSubtask,
  listWorkflows,
  patchWorkflow,
  readNextAction,
  readTask,
  readWorkflow,
  recordDecision,
  recordEvidence,
  recordEvaluationResult,
  recordReview as recordReviewAction,
  recordQuestionerOutput,
  readContextSnapshot,
  preflightDecision,
  preflightEnvironment,
  runWorkflowAction,
  saveContextSnapshot,
  synthesizeReview as synthesizeReviewAction,
  tikFetch,
  transitionTask,
  updateEvaluationRun,
  updateSubtask,
  validateEvaluationReadonly,
} from '../lib/tik-client.mjs';
import { instructionForDecision, printJson } from '../lib/output.mjs';
import {
  checkCooldown,
  COOLDOWN_EXIT_CODE,
  installCooldownFromResponse,
} from '../lib/cooldown.mjs';

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = parseArgs(args);

  // Default to terse output to keep Codex context small. `--verbose`
  // explicitly restores full bodies. `TIK_OUTPUT_TERSE` env var can force
  // the value (`0` or `1`); an empty-string or unset value defaults to terse.
  const envTerse = process.env.TIK_OUTPUT_TERSE;
  if (options.verbose === true) {
    process.env.TIK_OUTPUT_TERSE = '0';
  } else if (options.terse === true || envTerse === undefined || envTerse === '') {
    process.env.TIK_OUTPUT_TERSE = '1';
  }

  try {
    switch (command) {
      case 'init':
        await initWorkflow(options);
        break;
      case 'preflight':
        await preflightWorkflowEnvironment(options);
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
      case 'accept-contracts':
        await acceptSprintContracts(options);
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
      case 'start-reviewer':
        await startReviewer(options);
        break;
      case 'start-reviewers':
        await startReadyReviewers(options);
        break;
      case 'record-review':
        await recordReadonlyReview(options);
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
      case 'abandon-workflow':
        await abandonWorkflow(options);
        break;
      case 'pause-workflow':
        await pauseWorkflow(options);
        break;
      case 'synthesize-review':
        await synthesizeReadonlyReview(options);
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
  const workflowMode = normalizeWorkflowMode(options.mode);
  const repo = options.repo || path.basename(projectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD']);
  const headRef = options.headRef || git(projectPath, ['branch', '--show-current'], { optional: true }) || 'HEAD';
  // Snapshot files that were already dirty in the worktree before this
  // workflow was created (both unstaged and staged). Contract scope checks
  // later subtract this set so pre-existing edits don't get attributed to
  // the first subtask and trigger worktree_out_of_scope.
  const preexistingChangedFiles = detectPreexistingChangedFiles(projectPath);
  const workspaceBinding = buildWorkspaceBinding(projectPath, options);
  const environment = await runEnvironmentPreflight(options, {
    mode: workflowMode,
    projectPath,
    workspaceBinding,
    headSha,
  });

  // Discover open workflows already bound to this workspace/repo/headRef so we
  // do not create yet another orphan. Callers can force-new via
  // `--no-reuse-if-open` / `--force-new`, or bind explicitly with `--workflow`.
  const forceNew = options.forceNew === true || options.noReuseIfOpen === true;
  const explicitWorkflowId = stringOption(options.workflow);
  const reusableWorkflow = !explicitWorkflowId && !forceNew
    ? await discoverReusableOpenWorkflow(options, {
        workspaceRoot: workspaceBinding?.workspaceRoot,
        effectiveProjectPath: workspaceBinding?.effectiveProjectPath || projectPath,
        repo,
        mode: workflowMode,
        headRef,
        baseRef: options.base || 'HEAD~1',
        goal: requireOption(options.goal, '--goal is required'),
      })
    : null;
  // When callers pass --force-new while a live workflow already exists on the
  // same binding, log a warning (to stderr) so the human sees the orphan-in-
  // -waiting. The CLI still creates the new workflow — we do not overrule the
  // explicit opt-out — but we surface the workflows that should probably be
  // abandoned or paused first.
  if (forceNew && !explicitWorkflowId) {
    const conflicts = await discoverOpenWorkflowsForWarning(options, {
      workspaceRoot: workspaceBinding?.workspaceRoot,
      effectiveProjectPath: workspaceBinding?.effectiveProjectPath || projectPath,
      repo,
      mode: workflowMode,
      headRef,
      baseRef: options.base || 'HEAD~1',
    });
    if (conflicts && conflicts.length > 0) {
      console.error(`[init] --force-new: leaving ${conflicts.length} open workflow(s) on this workspace:`);
      for (const wf of conflicts.slice(0, 5)) {
        console.error(`  - ${wf.id} (status=${wf.status}, updatedAt=${wf.updatedAt}, goal="${(wf.goal || '').slice(0, 60)}")`);
      }
      console.error('  Run `abandon-workflow --workflow <id>` or `pause-workflow --workflow <id>` to clean them up.');
    }
  }
  if (reusableWorkflow?.workflow) {
    printJson({
      action: 'initialized',
      workflowId: reusableWorkflow.workflow.id,
      rootTaskId: reusableWorkflow.workflow.rootTaskId,
      status: reusableWorkflow.workflow.status,
      driver: reusableWorkflow.workflow.driver,
      headSha: reusableWorkflow.workflow.currentHeadSha,
      policy: reusableWorkflow.workflow.policy,
      preexistingChangedFiles,
      mode: 'v1',
      workflowMode,
      reusedWorkflow: true,
      discoveredCandidates: reusableWorkflow.candidateCount,
      hint: 'Reused an existing open workflow bound to this workspace. Pass --force-new to create a fresh workflow instead.',
      nextCommand: `node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs next --workflow ${reusableWorkflow.workflow.id}`,
    });
    return;
  }

  const body = {
    id: explicitWorkflowId,
    goal: requireOption(options.goal, '--goal is required'),
    mode: workflowMode,
    rootTaskId: stringOption(options.rootTask) || explicitWorkflowId,
    repo,
    baseRef: options.base || 'HEAD~1',
    headRef,
    headSha,
    maxRounds: numberOption(options.maxRounds, 3),
    workspaceBinding,
    metadata: omitUndefined({
      parentCodexThreadId: stringOption(options.parentThread),
      preexistingChangedFiles: preexistingChangedFiles.length > 0 ? preexistingChangedFiles : undefined,
    }),
    policy: codexEvaluatorQuestionerPolicy(workflowMode),
  };
  const response = await tikFetch(options, '/v1/multi-agent/workflows', {
    method: 'POST',
    body,
  });
  let reviewTaskGraph;
  if (workflowMode === 'review') {
    reviewTaskGraph = buildDeterministicReviewTaskGraph({
      workflowId: response.workflow?.id,
      projectPath,
      baseRef: body.baseRef,
      headSha,
    });
    await tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(response.workflow?.id)}/task-graph`, {
      method: 'PUT',
      body: { graph: reviewTaskGraph },
    });
  }
  await writeJsonIfRequested(options.output, { ...response, environmentPreflight: environment.report, reviewTaskGraph });
  printJson({
    action: 'initialized',
    workflowId: response.workflow?.id,
    rootTaskId: response.workflow?.rootTaskId,
    status: response.workflow?.status,
    driver: response.workflow?.driver,
    headSha: response.workflow?.currentHeadSha,
    policy: response.workflow?.policy,
    preexistingChangedFiles,
    mode: 'v1',
    workflowMode,
    reusedWorkflow: false,
    discoveredCandidates: 0,
    environmentPreflight: environment.report,
    reviewTaskGraph,
    breakingChange: 'v1.1 removed legacy multi-agent Claude review commands; use the contract/evaluator/questioner loop.',
    nextCommand: `node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs next --workflow ${response.workflow?.id}`,
  });
}

/**
 * Fetch open workflows for the same workspace binding without any error paths
 * — used by --force-new callers to surface a warning about the orphans they
 * are about to leave behind. Never throws; failure returns an empty array.
 */
async function discoverOpenWorkflowsForWarning(options, filter) {
  try {
    const payload = await listWorkflows(options, {
      status: 'open',
      workspaceRoot: filter.workspaceRoot,
      effectiveProjectPath: filter.effectiveProjectPath,
      repo: filter.repo,
      mode: filter.mode,
      headRef: filter.headRef,
      baseRef: filter.baseRef,
    });
    const all = Array.isArray(payload?.workflows) ? payload.workflows : [];
    return all.filter((wf) => !wf?.metadata?.staleAt && !wf?.metadata?.pausedAt);
  } catch {
    return [];
  }
}

/**
 * Look for an already-open workflow bound to the same workspace/repo/baseRef/
 * headRef so `init` does not silently create another orphan. Rejects reuse
 * when the candidate's `goal` differs from the caller's — otherwise a fresh
 * `--goal` gets silently rebound to yesterday's workflow, and every later
 * evaluator/questioner run is pinned to the wrong scope.
 *
 * Returns null when there are no candidates or when the sole candidate has a
 * goal mismatch (caller should either pass `--workflow <id>` to reuse
 * intentionally, or `--force-new` to explicitly create a fresh workflow).
 * Throws `ambiguous_open_workflows` when multiple live non-stale candidates
 * match.
 */
async function discoverReusableOpenWorkflow(options, filter) {
  try {
    const payload = await listWorkflows(options, {
      status: 'open',
      workspaceRoot: filter.workspaceRoot,
      effectiveProjectPath: filter.effectiveProjectPath,
      repo: filter.repo,
      mode: filter.mode,
      headRef: filter.headRef,
      baseRef: filter.baseRef,
    });
    const all = Array.isArray(payload?.workflows) ? payload.workflows : [];
    const live = all.filter((wf) => !wf?.metadata?.staleAt && !wf?.metadata?.pausedAt);
    if (live.length === 1) {
      const candidate = live[0];
      // Guard rail: don't silently rebind a fresh --goal to an existing
      // workflow with a different goal. The caller must either pass
      // --workflow <id> to reuse intentionally, or --force-new to create.
      if (filter.goal && candidate.goal && normalizeGoal(candidate.goal) !== normalizeGoal(filter.goal)) {
        const err = new Error(
          `Open workflow ${candidate.id} exists but its goal ("${candidate.goal}") differs from the requested --goal ("${filter.goal}"); pass --workflow ${candidate.id} to reuse or --force-new to create a fresh workflow.`,
        );
        err.payload = {
          error: {
            code: 'goal_mismatch',
            message: err.message,
            candidate: {
              id: candidate.id,
              goal: candidate.goal,
              status: candidate.status,
              updatedAt: candidate.updatedAt,
              headRef: candidate.headRef,
              baseRef: candidate.baseRef,
            },
            requestedGoal: filter.goal,
          },
        };
        throw err;
      }
      return { workflow: candidate, candidateCount: all.length };
    }
    if (live.length > 1) {
      const error = new Error(
        `Multiple open workflows match this workspace; pass --workflow <id> to reuse a specific one, or --force-new to create a new workflow.`,
      );
      error.payload = {
        error: {
          code: 'ambiguous_open_workflows',
          message: error.message,
          candidates: live.map((wf) => ({
            id: wf.id,
            goal: wf.goal,
            status: wf.status,
            updatedAt: wf.updatedAt,
            headRef: wf.headRef,
            baseRef: wf.baseRef,
          })),
        },
      };
      throw error;
    }
    return null;
  } catch (error) {
    // If the server is running an older kernel that doesn't accept filters,
    // treat discovery as best-effort and fall through to create-new. Locally
    // thrown ambiguity / goal-mismatch errors do NOT have a numeric .status,
    // so they propagate correctly.
    if (error?.status === 400 || error?.status === 404) return null;
    throw error;
  }
}

function normalizeGoal(goal) {
  return String(goal || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function preflightWorkflowEnvironment(options) {
  const projectPath = resolveProjectPath(options.path);
  const mode = normalizeWorkflowMode(options.mode);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD']);
  const response = await runEnvironmentPreflight(options, {
    mode,
    projectPath,
    workspaceBinding: buildWorkspaceBinding(projectPath, options),
    headSha,
  });
  printJson({ action: 'preflight-complete', report: response.report });
}

function detectPreexistingChangedFiles(projectPath) {
  const unstaged = splitLines(git(projectPath, ['diff', '--name-only'], { optional: true }));
  const staged = splitLines(git(projectPath, ['diff', '--name-only', '--cached'], { optional: true }));
  return Array.from(new Set([...unstaged, ...staged].map(normalizeEvidencePath).filter(Boolean)));
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
  const cooldown = await checkCooldown(workflowId, options);
  if (cooldown.blocked) {
    printJson(cooldown.snapshot);
    process.exit(COOLDOWN_EXIT_CODE);
  }
  const state = await readWorkflow(options, workflowId);
  const nextAction = await resolveNextAction(options, workflowId, state);
  const decision = buildDecision(state.workflow, nextAction);
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  if (nextAction.reasonCode === 'awaiting_native_runtime') {
    await installCooldownFromResponse(workflowId, nextAction);
  }
  printJson({
    action: 'next',
    workflowId,
    plannedAction: nextAction,
    decision,
    guard: recorded.guard,
    commandHint: nextAction.commandHint,
    instruction: instructionForDecision(decision, state),
    retryAfterMs: nextAction.retryAfterMs,
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
    runtime: response.runtime,
    guard: response.guard,
    instruction: response.runtime
      ? 'Tik launched Claude Questioner and retained the token-scoped runtime credentials server-side.'
      : response.token
        ? 'Launch the explicit manual Questioner fallback with the printed TIK_QUESTIONER_* values.'
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
  if (state.workflow.mode === 'review') {
    throw new Error('Review workflows do not use SprintContracts.');
  }
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
  if (state.workflow.mode === 'review') {
    throw new Error('Review workflows do not accept SprintContracts.');
  }
  const headSha = options.headSha || state.workflow.currentHeadSha || git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true });
  const response = await acceptContracts(options, workflowId, [{
    subtaskId,
    contractId,
    acceptedBy: 'codex-workflow-plugin',
    headShaAtAcceptance: headSha,
    questionerOutputRefs: splitList(options.questionerOutputRefs) || [],
  }], { ifMatch: String(state.workflow.revision ?? 0) });
  printJson({
    action: 'contract-accepted',
    workflowId,
    subtaskId,
    contract: response.contracts?.[0],
    decision: response.decisions?.[0],
    subtask: response.subtasks?.[0],
    nextRecommendedCommand: response.nextRecommendedCommand || [],
  });
}

async function acceptSprintContracts(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const inputPath = requireOption(options.items || options.contracts, '--items <json-file> is required');
  const state = await readWorkflow(options, workflowId);
  if (state.workflow.mode === 'review') throw new Error('Review workflows do not accept SprintContracts.');
  const parsed = await readJsonFile(inputPath);
  const contracts = Array.isArray(parsed) ? parsed : parsed.contracts;
  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new Error('Batch Contract input must be a non-empty JSON array or {"contracts": [...]} object.');
  }
  const response = await acceptContracts(options, workflowId, contracts, {
    ifMatch: String(state.workflow.revision ?? 0),
  });
  printJson({
    action: 'contracts-accepted',
    workflowId,
    count: response.contracts?.length || 0,
    contracts: response.contracts,
    decisions: response.decisions,
    subtasks: response.subtasks,
    workflow: response.workflow,
    nextRecommendedCommand: response.nextRecommendedCommand || [],
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
  if (state.workflow.mode === 'review') {
    throw new Error('Review workflows cannot execute Builder subtasks. Use start-reviewer and record-review.');
  }
  const invocationId = requireOption(options.invocation, '--invocation is required to record attested implementation evidence');
  const nativeInvocation = isCompletedNativeInvocation(state, invocationId);
  const attestationToken = nativeInvocation
    ? stringOption(options.attestationToken)
    : requireOption(options.attestationToken, '--attestation-token is required for a hook-launched Codex Builder invocation');
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
  const threadId = stringOption(options.thread);
  const evidenceId = stringOption(options.evidenceId) || `ev_${randomUUID().replace(/-/g, '')}`;
  const evidenceInput = {
    id: evidenceId,
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
  };
  const finalDecision = {
    ...decision,
    action: 'record_implementation',
    evidenceRefs: mergeEvidenceRefs(existingEvidenceRefs, [evidenceId]),
    reason: 'Codex recorded attested implementation evidence; validation is next.',
  };
  const response = await executeSubtask(options, workflowId, {
    decision: finalDecision,
    evidence: evidenceInput,
    invocation: {
      id: invocationId,
      attestationToken,
      status: 'completed',
      headSha,
      evidenceRefs: [evidenceId],
      result: omitUndefined({
        threadId,
        headSha,
        evidenceRefs: [evidenceId],
        changedFiles,
        declaredChangedFiles,
        observedChangedFiles,
        scopeCheck,
      }),
    },
  }, { ifMatch: state.workflow.lastDecisionId || 'none' });
  printJson({
    action: 'execution-recorded',
    workflowId,
    subtaskId,
    evidence: response.evidence,
    invocation: response.invocation,
    subtask: response.subtask,
    decision: response.decision,
    guard: response.guard,
    nextRecommendedCommand: response.nextRecommendedCommand || [],
  });
}

async function startBuilder(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  if (state.workflow.mode === 'review') {
    throw new Error('Review workflows do not start Builder invocations. Use start-reviewer.');
  }
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const contractId = latestContractId(state, subtaskId);
  const launched = await launchNativeInvocation(options, workflowId, {
    id: stringOption(options.invocation) || stableNativeId('builder', workflowId, subtaskId, headSha, contractId),
    subtaskId,
    role: 'executor',
    runner: 'codex',
    promptContract: stringOption(options.promptContract) || 'codex-builder.v1',
    input: {
      goal: state.workflow.goal,
      subtaskId,
      contractId,
      currentHeadSha: headSha,
    },
    allowedPaths: collectSubtaskAllowedPaths(state, subtaskId),
    validationCommands: collectSubtaskValidationCommands(state, subtaskId),
    parentThreadId: stringOption(options.parentThread) || state.workflow.metadata?.parentCodexThreadId,
    headSha,
    prompt: stringOption(options.prompt),
    timeoutMs: numberOption(options.timeoutMs, undefined),
  });
  const reused = Boolean(launched.reused || launched.runtime?.reused);
  if (reused) {
    printJson({
      action: 'builder-reused',
      workflowId,
      subtaskId,
      invocation: launched.invocation,
      runtime: launched.runtime,
      reused: true,
      hint: 'Builder for this subtask is already running or completed; do not launch again. Poll with `status` / `next` (subject to cooldown), or record evidence with `execute` when the run finishes.',
    });
    return;
  }
  printJson({
    action: 'builder-started',
    workflowId,
    subtaskId,
    invocation: launched.invocation,
    runtime: launched.runtime,
    reused: false,
    instruction: 'Tik launched the Codex Builder native thread and retained attestation credentials server-side.',
  });
}

async function startReviewer(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const launched = await launchReviewerForState(options, state, subtaskId);
  const reused = Boolean(launched.reused || launched.runtime?.reused);
  if (reused) {
    printJson({
      action: 'reviewer-reused',
      workflowId,
      subtaskId,
      invocation: launched.invocation,
      runtime: launched.runtime,
      reused: true,
      hint: 'Reviewer for this shard is already running or completed; do not launch again. Wait for `record-review` evidence.',
    });
    return;
  }
  printJson({
    action: 'reviewer-started',
    workflowId,
    subtaskId,
    invocation: launched.invocation,
    runtime: launched.runtime,
    reused: false,
    instruction: 'Tik launched the readonly Codex Reviewer native thread and retained attestation credentials server-side.',
  });
}

async function launchReviewerForState(options, state, subtaskId) {
  const workflowId = state.workflow.id;
  if (state.workflow.mode !== 'review') throw new Error('start-reviewer requires a workflow created with --mode review');
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const launched = await launchNativeInvocation(options, workflowId, {
    id: stringOption(options.invocation) || stableNativeId('reviewer', workflowId, subtaskId, headSha),
    subtaskId,
    role: 'reviewer',
    runner: 'codex-evaluator',
    promptContract: stringOption(options.promptContract) || 'codex-reviewer.v1',
    input: {
      goal: state.workflow.goal,
      subtaskId,
      currentHeadSha: headSha,
      readonly: true,
      reviewScope: collectSubtaskAllowedPaths(state, subtaskId),
      reviewFocus: findSubtask(state.taskGraph, subtaskId)?.reviewFocus || [],
    },
    allowedPaths: collectSubtaskAllowedPaths(state, subtaskId),
    validationCommands: [],
    parentThreadId: stringOption(options.parentThread) || state.workflow.metadata?.parentCodexThreadId,
    headSha,
    readonlyPolicy: {
      enforced: true,
      allowedWritePaths: defaultEvaluatorAllowedPaths(),
      forbiddenWritePaths: ['**/*'],
      violations: [],
    },
    prompt: stringOption(options.prompt),
    timeoutMs: numberOption(options.timeoutMs, undefined),
  });
  return launched;
}

async function startReadyReviewers(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  if (state.workflow.mode !== 'review') throw new Error('start-reviewers requires a workflow created with --mode review');
  const maxConcurrency = Math.max(1, Math.min(16, numberOption(options.maxConcurrency, 4)));
  const candidates = (state.taskGraph?.subtasks || [])
    .filter((subtask) => subtask.kind === 'review')
    .filter((subtask) => !latestEvidence(state, subtask.id, ['review']))
    .filter((subtask) => !(state.invocations || []).some((invocation) =>
      invocation.subtaskId === subtask.id
      && invocation.role === 'reviewer'
      && (invocation.status === 'created' || invocation.status === 'started')
    ))
    .slice(0, maxConcurrency);
  const launched = await Promise.all(candidates.map(async (subtask) => ({
    subtaskId: subtask.id,
    ...(await launchReviewerForState(options, state, subtask.id)),
  })));
  printJson({
    action: 'reviewers-started',
    workflowId,
    count: launched.length,
    reviewers: launched.map((item) => ({
      subtaskId: item.subtaskId,
      invocation: item.invocation,
      runtime: item.runtime,
    })),
    instruction: launched.length > 0
      ? 'Tik launched all ready readonly Reviewer shards up to the concurrency limit.'
      : 'No review shard is ready for launch.',
  });
}

async function recordReadonlyReview(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const invocationId = requireOption(options.invocation, '--invocation is required to record attested review evidence');
  const state = await readWorkflow(options, workflowId);
  const nativeInvocation = isCompletedNativeInvocation(state, invocationId);
  const attestationToken = nativeInvocation
    ? stringOption(options.attestationToken)
    : requireOption(options.attestationToken, '--attestation-token is required for a hook-launched readonly Reviewer invocation');
  if (state.workflow.mode !== 'review') throw new Error('record-review requires a workflow created with --mode review');
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const structuredResult = options.resultJson
    ? JSON.parse(String(options.resultJson))
    : options.result
      ? await readJsonFile(options.result)
      : nativeInvocationStructuredResult(state, invocationId, 'reviewer');
  if (!structuredResult || typeof structuredResult !== 'object' || Array.isArray(structuredResult)) {
    throw new Error(`Native Reviewer ${invocationId} did not return a structured review result.`);
  }
  if (!Array.isArray(structuredResult.findings) && !Array.isArray(structuredResult.blockingIssues)) {
    throw new Error(`Native Reviewer ${invocationId} result must contain a findings array.`);
  }
  const evidenceId = stringOption(options.evidenceId) || `ev_review_${randomUUID().replace(/-/g, '')}`;
  const evidence = {
    id: evidenceId,
    kind: 'review',
    title: stringOption(options.title) || `Readonly review candidates for ${subtaskId}`,
    summary: stringOption(options.summary) || structuredResult.markdown || 'Readonly reviewer recorded candidate findings.',
    subtaskId,
    headSha,
    artifactRef: stringOption(options.artifact),
    payload: {
      reviewResult: structuredResult,
      findings: structuredResult.findings || structuredResult.blockingIssues || [],
      reviewScope: collectSubtaskAllowedPaths(state, subtaskId),
    },
  };
  const decision = buildDecision(state.workflow, {
    action: 'record_review',
    subtaskId,
    reason: evidence.summary,
    evidenceRefs: [evidenceId],
    inputs: { currentHeadSha: headSha },
  });
  const response = await recordReviewAction(options, workflowId, {
    decision,
    evidence,
    invocation: {
      id: invocationId,
      attestationToken,
      status: 'completed',
      headSha,
      evidenceRefs: [evidenceId],
      readonlyPolicy: {
        enforced: true,
        allowedWritePaths: defaultEvaluatorAllowedPaths(),
        forbiddenWritePaths: ['**/*'],
        violations: splitList(options.readonlyViolation) || [],
      },
      result: { headSha, evidenceRefs: [evidenceId], reviewResult: structuredResult },
    },
  }, { ifMatch: state.workflow.lastDecisionId || 'none' });
  printJson({
    action: 'review-recorded',
    workflowId,
    subtaskId,
    ...response,
    nextRecommendedCommand: response.nextRecommendedCommand || [],
  });
}

async function startEvaluator(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const evaluatorAllowedPaths = mergeEvidenceRefs(defaultEvaluatorAllowedPaths(), splitList(options.evaluatorArtifactPath));
  const semanticCacheKey = evaluationSemanticCacheKey(state, subtaskId, headSha, projectPath, options);
  const reusableSemantic = findReusableSemanticEvaluation(state, subtaskId, semanticCacheKey);
  if (reusableSemantic) {
    printJson({
      action: 'evaluator-semantic-reused',
      workflowId,
      subtaskId,
      semanticCacheKey,
      sourceEvaluationRunId: reusableSemantic.id,
      runtime: { status: 'completed', reused: true },
      instruction: 'Semantic inputs are unchanged; run evaluate to resume at validation_commands without launching another LLM.',
    });
    return;
  }
  const reviewEvidence = state.workflow.mode === 'review' ? latestEvidence(state, subtaskId, ['review']) : undefined;
  if (state.workflow.mode === 'review' && !reviewEvidence) {
    throw new Error(`Review evaluator requires recorded review evidence for ${subtaskId}.`);
  }
  const launched = await launchNativeInvocation(options, workflowId, {
    id: stringOption(options.invocation) || stableNativeId(
      'evaluator',
      workflowId,
      subtaskId,
      headSha,
      latestEvaluationId(state, subtaskId) || reviewEvidence?.id || latestEvidence(state, subtaskId, ['implementation'])?.id,
    ),
    subtaskId,
    role: 'evaluator',
    runner: 'codex-evaluator',
    promptContract: stringOption(options.promptContract) || (state.workflow.mode === 'review' ? 'codex-review-evaluator.v1' : 'codex-evaluator.v1'),
    input: {
      goal: state.workflow.goal,
      subtaskId,
      contractId: latestContractId(state, subtaskId) || (state.workflow.mode === 'review' ? `review-${subtaskId}` : subtaskId === '__final__' ? '__final__' : undefined),
      reviewEvidenceId: reviewEvidence?.id,
      candidateOnly: state.workflow.mode === 'review' ? true : undefined,
      currentHeadSha: headSha,
      readonly: true,
    },
    allowedPaths: evaluatorAllowedPaths,
    validationCommands: collectSubtaskValidationCommands(state, subtaskId),
    parentThreadId: stringOption(options.parentThread) || state.workflow.metadata?.parentCodexThreadId,
    headSha,
    readonlyPolicy: {
      enforced: true,
      violations: [],
    },
    prompt: stringOption(options.prompt),
    timeoutMs: numberOption(options.timeoutMs, undefined),
  });
  const reused = Boolean(launched.reused || launched.runtime?.reused);
  if (reused) {
    printJson({
      action: 'evaluator-reused',
      workflowId,
      subtaskId,
      invocation: launched.invocation,
      runtime: launched.runtime,
      reused: true,
      hint: 'Evaluator for this subtask is already running or completed; do not launch again. Wait for the evaluator to complete and record its result with `evaluate`.',
    });
    return;
  }
  printJson({
    action: 'evaluator-started',
    workflowId,
    subtaskId,
    invocation: launched.invocation,
    runtime: launched.runtime,
    reused: false,
    instruction: 'Tik launched the readonly Codex Evaluator native thread and retained attestation credentials server-side.',
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
  const stableRunParts = [workflowId, subtaskId || '__final__', intent, headSha, evaluationRunId, contractId];
  const baseStableRunId = stableNativeId('questioner-run', ...stableRunParts);
  const matchingRuns = (state.questionerRuns || [])
    .filter((candidate) => candidate.subtaskId === subtaskId
      && candidate.intent === intent
      && candidate.headSha === headSha
      && candidate.evaluationRunId === (finalEvaluationRunId ? undefined : evaluationRunId)
      && candidate.finalEvaluationRunId === finalEvaluationRunId
      && candidate.contractId === contractId)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  const reusableRun = matchingRuns.find((candidate) => ['created', 'started', 'validated'].includes(candidate.status));
  const terminalAttempts = matchingRuns.filter((candidate) => ['rejected', 'expired'].includes(candidate.status)).length;
  const stableRunId = reusableRun?.id
    || (terminalAttempts === 0
      ? baseStableRunId
      : stableNativeId('questioner-run', ...stableRunParts, `attempt-${terminalAttempts + 1}`));
  const run = await launchNativeQuestionerRun(options, workflowId, {
    id: stringOption(options.run) || stableRunId,
    invocationId: stringOption(options.invocationId)
      || stringOption(options.invocation)
      || stableNativeId('questioner', stableRunId),
    subtaskId,
    intent,
    contractId,
    evaluationRunId: finalEvaluationRunId ? undefined : evaluationRunId,
    finalEvaluationRunId,
    headSha,
    runtimeAudit: {
      gitStatusBefore,
    },
    prompt: stringOption(options.prompt),
    timeoutMs: numberOption(options.timeoutMs, undefined),
  });
  const reused = Boolean(run.reused || run.runtime?.reused);
  if (reused) {
    printJson({
      action: 'questioner-run-reused',
      workflowId,
      questionerRunId: run.questionerRunId,
      invocationId: run.invocationId,
      invocation: run.invocation,
      runtime: run.runtime,
      reused: true,
      hint: 'Questioner run for these inputs is already running or completed; do not launch again. Wait for the QuestionerOutputV2 callback.',
    });
    return;
  }
  printJson({
    action: 'questioner-run-started',
    workflowId,
    questionerRunId: run.questionerRunId,
    invocationId: run.invocationId,
    contextArtifactRef: run.contextArtifactRef,
    contextHash: run.contextHash,
    expectedOutputArtifactRef: run.expectedOutputArtifactRef,
    tokenExpiresAt: run.tokenExpiresAt,
    invocation: run.invocation,
    runtime: run.runtime,
    reused: false,
    instruction: 'Tik launched Claude Questioner and injected the token-scoped runtime environment without exposing the token to the caller.',
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
  const contractId = options.contract
    || latestContractId(state, subtaskId)
    || (state.workflow.mode === 'review' ? `review-${subtaskId}` : subtaskId === '__final__' ? '__final__' : undefined);
  if (!contractId) {
    throw new Error('--contract is required when no accepted contract is stored');
  }
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const semanticCacheKey = evaluationSemanticCacheKey(state, subtaskId, headSha, projectPath, options);
  const reusableSemantic = findReusableSemanticEvaluation(state, subtaskId, semanticCacheKey);
  const retryOf = latestEvaluationForSubtask(state, subtaskId, (run) => run.status !== 'passed');
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
    semanticCacheKey,
    retryOfEvaluationRunId: retryOf?.id,
    resumeFromStage: reusableSemantic ? 'validation_commands' : 'semantic_review',
    checkpoints: [],
  });
  if (subtaskId !== '__final__') {
    await updateSubtask(options, workflowId, subtaskId, { status: 'evaluating' });
  }
  const invocationId = stringOption(options.invocation);
  const nativeStructuredResult = invocationId
    && !options.resultJson
    && !options.result
    && isCompletedNativeInvocation(state, invocationId)
    ? nativeInvocationStructuredResult(state, invocationId, 'evaluator')
    : null;
  const structuredResult = options.resultJson
    ? JSON.parse(String(options.resultJson))
    : options.result
      ? await readJsonFile(options.result)
      : nativeStructuredResult || reusableSemantic?.semanticResult;
  const semanticReused = !options.resultJson && !options.result && !nativeStructuredResult && Boolean(reusableSemantic);
  const commands = evaluationCommandsFromOptions(options, state, subtaskId);
  const setupCommands = splitList(options.evaluatorSetupCommand) || splitList(options.setupCommand) || [];
  const commandResults = [];
  const commandIds = splitList(options.commandId) || [];
  const reusableCommands = reusablePassedEvaluationCommands(state, subtaskId, semanticCacheKey);
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
      for (const [index, command] of commands.entries()) {
        const commandId = commandIds[index]
          || (commands.length === 1 ? 'cmd-evaluate' : `cmd-evaluate-${index + 1}`);
        const reusable = reusableCommands.find((candidate) =>
          candidate.result.command === command
          && candidate.result.status === 'passed'
        );
        const reusedResult = reusable
          && await evaluationCommandArtifactsValid(projectPath, workflowId, reusable)
          && await materializeReusedCommandArtifacts({
            projectPath,
            workflowId,
            evaluationRunId: evaluationRun.evaluationRun.id,
            commandId,
            command,
            commandIndex: index,
            reusable,
          }).catch(() => null);
        if (reusedResult) {
          commandResults.push(reusedResult);
          commandResult = reusedResult;
          continue;
        }
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
        currentResult.commandId = commandId;
        const surefire = await collectSurefireEvidence({
          command,
          cwd: evaluationCwd,
          projectRoot: projectPath,
          startedAt: evaluationRun.evaluationRun.startedAt,
          artifactDir: path.join(
            projectPath,
            '.tik',
            'multi-agent',
            'workflows',
            workflowId,
            'evaluations',
            evaluationRun.evaluationRun.id,
            'surefire',
          ),
        });
        currentResult.testReports = surefire.reports;
        currentResult.gateFailureCodes = surefire.failureCodes;
        if (surefire.failureCodes.length > 0) {
          currentResult.status = 'failed';
          currentResult.summary = `Deterministic test evidence gate failed: ${surefire.failureCodes.join(', ')}.`;
        }
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
  const semanticVerdict = normalizeEvaluationVerdict(structuredResult?.verdict);
  let verdict = composeEvaluationVerdict({
    semanticVerdict,
    readonlyAccepted: readonly.guard?.accepted !== false,
    setupFailed: Boolean(setupFailure),
    commandResults: evaluationCommandResults(commandResults),
  });
  const coverageGaps = Array.isArray(structuredResult?.coverageGaps)
    ? [...structuredResult.coverageGaps]
    : [];
  if (!semanticVerdict) {
    coverageGaps.push({
      criterionId: 'semantic-verdict',
      description: 'Evaluator did not provide a semantic verdict.',
      reason: 'Command results cannot replace a native Evaluator verdict.',
    });
  }
  if (!hasEvaluationCommandResult(commandResults) && !semanticVerdict) {
    coverageGaps.push({
        criterionId: 'all',
        description: 'Evaluator did not provide command, criteria, artifact, or reproduction evidence.',
        reason: 'No evaluator command, criteria result, or artifact evidence was provided.',
    });
  }
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
  const semanticResult = {
    verdict: semanticVerdict || 'inconclusive',
    criteriaResults: Array.isArray(structuredResult?.criteriaResults) ? structuredResult.criteriaResults : [],
    runtimeFindings: Array.isArray(structuredResult?.runtimeFindings) ? structuredResult.runtimeFindings : [],
    coverageGaps: Array.isArray(structuredResult?.coverageGaps) ? structuredResult.coverageGaps : [],
    confidence: Number.isFinite(structuredResult?.confidence) ? structuredResult.confidence : 0.5,
  };
  const evaluationFailureClass = classifyEvaluationFailure({
    semanticVerdict,
    readonlyAccepted: readonly.guard?.accepted !== false,
    commandResults: evaluationCommandResults(commandResults),
  });
  const checkpointTime = new Date().toISOString();
  const commandArtifactRefs = evaluationCommandResults(commandResults).flatMap((command) => [
    command.stdoutArtifactId,
    command.stderrArtifactId,
    ...(command.testReports || []).map((report) => report.artifactId),
  ]).filter(Boolean);
  await updateEvaluationRun(options, workflowId, subtaskId, evaluationRun.evaluationRun.id, {
    semanticCacheKey,
    semanticResult,
    failureClass: evaluationFailureClass,
    resumeFromStage: evaluationFailureClass === 'command_failure'
      ? 'validation_commands'
      : evaluationFailureClass === 'artifact_failure'
        ? 'artifact_verification'
        : evaluationFailureClass
          ? 'semantic_review'
          : 'verdict_merge',
    checkpoints: [
      {
        stage: 'semantic_review',
        status: semanticReused ? 'reused' : semanticVerdict ? 'passed' : 'failed',
        inputHash: semanticCacheKey,
        outputHash: hashJson(semanticResult),
        sourceEvaluationRunId: semanticReused ? reusableSemantic?.id : undefined,
        failureClass: semanticVerdict ? undefined : 'invalid_output',
        startedAt: evaluationRun.evaluationRun.startedAt,
        completedAt: checkpointTime,
      },
      {
        stage: 'validation_commands',
        status: commands.length === 0
          ? 'pending'
          : evaluationCommandResults(commandResults).every((command) => command.status === 'passed') ? 'passed' : 'failed',
        inputHash: hashJson(commands),
        outputHash: hashJson(evaluationCommandResults(commandResults)),
        failureClass: evaluationFailureClass === 'command_failure' ? 'command_failure' : undefined,
        artifactRefs: commandArtifactRefs,
        startedAt: evaluationRun.evaluationRun.startedAt,
        completedAt: checkpointTime,
      },
      {
        stage: 'artifact_verification',
        status: evaluationFailureClass === 'artifact_failure' ? 'failed' : 'passed',
        inputHash: hashJson(commandArtifactRefs),
        outputHash: hashJson(commandResults.map((command) => command.gateFailureCodes || [])),
        failureClass: evaluationFailureClass === 'artifact_failure' ? 'artifact_failure' : undefined,
        artifactRefs: commandArtifactRefs,
        startedAt: checkpointTime,
        completedAt: checkpointTime,
      },
    ],
  });
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
        stdoutArtifactSha256: result.stdoutArtifactSha256,
        stderrArtifactSha256: result.stderrArtifactSha256,
        stdoutArtifactBytes: result.stdoutArtifactBytes,
        stderrArtifactBytes: result.stderrArtifactBytes,
        gateFailureCodes: result.gateFailureCodes,
        testReports: result.testReports,
        reusedFromEvaluationRunId: result.reusedFromEvaluationRunId,
        summary: result.summary,
      }))
      : [],
    runtimeFindings,
    coverageGaps,
    confidence: verdict === 'pass' ? 0.85 : 0.25,
  };
  const recorded = await recordEvaluationResult(options, workflowId, subtaskId, evaluationRun.evaluationRun.id, result);
  const recordedVerdict = normalizeEvaluationVerdict(recorded.evaluationRun?.result?.verdict) || 'inconclusive';
  const evaluationPassed = recorded.evaluationRun?.status === 'passed' && recordedVerdict === 'pass';
  let invocation = null;
  if (options.invocation) {
    const invocationId = String(options.invocation);
    const readonlyPolicy = {
      enforced: readonly.guard?.accepted !== false,
      violations: recorded.evaluationRun?.readonlyPolicy?.violations || readonly.evaluationRun?.readonlyPolicy?.violations || [],
      allowedWritePaths: defaultEvaluatorAllowedPaths(),
      forbiddenWritePaths: ['**/*'],
    };
    const invocationResult = {
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
    };
    invocation = isCompletedNativeInvocation(state, invocationId)
      ? await linkNativeInvocationResult(options, workflowId, invocationId, invocationResult)
      : await hookStopInvocation(options, workflowId, invocationId, {
        ...invocationResult,
        attestationToken: requireOption(options.attestationToken, '--attestation-token is required for a hook-launched Codex Evaluator invocation'),
        status: evaluationPassed ? 'completed' : 'failed',
      });
  }
  if (subtaskId !== '__final__') {
    await updateSubtask(options, workflowId, subtaskId, {
      status: evaluationPassed ? 'evaluation_passed' : 'evaluation_failed',
      validationRunIds: [evaluationRun.evaluationRun.id],
    });
  }
  printJson({
    action: 'evaluation-recorded',
    workflowId,
    subtaskId,
    passed: evaluationPassed,
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
    nextRecommendedCommand: recorded.nextRecommendedCommand || [],
  });
  if (!evaluationPassed && options.failOnValidationError) {
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
    // The completion path uses POST /decisions + PATCH /subtasks, not
    // /actions/complete-subtask, so nextRecommendedCommand is not returned by
    // the server. Callers should use `next` to determine what runs next.
  });
}

async function synthesizeReadonlyReview(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  if (state.workflow.mode !== 'review') throw new Error('synthesize-review requires a workflow created with --mode review');
  const projectPath = resolveProjectPath(options.path || state.workflow.workspaceBinding?.effectiveProjectPath);
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const structuredResult = options.resultJson
    ? JSON.parse(String(options.resultJson))
    : options.result ? await readJsonFile(options.result) : {};
  const evidenceId = stringOption(options.evidenceId) || `ev_synthesis_${randomUUID().replace(/-/g, '')}`;
  const evidence = {
    id: evidenceId,
    kind: 'synthesis',
    title: stringOption(options.title) || 'Review synthesis',
    summary: stringOption(options.summary) || structuredResult.markdown || 'Deduplicated evaluated review findings.',
    headSha,
    artifactRef: stringOption(options.artifact),
    payload: {
      synthesis: structuredResult,
      sourceEvidenceRefs: collectSubtaskEvidenceRefs(state),
    },
  };
  const decision = buildDecision(state.workflow, {
    action: 'synthesize_review',
    reason: evidence.summary,
    evidenceRefs: [...collectSubtaskEvidenceRefs(state), evidenceId],
    inputs: { currentHeadSha: headSha, taskGraphVersion: state.taskGraph?.version },
  });
  const response = await synthesizeReviewAction(options, workflowId, { decision, evidence }, {
    ifMatch: state.workflow.lastDecisionId,
  });
  printJson({
    action: 'review-synthesized',
    workflowId,
    ...response,
    nextRecommendedCommand: response.nextRecommendedCommand || [],
  });
}

async function completeWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const synthesis = latestEvidence(state, undefined, ['synthesis']);
  const decision = buildDecision(state.workflow, {
    action: 'complete_workflow',
    reason: stringOption(options.reason) || (state.workflow.mode === 'review'
      ? 'All readonly review shards were evaluated, questioned, and synthesized.'
      : 'All subtasks are done, final evaluation passed, and final Questioner found no blocking questions.'),
    evidenceRefs: mergeEvidenceRefs(collectSubtaskEvidenceRefs(state), synthesis ? [synthesis.id] : []),
    inputs: {
      currentHeadSha: state.workflow.currentHeadSha,
      taskGraphVersion: state.taskGraph?.version,
      evaluationRunId: latestEvaluationId(state, '__final__'),
      questionerOutputId: latestQuestionerOutputId(state, undefined, 'question_final_evidence'),
      synthesisEvidenceId: synthesis?.id,
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

/**
 * Abandon an open workflow. Records an `abort_workflow` decision so Kernel
 * flips status to `aborted` and emits `workflow.aborted`; the workflow will
 * no longer show up in `init` discovery. Use when the work is no longer
 * needed and callers should not resume it. Prefer `pause-workflow` when the
 * work might be resumed later.
 */
async function abandonWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  if (state.workflow.status === 'completed' || state.workflow.status === 'aborted') {
    printJson({
      action: 'workflow-abandon-noop',
      workflowId,
      status: state.workflow.status,
      hint: 'Workflow is already terminal; abandon is a no-op.',
    });
    return;
  }
  const reason = stringOption(options.reason) || 'Codex workflow abandoned by user request.';
  const decision = buildDecision(state.workflow, {
    action: 'abort_workflow',
    reason,
    evidenceRefs: collectSubtaskEvidenceRefs(state),
    inputs: {
      currentHeadSha: state.workflow.currentHeadSha,
      taskGraphVersion: state.taskGraph?.version,
    },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision, state);
  printJson({
    action: 'workflow-abandoned',
    workflowId,
    reason,
    decision,
    guard: recorded.guard,
    workflow: recorded.workflow,
  });
}

/**
 * Mark an open workflow as paused. Writes `metadata.pausedAt` + reason via a
 * PATCH; discovery in `init` skips paused workflows so a new workflow can be
 * started while the paused one stays resumable via `--workflow <id>`.
 * Does NOT change `status` — the workflow remains active in Kernel, just
 * intentionally shelved from discovery.
 */
async function pauseWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const state = await readWorkflow(options, workflowId);
  const reason = stringOption(options.reason) || 'Paused pending user follow-up.';
  const now = new Date().toISOString();
  const response = await patchWorkflow(options, workflowId, {
    metadata: {
      ...(state.workflow.metadata || {}),
      pausedAt: now,
      pausedReason: reason,
    },
  });
  printJson({
    action: 'workflow-paused',
    workflowId,
    reason,
    pausedAt: now,
    workflow: response.workflow,
    hint: 'Discovery will skip this workflow until it is resumed. Use `--workflow <id>` to explicitly resume.',
  });
}

async function continueWorkflow(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const cooldown = await checkCooldown(workflowId, options);
  if (cooldown.blocked) {
    printJson(cooldown.snapshot);
    process.exit(COOLDOWN_EXIT_CODE);
  }
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

    if (terminalActionResult?.directOutput) {
      printJson({
        ...terminalActionResult.directOutput,
        loopRound: round,
        loopMaxRounds: maxRounds,
      });
      return;
    }

    const nextState = await readWorkflow(options, workflowId).catch(() => state);
    await refreshMainSnapshot(options, nextState, {
      round,
      latestDecision: decision,
      nextActionHint: instructionForDecision(decision, nextState),
    });

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
  if (decision.reasonCode === 'awaiting_native_runtime') {
    const retryAfterMs = typeof decision.retryAfterMs === 'number' ? decision.retryAfterMs : 2000;
    // Persist a cooldown lock so subsequent continue/next/status calls in the
    // same session bail out with exit 3 instead of hammering `/next-action`.
    await installCooldownFromResponse(workflowId, {
      plannedAction: {
        reasonCode: 'awaiting_native_runtime',
        retryAfterMs,
        reason: decision.reason,
        subtaskId: decision.subtaskId,
      },
    });
    return {
      directOutput: {
        action: 'continue-instruction',
        workflowId,
        decision,
        guard: { accepted: true, code: 'ok' },
        pendingAction: 'await-runtime',
        retryAfterMs,
        instruction: decision.reason,
        cooldownInstalled: true,
        hint: 'CLI wrote a cooldown lock. Do not call continue/next/status again until the callback resumes the workflow.',
      },
      action: 'await-runtime',
      guard: { accepted: true, code: 'ok' },
    };
  }
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
    const contractId = stringOption(options.contract) || stringOption(decision.inputs?.contractId);
    const output = await capturePrintedJson(() => acceptSprintContract({
      ...options,
      subtask: decision.subtaskId,
      contract: contractId,
    }));
    return { action: output.action, guard: { accepted: true, code: 'ok' } };
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
  if (decision.action === 'run_readonly_reviewer') {
    const preflight = await safePreflightDecision(options, workflowId, decision, state);
    if (!preflight.guard?.accepted) {
      return continueBlockedOutput(workflowId, decision, state, preflight.guard);
    }
    const output = await capturePrintedJson(() => startReadyReviewers(options));
    return {
      directOutput: {
        ...output,
        action: 'continue-instruction',
        decision,
        guard: { accepted: true, code: 'ok' },
        pendingAction: output.action,
        instruction: [
          output.instruction,
          'Completed Reviewer results can be recorded directly with record-review --invocation; no result file is required.',
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
      const retryAfterMs = plannedAction.retryAfterMs
        ?? response.retryAfterMs
        ?? response.__http?.retryAfterMs;
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
        retryAfterMs,
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
  const cooldown = await checkCooldown(workflowId, options);
  if (cooldown.blocked) {
    printJson(cooldown.snapshot);
    process.exit(COOLDOWN_EXIT_CODE);
  }
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

function normalizeEvaluationVerdict(value) {
  return ['pass', 'fail', 'inconclusive', 'human_review_required'].includes(value) ? value : undefined;
}

function evaluationSemanticCacheKey(state, subtaskId, headSha, projectPath, options) {
  const baseRef = state.workflow.baseRef || `${headSha}^`;
  const diff = git(projectPath, ['diff', '--binary', `${baseRef}...${headSha}`], { optional: true }) || '';
  const contract = latestAcceptedContract(state, subtaskId);
  return hashJson({
    headSha,
    subtaskId,
    contract: contract ? {
      id: contract.id,
      version: contract.version,
      goal: contract.goal,
      acceptanceCriteria: contract.acceptanceCriteria,
      scope: contract.scope,
      verificationPlan: contract.verificationPlan,
    } : { id: latestContractId(state, subtaskId) || subtaskId },
    diffHash: hashJson(diff),
    promptVersion: stringOption(options.promptContract) || 'codex-evaluator.v1',
    additionalPromptHash: hashJson(stringOption(options.prompt) || ''),
    model: stringOption(options.model) || 'default',
  });
}

function findReusableSemanticEvaluation(state, subtaskId, semanticCacheKey) {
  return (state.evaluationRuns || [])
    .filter((run) => run.subtaskId === subtaskId && run.semanticCacheKey === semanticCacheKey && run.semanticResult)
    .filter((run) => (run.checkpoints || []).some((checkpoint) =>
      checkpoint.stage === 'semantic_review'
      && (checkpoint.status === 'passed' || checkpoint.status === 'reused')
    ))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function latestEvaluationForSubtask(state, subtaskId, predicate = () => true) {
  return (state.evaluationRuns || [])
    .filter((run) => run.subtaskId === subtaskId && predicate(run))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function reusablePassedEvaluationCommands(state, subtaskId, semanticCacheKey) {
  return (state.evaluationRuns || [])
    .filter((run) => run.subtaskId === subtaskId && run.semanticCacheKey === semanticCacheKey)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .flatMap((run) => (run.result?.commandResults || [])
      .filter((result) => result.status === 'passed')
      .map((result) => ({ evaluationRunId: run.id, result })));
}

async function evaluationCommandArtifactsValid(projectPath, workflowId, reusable) {
  const { evaluationRunId, result } = reusable;
  const sourcePrefix = `.tik/multi-agent/workflows/${workflowId}/evaluations/${evaluationRunId}/`;
  const artifacts = [
    [result.stdoutArtifactId, result.stdoutArtifactSha256, result.stdoutArtifactBytes],
    [result.stderrArtifactId, result.stderrArtifactSha256, result.stderrArtifactBytes],
    ...(result.testReports || []).map((report) => [
      report.artifactId,
      report.artifactSha256,
      report.artifactBytes,
    ]),
  ];
  for (const [artifactRef, expectedHash, expectedBytes] of artifacts) {
    if (!artifactRef) return false;
    const normalizedRef = normalizeEvidencePath(artifactRef);
    if (!normalizedRef.startsWith(sourcePrefix)) return false;
    const buffer = await readFile(path.resolve(projectPath, normalizedRef)).catch(() => null);
    if (!buffer || buffer.byteLength === 0) return false;
    if (Number.isFinite(expectedBytes) && buffer.byteLength !== expectedBytes) return false;
    if (expectedHash && `sha256:${createHash('sha256').update(buffer).digest('hex')}` !== expectedHash) return false;
  }
  return true;
}

async function materializeReusedCommandArtifacts(input) {
  const source = input.reusable.result;
  const targetPrefix = `.tik/multi-agent/workflows/${input.workflowId}/evaluations/${input.evaluationRunId}`;
  const suffix = input.commandIndex === 0 ? '' : `-${input.commandIndex + 1}`;
  const copyArtifact = async (sourceRef, targetRef) => {
    const sourcePath = path.resolve(input.projectPath, normalizeEvidencePath(sourceRef));
    const targetPath = path.resolve(input.projectPath, targetRef);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { force: true });
    return targetRef;
  };
  const stdoutArtifactId = await copyArtifact(source.stdoutArtifactId, `${targetPrefix}/stdout${suffix}.log`);
  const stderrArtifactId = await copyArtifact(source.stderrArtifactId, `${targetPrefix}/stderr${suffix}.log`);
  const testReports = [];
  for (const [reportIndex, report] of (source.testReports || []).entries()) {
    const filename = path.basename(normalizeEvidencePath(report.artifactId));
    const artifactId = await copyArtifact(
      report.artifactId,
      `${targetPrefix}/surefire/reused-${input.commandIndex + 1}-${reportIndex + 1}-${filename}`,
    );
    testReports.push({ ...report, artifactId });
  }
  return {
    ...source,
    commandId: input.commandId,
    command: input.command,
    stdoutArtifactId,
    stderrArtifactId,
    testReports,
    reusedFromEvaluationRunId: input.reusable.evaluationRunId,
    summary: `Reused passed command evidence from ${input.reusable.evaluationRunId}.`,
  };
}

function classifyEvaluationFailure(input) {
  if (!input.readonlyAccepted) return 'readonly_violation';
  if (!input.semanticVerdict) return 'invalid_output';
  if (input.semanticVerdict === 'fail' || input.semanticVerdict === 'human_review_required') return 'semantic_failure';
  if (input.commandResults.some((command) => command.status !== 'passed')) {
    const artifactFailure = input.commandResults.some((command) =>
      (command.gateFailureCodes || []).some((code) => /artifact|report_missing|stale_report|hash/i.test(code))
    );
    return artifactFailure ? 'artifact_failure' : 'command_failure';
  }
  return undefined;
}

function hashJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function composeEvaluationVerdict(input) {
  if (!input.readonlyAccepted || input.setupFailed) return 'fail';
  if (input.commandResults.some((result) => result.status !== 'passed')) return 'fail';
  if (input.semanticVerdict === 'fail') return 'fail';
  if (input.semanticVerdict === 'inconclusive') return 'inconclusive';
  if (input.semanticVerdict === 'human_review_required') return 'human_review_required';
  return input.semanticVerdict === 'pass' ? 'pass' : 'inconclusive';
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
    'synthesize_review',
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

function isCompletedNativeInvocation(state, invocationId) {
  return (state.invocations || []).some((invocation) =>
    invocation.id === invocationId
    && invocation.status === 'completed'
    && invocation.runtimeAttestation?.source === 'codex-subagent-runtime'
  );
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

function codexEvaluatorQuestionerPolicy(mode = 'implementation') {
  return {
    requireAcceptedContract: mode !== 'review',
    requireEvaluationPassForComplete: true,
    requireQuestionerAfterEvaluation: true,
    requireSameHeadShaForEvidence: true,
    allowHumanOverride: false,
  };
}

async function runEnvironmentPreflight(options, input) {
  const capabilities = await detectClientCapabilities();
  return preflightEnvironment(options, {
    mode: input.mode,
    headSha: input.headSha,
    workspaceBinding: input.workspaceBinding,
    clientCapabilities: capabilities,
  });
}

async function detectClientCapabilities() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const tikRoot = path.resolve(scriptDir, '../../..');
  const packageJson = await readJsonOptional(path.join(tikRoot, 'package.json'));
  const expectedPnpm = String(packageJson?.packageManager || '').match(/^pnpm@(.+)$/)?.[1];
  const pnpmVersion = commandVersion('corepack', ['pnpm', '--version']);
  const nodeVersion = process.versions.node;
  const questionerPlugin = path.join(tikRoot, 'claude-plugin', 'agent-loop-claude-review', '.claude-plugin', 'plugin.json');
  return {
    codexHookAttestation: await detectCodexHookAttestation(),
    codexCli: Boolean(commandVersion('codex', ['--version'])),
    claudeCode: Boolean(commandVersion('claude', ['--version'])),
    claudeQuestionerPlugin: Boolean(await readJsonOptional(questionerPlugin)),
    nodeVersion,
    pnpmVersion,
    packageManagerSatisfied: Boolean(pnpmVersion) && (!expectedPnpm || compareVersions(pnpmVersion, expectedPnpm) >= 0),
  };
}

async function detectCodexHookAttestation() {
  if (process.env.TIK_CODEX_HOOK_ATTESTATION === '1') return true;
  const hookConfig = await readFile(path.join(os.homedir(), '.codex', 'hooks.json'), 'utf-8').catch(() => '');
  return /tik/i.test(hookConfig) && /(attestation|hook-start|hook-stop)/i.test(hookConfig);
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.status !== 0) return undefined;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || output || undefined;
}

function compareVersions(left, right) {
  const leftParts = String(left).split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
  const rightParts = String(right).split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function stableNativeId(kind, ...parts) {
  const readable = parts
    .slice(0, 2)
    .map((part) => String(part || 'none').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 36))
    .join('_');
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
  return `inv_${kind.replace(/[^A-Za-z0-9._-]/g, '_')}_${readable}_${digest}`;
}

function nativeInvocationStructuredResult(state, invocationId, expectedRole) {
  const invocation = (state.invocations || []).find((candidate) => candidate.id === invocationId);
  if (!invocation || invocation.status !== 'completed') {
    throw new Error(`Native ${expectedRole} invocation ${invocationId} is not completed.`);
  }
  if (invocation.role !== expectedRole) {
    throw new Error(`Invocation ${invocationId} has role ${invocation.role}, expected ${expectedRole}.`);
  }
  const result = invocation.result || {};
  const preferred = expectedRole === 'reviewer'
    ? result.reviewResult
    : result.evaluationResult;
  if (preferred && typeof preferred === 'object' && !Array.isArray(preferred)) return preferred;
  const parsed = parseLastJsonObject(result.content);
  if (parsed) return parsed;
  return result;
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeWorkflowMode(value) {
  const mode = stringOption(value) || 'implementation';
  if (mode !== 'implementation' && mode !== 'review') {
    throw new Error(`Unsupported workflow mode: ${mode}. Expected implementation or review.`);
  }
  return mode;
}

function buildDeterministicReviewTaskGraph(input) {
  const diffSpec = `${input.baseRef}...${input.headSha}`;
  const changedFiles = splitLines(git(input.projectPath, ['diff', '--name-only', diffSpec], { optional: true }))
    .map(normalizeEvidencePath)
    .filter(Boolean);
  const domains = [
    {
      id: 'web_api',
      title: 'Web and API',
      focus: ['request validation', 'API compatibility', 'authorization', 'frontend integration'],
      matches: (file) => /(^|\/)(web|api|controller|controllers|route|routes|http|frontend|dashboard)(\/|$)/i.test(file),
    },
    {
      id: 'job_rpc_privacy',
      title: 'Jobs, RPC, and Privacy',
      focus: ['background execution', 'RPC compatibility', 'privacy boundaries', 'failure recovery'],
      matches: (file) => /(^|\/)(job|jobs|rpc|privacy|security|auth)(\/|$)/i.test(file),
    },
    {
      id: 'dal_sql',
      title: 'DAL and SQL',
      focus: ['query correctness', 'transactions', 'schema compatibility', 'index usage'],
      matches: (file) => /(^|\/)(dal|dao|repository|repositories|sql|mapper|mappers|db|database)(\/|$)|\.(sql|ddl)$/i.test(file),
    },
  ];
  const assigned = new Set();
  const grouped = domains.map((domain) => {
    const files = changedFiles.filter((file) => domain.matches(file));
    files.forEach((file) => assigned.add(file));
    return { ...domain, files };
  });
  grouped.push({
    id: 'core_state',
    title: 'Core State and Behavior',
    focus: ['state transitions', 'business invariants', 'error handling', 'regression risk'],
    matches: () => true,
    files: changedFiles.filter((file) => !assigned.has(file)),
  });
  const nonEmpty = grouped.filter((group) => group.files.length > 0);
  const shards = nonEmpty.length > 0 ? nonEmpty.flatMap((group) => {
    const chunks = chunkArray(group.files, 25);
    return chunks.map((files, index) => ({
      ...group,
      id: chunks.length === 1 ? group.id : `${group.id}_${index + 1}`,
      title: chunks.length === 1 ? group.title : `${group.title} ${index + 1}/${chunks.length}`,
      files,
    }));
  }) : [{
    id: 'core_state',
    title: 'Core State and Behavior',
    focus: ['state transitions', 'business invariants', 'error handling', 'regression risk'],
    files: ['**/*'],
  }];
  return {
    workflowId: input.workflowId,
    version: 1,
    createdBy: 'codex-workflow',
    subtasks: shards.map((shard) => ({
      id: `review_${shard.id}`,
      kind: 'review',
      title: shard.title,
      goal: `Review the pinned diff for ${shard.title}.`,
      dependsOn: [],
      allowedPaths: shard.files,
      blockedPaths: [],
      acceptanceCriteria: [
        'Every reported finding is tied to the pinned HEAD and a concrete code location.',
        'Candidate findings include severity, impact, and reproducible reasoning.',
      ],
      validationCommands: [],
      reviewFocus: shard.focus,
      assignedReviewer: 'codex',
    })),
    risks: ['Large diffs may require narrower deterministic shards.', 'Generated files may need explicit exclusion by project policy.'],
    globalAcceptanceCriteria: ['All review shards are evaluated and questioned before synthesis.'],
    finalValidationCommands: [],
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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
    '**/target/**',
    '.risk.env',
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
  const base = state.workflow.baseRef || contract?.headShaAtAcceptance || state.workflow.currentHeadSha;
  const fromGit = base
    ? splitLines(git(projectPath, ['diff', '--name-only', `${base}...HEAD`], { optional: true }))
    : [];
  if (fromGit.length > 0) {
    return fromGit;
  }
  const workingTreeDiff = splitLines(git(projectPath, ['diff', '--name-only'], { optional: true }));
  return subtractPreexistingChangedFiles(workingTreeDiff, state, subtaskId);
}

/**
 * Remove files that were already dirty when the workflow was initialised —
 * unless the current subtask explicitly claims them in its allowedPaths (an
 * intentional overlap, e.g. a subtask that is continuing prior work).
 *
 * Without this, a workflow created against a worktree that already contained
 * unrelated edits would attribute every one of them to the first subtask and
 * get rejected with `worktree_out_of_scope`.
 */
function subtractPreexistingChangedFiles(observedFiles, state, subtaskId) {
  const preexisting = Array.isArray(state.workflow?.metadata?.preexistingChangedFiles)
    ? state.workflow.metadata.preexistingChangedFiles.filter((entry) => typeof entry === 'string')
    : [];
  if (preexisting.length === 0) {
    return observedFiles;
  }
  const allowedPaths = collectSubtaskAllowedPaths(state, subtaskId);
  const preexistingSet = new Set(preexisting.map(normalizeEvidencePath));
  return observedFiles.filter((file) => {
    const normalized = normalizeEvidencePath(file);
    if (!preexistingSet.has(normalized)) return true;
    // Preserve the file if the contract claims it — the overlap is intentional.
    return matchesAnyPath(normalized, allowedPaths);
  });
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
    const logHeader = `$ ${input.command}\n`;
    stdoutStream.write(logHeader);
    stderrStream.write(logHeader);
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
      finishStreams(stdoutStream, stderrStream).then(async () => {
        const [stdoutArtifact, stderrArtifact] = await Promise.all([
          readFile(input.stdoutArtifactPath),
          readFile(input.stderrArtifactPath),
        ]);
        resolve({
          command: input.command,
          status,
          exitCode: code,
          signal,
          stdout,
          stderr,
          stdoutArtifactId: toProjectRelative(input.artifactBasePath || input.cwd, input.stdoutArtifactPath),
          stderrArtifactId: toProjectRelative(input.artifactBasePath || input.cwd, input.stderrArtifactPath),
          stdoutArtifactSha256: `sha256:${createHash('sha256').update(stdoutArtifact).digest('hex')}`,
          stderrArtifactSha256: `sha256:${createHash('sha256').update(stderrArtifact).digest('hex')}`,
          stdoutArtifactBytes: stdoutArtifact.byteLength,
          stderrArtifactBytes: stderrArtifact.byteLength,
          summary: timeout
            ? (idleTimedOut ? 'Command timed out after idle timeout.' : 'Command timed out.')
            : code === 0 ? 'Command passed.' : 'Command failed.',
        });
      }).catch(reject);
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
  node ${script} preflight --mode implementation|review [--path <repo>]
  node ${script} init --goal <goal> [--path <repo>]
  node ${script} plan --workflow <workflow-id>
  node ${script} accept-plan --workflow <workflow-id> --task-graph <file>
  node ${script} draft-contract --workflow <workflow-id> --subtask <id>
  node ${script} accept-contract --workflow <workflow-id> --subtask <id> --contract <contract-id>
  node ${script} accept-contracts --workflow <workflow-id> --items <contracts.json>
  node ${script} next --workflow <workflow-id>
  node ${script} start-builder --workflow <workflow-id> --subtask <id> --invocation <id>
  node ${script} execute --workflow <workflow-id> --subtask <id> --summary <text> [--changed-files <comma-list>]
  node ${script} start-reviewer --workflow <workflow-id> --subtask <id> --invocation <id>
  node ${script} start-reviewers --workflow <workflow-id> [--max-concurrency 4]
  node ${script} record-review --workflow <workflow-id> --subtask <id> --invocation <id>
  node ${script} start-evaluator --workflow <workflow-id> --subtask <id> --invocation <id>
  node ${script} validate --workflow <workflow-id> --subtask <id> --command <cmd>
  node ${script} evaluate --workflow <workflow-id> --subtask <id> --command <cmd>
  node ${script} start-questioner --workflow <workflow-id> --intent <intent> [--subtask <id>]
  node ${script} complete-questioner --unsafe-legacy --workflow <workflow-id> --invocation <id> --output <file>
  node ${script} import-questioner-output --unsafe-legacy --workflow <workflow-id> --invocation <id> --output <file>
  node ${script} complete-invocation --workflow <workflow-id> --invocation <id> [--status started|completed]
  node ${script} record-questioner --workflow <workflow-id> --intent <intent> [--subtask <id>]
  node ${script} complete-subtask --workflow <workflow-id> --subtask <id>
  node ${script} complete-workflow --workflow <workflow-id>
  node ${script} abandon-workflow --workflow <workflow-id> [--reason <text>]
  node ${script} pause-workflow --workflow <workflow-id> [--reason <text>]
  node ${script} synthesize-review --workflow <workflow-id> [--result <json-file>]
  node ${script} continue --workflow <workflow-id>
  node ${script} status --workflow <workflow-id>

Options:
  --api-base-url <url>       Tik API base URL. Defaults to TIK_API_BASE_URL or http://127.0.0.1:3300/api
  --api-token <token>        Tik API bearer token. Defaults to TIK_API_TOKEN.
  --path <repo>              Repository/worktree path. Defaults to cwd.
  --mode <mode>              Workflow mode: implementation (default) or review.
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
  --items <json-file>        JSON array used by accept-contracts.
  --invocation <id>          Tik AgentInvocation id. Tik creates the native runtime thread by default.
  --thread <id>              Legacy hook-launched Codex subagent thread/session id.
  --timeout-ms <n>           Native runtime timeout.
  --v1                       Enable Codex Evaluator / Claude Questioner gates.
  --max-rounds <n>           Max loop rounds. Defaults to 3.
  --max-concurrency <n>      Maximum ready Reviewer shards launched together. Defaults to 4.
  --evaluator-artifact-path <path>  Extra evaluator artifact path allowed by readonly policy. Repeat or comma-separate.
  --output <path>            (init only) Write full JSON response to a file.
`);
}

await main();
