import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  MultiAgentWorkflowBundle,
  MultiAgentWorkflowEvidence,
} from '@tik/shared';

const execFileAsync = promisify(execFile);

export interface CommittedEvidencePreflightIssue {
  code:
    | 'repository_unavailable'
    | 'worktree_dirty'
    | 'head_mismatch'
    | 'missing_implementation_evidence'
    | 'missing_review_evidence'
    | 'evidence_head_mismatch'
    | 'missing_changed_files'
    | 'changed_files_mismatch'
    | 'invalid_base_ref'
    | 'changed_file_not_in_diff'
    | 'changed_file_not_in_commit'
    | 'non_strict_test_selector'
    | 'test_selector_not_found';
  message: string;
}

export interface CommittedEvidencePreflightResult {
  accepted: boolean;
  issues: CommittedEvidencePreflightIssue[];
}

export async function validateCommittedEvidencePreflight(input: {
  bundle: MultiAgentWorkflowBundle;
  projectPath: string;
  headSha: string;
  subtaskId?: string;
  validationCommands?: string[];
}): Promise<CommittedEvidencePreflightResult> {
  const issues: CommittedEvidencePreflightIssue[] = [];
  const repositoryRoot = await git(input.projectPath, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) {
    return reject('repository_unavailable', `Unable to resolve a Git repository at ${input.projectPath}.`);
  }

  const [actualHead, status] = await Promise.all([
    git(repositoryRoot, ['rev-parse', 'HEAD']),
    git(repositoryRoot, ['status', '--porcelain=v1']),
  ]);
  if (status === undefined) {
    issues.push({ code: 'repository_unavailable', message: 'Unable to inspect the Git worktree.' });
  } else if (status.trim()) {
    issues.push({ code: 'worktree_dirty', message: 'The effective project worktree must be clean before native evidence review.' });
  }
  if (!actualHead || actualHead !== input.headSha) {
    issues.push({
      code: 'head_mismatch',
      message: `Requested evidence head ${input.headSha} does not match repository HEAD ${actualHead || '(unavailable)'}.`,
    });
  }

  const reviewMode = input.bundle.workflow.mode === 'review';
  const evidence = selectCommittedEvidence(input.bundle.evidence, input.subtaskId, input.headSha, reviewMode);
  if (evidence.length === 0) {
    const latest = selectCommittedEvidence(input.bundle.evidence, input.subtaskId, undefined, reviewMode);
    issues.push(latest.length > 0
      ? {
        code: 'evidence_head_mismatch',
        message: `${reviewMode ? 'Review' : 'Implementation'} evidence is not bound to requested head ${input.headSha}.`,
      }
      : {
        code: reviewMode ? 'missing_review_evidence' : 'missing_implementation_evidence',
        message: reviewMode
          ? 'Committed review requires readonly review evidence.'
          : 'Committed evidence review requires implementation or fix evidence.',
      });
  }

  const changedFiles = uniqueChangedFiles(evidence);
  if (evidence.length > 0 && changedFiles.length === 0) {
    issues.push({
      code: 'missing_changed_files',
      message: 'Implementation evidence must claim at least one changed file.',
    });
  }

  const baseRef = input.bundle.workflow.baseRef;
  const diffEntries = baseRef
    ? await committedDiff(repositoryRoot, baseRef, input.headSha)
    : undefined;
  if (!baseRef || !diffEntries) {
    issues.push({
      code: 'invalid_base_ref',
      message: `Unable to resolve workflow base ref ${baseRef || '(missing)'} against ${input.headSha}.`,
    });
  } else {
    for (const file of changedFiles) {
      const diffStatus = diffEntries.get(file.path);
      if (!diffStatus) {
        issues.push({
          code: 'changed_file_not_in_diff',
          message: `Evidence file ${file.path} is not present in ${baseRef}...${input.headSha}.`,
        });
        continue;
      }
      const deleted = diffStatus.startsWith('D') || file.changeType === 'deleted';
      if (!deleted && !(await gitObjectExists(repositoryRoot, input.headSha, file.path))) {
        issues.push({
          code: 'changed_file_not_in_commit',
          message: `Evidence file ${file.path} does not exist in commit ${input.headSha}.`,
        });
      }
    }
    if (evidence.length > 0) {
      const declared = new Set(changedFiles.map((file) => file.path));
      const expected = scopedDiffFiles(input.bundle, input.subtaskId, diffEntries);
      const missing = expected.filter((file) => !declared.has(file));
      const unexpected = Array.from(declared).filter((file) => !expected.includes(file));
      if (missing.length > 0 || unexpected.length > 0) {
        issues.push({
          code: 'changed_files_mismatch',
          message: [
            missing.length > 0 ? `Evidence omitted committed files: ${missing.join(', ')}.` : '',
            unexpected.length > 0 ? `Evidence declared files outside the committed scope: ${unexpected.join(', ')}.` : '',
          ].filter(Boolean).join(' '),
        });
      }
    }
  }

  const commands = collectValidationCommands(input.bundle, input.subtaskId, input.validationCommands);
  const treeFiles = await git(repositoryRoot, ['ls-tree', '-r', '--name-only', input.headSha]);
  const committedFiles = new Set((treeFiles || '').split(/\r?\n/).filter(Boolean));
  for (const command of commands) {
    const selectors = mavenTestSelectors(command);
    if (selectors.length === 0) continue;
    if (!/-Dsurefire\.failIfNoSpecifiedTests=true(?:\s|$)/.test(command)) {
      issues.push({
        code: 'non_strict_test_selector',
        message: `Maven test selection must set -Dsurefire.failIfNoSpecifiedTests=true: ${command}`,
      });
    }
    for (const selector of selectors) {
      if (!testSelectorExists(committedFiles, selector)) {
        issues.push({
          code: 'test_selector_not_found',
          message: `Selected test ${selector} does not exist in commit ${input.headSha}.`,
        });
      }
    }
  }

  return { accepted: issues.length === 0, issues };
}

