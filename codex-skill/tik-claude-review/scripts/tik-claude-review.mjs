#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3300/api';
const EXTERNAL_OWNER_LABEL = 'external-claude-review';

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  try {
    switch (command) {
      case 'create':
        await createReview(options);
        break;
      case 'start':
        await startReview(options);
        break;
      case 'wait':
        await waitForReview(options);
        break;
      case 'process':
        await processReview(options);
        break;
      case 'run':
        await createWaitProcess(options);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function createWaitProcess(options) {
  const created = await createReview(options, { returnResult: true });
  await startReview({ ...options, task: created.task.id }, { returnResult: true });
  await waitForReview({ ...options, task: created.task.id }, { returnResult: true });
  await processReview({ ...options, task: created.task.id });
}

async function createReview(options, behavior = {}) {
  const projectPath = path.resolve(options.path || process.cwd());
  const baseRef = options.base || 'HEAD~1';
  const headSha = options.headSha || git(projectPath, ['rev-parse', 'HEAD']);
  const headRef = options.headRef || git(projectPath, ['branch', '--show-current']) || 'HEAD';
  const repo = options.repo || path.basename(projectPath);
  const rootTaskId = options.rootTask || repo;
  const round = numberOption(options.round, 1);
  const maxRounds = numberOption(options.maxRounds, 3);
  const title = options.title || `Claude Code review for ${repo} at ${headSha.slice(0, 12)}`;
  const body = {
    rootTaskId,
    round,
    maxRounds,
    repo,
    title,
    baseRef,
    headRef,
    headSha,
    idempotencyKey: options.idempotencyKey || [
      'external_claude_review',
      'internal',
      repo,
      rootTaskId,
      headSha,
      `r${round}`,
    ].join(':'),
    labels: mergeLabels(options.label, [EXTERNAL_OWNER_LABEL]),
    allowedScope: splitList(options.allowedScope),
    acceptanceCriteria: splitList(options.acceptanceCriteria),
    reviewFocus: splitList(options.reviewFocus),
    reviewInputSource: options.reviewInputSource || (options.mergeRequestUrl || options.mrUrl ? 'merge_request' : 'local_diff'),
    mergeRequestUrl: options.mergeRequestUrl || options.mrUrl,
    fetchRemote: options.fetchRemote,
    fetchRef: options.fetchRef,
    createdBy: 'codex',
    workspaceBinding: {
      workspaceRoot: path.resolve(options.workspaceRoot || findWorkspaceRoot(projectPath)),
      workspaceName: options.workspaceName || path.basename(path.resolve(options.workspaceRoot || findWorkspaceRoot(projectPath))),
      projectName: repo,
      sourceProjectPath: options.sourcePath ? path.resolve(options.sourcePath) : projectPath,
      effectiveProjectPath: projectPath,
      laneId: options.lane || 'external-claude-review',
      worktreeKind: options.worktreeKind || 'root',
    },
  };

  const response = await tikFetch(options, '/v1/agent-loop/worktree-review-rounds', {
    method: 'POST',
    body,
  });
  await writeJsonIfRequested(options.output, response);
  printJson({
    action: 'created',
    taskId: response.task?.id,
    shortIdentifier: response.task?.shortIdentifier,
    status: response.task?.status,
    labels: response.task?.labels,
    headSha: response.task?.agentLoop?.headSha,
    trackerOwned: false,
    claudePluginSelector: {
      label: 'needs-claude-review',
      agentLoopKind: 'claude_review',
    },
    startCommand: `node codex-skill/tik-claude-review/scripts/tik-claude-review.mjs start --task ${response.task?.id}`,
  });
  if (behavior.returnResult) {
    return response;
  }
}

async function startReview(options, behavior = {}) {
  const taskId = requireOption(options.task, '--task is required');
  const response = await tikFetch(options, `/v1/agent-loop/tasks/${encodeURIComponent(taskId)}/claude-review-runs`, {
    method: 'POST',
  });
  await writeJsonIfRequested(options.output, response);
  printJson({
    action: 'started',
    taskId,
    runId: response.runId,
    dispatched: response.result?.dispatched || [],
    failed: response.result?.failed || [],
  });
  if (behavior.returnResult) {
    return response;
  }
}

async function waitForReview(options, behavior = {}) {
  const taskId = requireOption(options.task, '--task is required');
  const timeoutMs = numberOption(options.timeoutMs, 30 * 60 * 1000);
  const intervalMs = numberOption(options.intervalMs, 10_000);
  const started = Date.now();

  while (true) {
    const task = await readTask(options, taskId);
    const result = task.agentLoop?.reviewResult;
    if (result) {
      const response = { task, reviewResult: result };
      await writeJsonIfRequested(options.output, response);
      printJson({
        action: 'review-result',
        taskId: task.id,
        shortIdentifier: task.shortIdentifier,
        verdict: result.verdict,
        blockingIssueCount: result.blockingIssues?.length || 0,
        nextKind: task.agentLoop?.kind,
        nextPhase: task.agentLoop?.phase,
        nextStatus: task.status,
      });
      if (behavior.returnResult) {
        return response;
      }
      return;
    }
    if (task.agentLoop?.stale) {
      throw new Error(`Claude review marked stale: expected ${task.agentLoop.stale.expectedHeadSha}, actual ${task.agentLoop.stale.actualHeadSha}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for Claude review result on task ${taskId}`);
    }
    await sleep(intervalMs);
  }
}

async function processReview(options) {
  const taskId = requireOption(options.task, '--task is required');
  const task = await readTask(options, taskId);
  const result = task.agentLoop?.reviewResult;
  if (!result) {
    throw new Error(`Task ${taskId} does not have an agentLoop.reviewResult yet.`);
  }

  const blockingIssues = result.blockingIssues || [];
  if (blockingIssues.length > 0) {
    printJson({
      action: 'codex-fix-needed',
      taskId: task.id,
      shortIdentifier: task.shortIdentifier,
      nextStatus: task.status,
      nextPhase: task.agentLoop?.phase,
      headShaReviewed: result.headShaReviewed,
      blockingIssues,
      testsNeeded: result.testsNeeded || [],
      instruction: 'Fix the blocking issues in the current Codex session, then create the next external Claude review round.',
    });
    return;
  }

  printJson({
    action: result.verdict === 'approve' ? 'approved' : 'human-review-needed',
    taskId: task.id,
    shortIdentifier: task.shortIdentifier,
    nextStatus: task.status,
    nextPhase: task.agentLoop?.phase,
    headShaReviewed: result.headShaReviewed,
    nonBlockingSuggestions: result.nonBlockingSuggestions || [],
    testsNeeded: result.testsNeeded || [],
    instruction: result.verdict === 'approve'
      ? 'Claude approved the code. Leave final completion or merge approval to the operator/project policy.'
      : 'No blocking issues were returned. Surface comments to the operator or continue with explicit human approval.',
  });
}

async function readTask(options, taskId) {
  const payload = await tikFetch(options, '/v1/tasks', { method: 'GET' });
  const task = (payload.tasks || []).find((item) =>
    item.id === taskId || item.shortIdentifier === taskId || item.identifier === taskId
  );
  if (!task) {
    throw new Error(`Tik task not found: ${taskId}`);
  }
  return task;
}

async function tikFetch(options, route, input) {
  const baseUrl = (options.apiBaseUrl || process.env.TIK_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const headers = {
    accept: 'application/json',
  };
  if (input.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const token = options.apiToken || process.env.TIK_API_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error?.message || payload.error || text || response.statusText;
    throw new Error(`Tik API ${input.method} ${route} failed (${response.status}): ${detail}`);
  }
  return payload;
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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function findWorkspaceRoot(projectPath) {
  let current = projectPath;
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, '.tik')) || existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return projectPath || os.homedir();
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

function requireOption(value, message) {
  if (!value || value === true) {
    throw new Error(message);
  }
  return String(value);
}

async function writeJsonIfRequested(filePath, value) {
  if (!filePath || filePath === true) return;
  const resolved = path.resolve(String(filePath));
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
Usage:
  tik-claude-review.mjs create [options]
  tik-claude-review.mjs start --task <task-id> [options]
  tik-claude-review.mjs wait --task <task-id> [options]
  tik-claude-review.mjs process --task <task-id> [options]
  tik-claude-review.mjs run [options]  # create/start/wait/process

Options:
  --api-base-url <url>       Tik API base URL. Defaults to TIK_API_BASE_URL or ${DEFAULT_API_BASE_URL}
  --api-token <token>        Tik API bearer token. Defaults to TIK_API_TOKEN.
  --path <repo>              Repository/worktree to review. Defaults to cwd.
  --workspace-root <path>    Tik workspace root. Defaults to nearest .tik/package.json ancestor.
  --root-task <id>           Root task identifier. Defaults to repo name.
  --repo <name>              Repository name. Defaults to basename of --path.
  --base <ref>               Base ref for review diff. Defaults to HEAD~1.
  --head-ref <ref>           Head ref. Defaults to current branch or HEAD.
  --head-sha <sha>           Head sha. Defaults to git rev-parse HEAD.
  --round <n>                Review round. Defaults to 1.
  --max-rounds <n>           Max review rounds. Defaults to 3.
  --review-focus <csv>       Review focus hints.
  --acceptance-criteria <csv> Acceptance criteria hints.
  --allowed-scope <csv>      Scope hints.
  --review-input-source <local_diff|merge_request>
                             Review source. Defaults to local_diff.
  --merge-request-url <url>   Merge request URL for MR-sourced reviews.
  --mr-url <url>              Alias for --merge-request-url.
  --fetch-remote <name>       Remote used by MR fetch instructions. Defaults to origin.
  --fetch-ref <ref>           Ref used by MR fetch instructions.
  --label <csv>              Extra labels. external-claude-review is always added.
  --task <id>                Task id/identifier for start/wait/process.
  --timeout-ms <n>           Wait timeout. Defaults to 1800000.
  --interval-ms <n>          Poll interval. Defaults to 10000.
  --output <path>            Write full JSON response to a file.
`);
}

await main();
