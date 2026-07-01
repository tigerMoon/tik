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
  readTask,
  readWorkflow,
  recordDecision,
  recordEvidence,
  tikFetch,
  updateSubtask,
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
      case 'plan':
        await requestPlan(options);
        break;
      case 'accept-plan':
        await acceptPlan(options);
        break;
      case 'next':
        await next(options);
        break;
      case 'execute':
        await execute(options);
        break;
      case 'validate':
        await validate(options);
        break;
      case 'review':
        await requestReview(options);
        break;
      case 'process-review':
        await processReview(options);
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
    nextCommand: `node codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs next --workflow ${response.workflow?.id}`,
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

async function execute(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const headSha = git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const evidence = await recordEvidence(options, workflowId, {
    id: stringOption(options.evidenceId),
    kind: 'implementation',
    title: options.title || `Codex implementation for ${subtaskId}`,
    summary: options.summary || 'Codex session recorded implementation evidence.',
    subtaskId,
    headSha,
  });
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: 'implemented',
    implementationHeadSha: headSha,
    evidenceRefs: [evidence.evidence.id],
  });
  const decision = buildDecision(state.workflow, {
    action: 'validate_subtask',
    subtaskId,
    reason: 'Codex recorded implementation evidence; validation is next.',
    evidenceRefs: [evidence.evidence.id],
    inputs: { currentHeadSha: headSha },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision);
  printJson({
    action: 'execution-recorded',
    workflowId,
    subtaskId,
    evidence: evidence.evidence,
    subtask: subtask.subtask,
    decision,
    guard: recorded.guard,
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
  });
  const headSha = git(projectPath, ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
  const subtask = await updateSubtask(options, workflowId, subtaskId, {
    status: passed ? 'approved' : 'validation_failed',
    lastValidatedHeadSha: headSha,
    validationRunIds: [evidence.evidence.id],
    evidenceRefs: [evidence.evidence.id],
  });
  const decision = buildDecision(state.workflow, {
    action: passed ? 'request_claude_review' : 'execute_subtask',
    subtaskId,
    reason: passed
      ? 'Validation passed; request Claude review through Tik.'
      : 'Validation failed; current Codex session must inspect and fix.',
    evidenceRefs: [evidence.evidence.id],
    inputs: {
      currentHeadSha: headSha,
      validationPassed: passed,
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
  const decision = buildDecision(state.workflow, {
    action: round > 1 ? 'request_re_review' : 'request_claude_review',
    subtaskId,
    reviewRoundId: taskId,
    reason: 'Codex workflow requested a Tik-owned Claude review.',
    evidenceRefs: state.subtasks?.[subtaskId]?.evidenceRefs || [],
    inputs: { round, maxRounds, currentHeadSha: headSha, reviewTaskId: taskId },
  });
  const recorded = await safeRecordDecision(options, workflowId, decision);
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
    decision,
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
  const validationPassed = !options.validationPassed
    ? true
    : options.validationPassed === true || String(options.validationPassed).toLowerCase() === 'true';
  const policy = decideAfterReview({
    workflow: state.workflow,
    subtaskId,
    task,
    result,
    validationPassed,
  });
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
  const recorded = await safeRecordDecision(options, workflowId, decision);
  const status = statusForReviewDecision(decision.action);
  await updateSubtask(options, workflowId, subtaskId, {
    status,
    lastReviewedHeadSha: result.headShaReviewed,
    evidenceRefs: [evidence.evidence.id],
    blockerFindingIds: (result.blockingIssues || []).map((issue, index) => `${task.id}:blocking:${index + 1}`),
    fixRound: decision.action === 'fix_claude_blockers'
      ? (state.subtasks?.[subtaskId]?.fixRound || 0) + 1
      : state.subtasks?.[subtaskId]?.fixRound || 0,
  });
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

async function fix(options) {
  const workflowId = requireOption(options.workflow, '--workflow is required');
  const subtaskId = requireOption(options.subtask, '--subtask is required');
  const state = await readWorkflow(options, workflowId);
  const headSha = git(resolveProjectPath(options.path), ['rev-parse', 'HEAD'], { optional: true }) || state.workflow.currentHeadSha;
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
    action: 'request_re_review',
    subtaskId,
    reviewRoundId: stringOption(options.reviewRound),
    reason: 'Codex recorded a fix for Claude blockers; re-review is next.',
    evidenceRefs: [evidence.evidence.id],
    inputs: { currentHeadSha: headSha },
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
  printJson({
    action: 'status',
    workflow: state.workflow,
    taskGraphVersion: state.taskGraph?.version,
    subtasks: state.subtasks,
    decisionCount: state.decisions?.length || 0,
    evidenceCount: state.evidence?.length || 0,
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

function inferValidationCommand(state, subtaskId) {
  const subtask = findSubtask(state.taskGraph, subtaskId);
  return subtask?.validationCommands?.[0];
}

function nextReviewRound(subtask) {
  return (subtask?.reviewRoundIds?.length || 0) + 1;
}

function statusForReviewDecision(action) {
  if (action === 'complete_subtask') return 'done';
  if (action === 'fix_claude_blockers') return 'needs_fix';
  if (action === 'request_human_review') return 'human_review_required';
  if (action === 'request_re_review') return 'reviewing';
  return 'reviewing';
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
  node ${script} init --goal <goal> [--path <repo>]
  node ${script} plan --workflow <workflow-id>
  node ${script} accept-plan --workflow <workflow-id> --task-graph <file>
  node ${script} next --workflow <workflow-id>
  node ${script} execute --workflow <workflow-id> --subtask <id> --summary <text>
  node ${script} validate --workflow <workflow-id> --subtask <id> --command <cmd>
  node ${script} review --workflow <workflow-id> --subtask <id> [--start]
  node ${script} process-review --workflow <workflow-id> --subtask <id> --task <review-task-id>
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
  --round <n>                Review round.
  --max-rounds <n>           Max review rounds. Defaults to 3.
  --output <path>            Write full JSON response to a file.
`);
}

await main();