export function committedEvidenceErrorMessage(result: CommittedEvidencePreflightResult): string {
  return result.issues.map((issue) => `${issue.code}: ${issue.message}`).join(' ');
}

function reject(code: CommittedEvidencePreflightIssue['code'], message: string): CommittedEvidencePreflightResult {
  return { accepted: false, issues: [{ code, message }] };
}

function selectCommittedEvidence(
  evidence: MultiAgentWorkflowEvidence[],
  subtaskId: string | undefined,
  headSha?: string,
  reviewMode = false,
): MultiAgentWorkflowEvidence[] {
  const candidates = evidence
    .filter((item) => reviewMode
      ? item.kind === 'review'
      : item.kind === 'implementation' || item.kind === 'fix')
    .filter((item) => subtaskId === '__final__' || !subtaskId || item.subtaskId === subtaskId)
    .filter((item) => !headSha || item.headSha === headSha)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (subtaskId && subtaskId !== '__final__') return candidates.slice(0, 1);
  const latestBySubtask = new Map<string, MultiAgentWorkflowEvidence>();
  for (const item of candidates) {
    const key = item.subtaskId || item.id;
    if (!latestBySubtask.has(key)) latestBySubtask.set(key, item);
  }
  return Array.from(latestBySubtask.values());
}

function uniqueChangedFiles(evidence: MultiAgentWorkflowEvidence[]): Array<{ path: string; changeType?: string }> {
  const files = new Map<string, { path: string; changeType?: string }>();
  for (const item of evidence) {
    const payload = item.payload || {};
    const entries = Array.isArray(payload.observedChangedFiles)
      ? payload.observedChangedFiles
      : Array.isArray(payload.changedFiles)
        ? payload.changedFiles
        : Array.isArray(payload.reviewScope)
          ? payload.reviewScope
          : [];
    for (const entry of entries) {
      const file = typeof entry === 'string'
        ? { path: entry }
        : entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string'
          ? {
            path: entry.path,
            changeType: 'changeType' in entry && typeof entry.changeType === 'string' ? entry.changeType : undefined,
          }
          : undefined;
      if (!file) continue;
      const normalized = normalizePath(file.path);
      if (!normalized || normalized.startsWith('../')) continue;
      files.set(normalized, { ...file, path: normalized });
    }
  }
  return Array.from(files.values());
}

function scopedDiffFiles(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
  diffEntries: Map<string, string>,
): string[] {
  const allFiles = Array.from(diffEntries.keys()).filter((file) => !isIgnoredGeneratedFile(file));
  if (!subtaskId || subtaskId === '__final__') return allFiles.sort();
  const contract = bundle.contracts
    .filter((item) => item.subtaskId === subtaskId && item.status === 'accepted')
    .sort((left, right) => right.version - left.version)[0];
  const subtask = bundle.taskGraph?.subtasks?.find((item) => item.id === subtaskId);
  const allowedPaths = contract?.scope.allowedPaths || subtask?.allowedPaths || [];
  if (allowedPaths.length === 0) return allFiles.sort();
  return allFiles.filter((file) => matchesAnyPath(file, allowedPaths)).sort();
}

function isIgnoredGeneratedFile(filePath: string): boolean {
  return /(^|\/)target(?:\/|$)/.test(filePath)
    || /(^|\/)\.risk\.env$/.test(filePath)
    || /(^|\/)(?:test-results|playwright-report|coverage)(?:\/|$)/.test(filePath)
    || filePath.startsWith('.tmp/evaluation/')
    || filePath.startsWith('.tik/multi-agent/');
}

function matchesAnyPath(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = normalizePath(pattern);
    if (normalized.includes('*')) return globPathToRegExp(normalized).test(filePath);
    return filePath === normalized || filePath.startsWith(`${normalized.replace(/\/$/, '')}/`);
  });
}

function globPathToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function collectValidationCommands(
  bundle: MultiAgentWorkflowBundle,
  subtaskId: string | undefined,
  explicit: string[] | undefined,
): string[] {
  const commands = [...(explicit || [])];
  if (subtaskId === '__final__') {
    commands.push(...(bundle.taskGraph?.finalValidationCommands || []));
  } else if (subtaskId) {
    const contract = bundle.contracts
      .filter((item) => item.subtaskId === subtaskId && item.status === 'accepted')
      .sort((left, right) => right.version - left.version)[0];
    commands.push(...(contract?.verificationPlan.commands.filter((item) => item.required).map((item) => item.command) || []));
  }
  return Array.from(new Set(commands.filter(Boolean)));
}

async function committedDiff(cwd: string, baseRef: string, headSha: string): Promise<Map<string, string> | undefined> {
  const output = await git(cwd, ['diff', '--name-status', '--find-renames', `${baseRef}...${headSha}`]);
  if (output === undefined) return undefined;
  const result = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, firstPath, secondPath] = line.split('\t');
    const filePath = normalizePath(secondPath || firstPath || '');
    if (filePath) result.set(filePath, status || 'M');
  }
  return result;
}

async function gitObjectExists(cwd: string, headSha: string, filePath: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${headSha}:${filePath}`])) !== undefined;
}

function mavenTestSelectors(command: string): string[] {
  const match = command.match(/(?:^|\s)-Dtest=("[^"]+"|'[^']+'|[^\s]+)/);
  if (!match) return [];
  return match[1]
    .replace(/^['"]|['"]$/g, '')
    .split(',')
    .map((selector) => selector.split('#')[0].split('.').at(-1)?.trim() || '')
    .filter(Boolean);
}

function testSelectorExists(files: Set<string>, selector: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(selector).replace(/\\\*/g, '.*')}$`);
  for (const filePath of files) {
    const match = filePath.match(/([^/]+)\.(?:java|kt|groovy)$/);
    if (match && pattern.test(match[1])) return true;
  }
  return false;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}
