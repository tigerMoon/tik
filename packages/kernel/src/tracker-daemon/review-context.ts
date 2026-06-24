import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ReviewContextOptions {
  maxFiles?: number;
  maxDiffBytes?: number;
}

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_DIFF_BYTES = 60_000;

export async function buildTikGeneratedReviewContext(
  projectPath: string,
  options: ReviewContextOptions = {},
): Promise<string> {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const maxDiffBytes = options.maxDiffBytes || DEFAULT_MAX_DIFF_BYTES;
  if (!isGitWorkTree(projectPath)) {
    return [
      '## Tik-generated review context',
      '',
      'Tik could not generate a git diff context because the project path is not inside a git work tree.',
      `Project path: ${projectPath}`,
    ].join('\n');
  }

  const status = gitOutput(projectPath, ['status', '--short']);
  const changedFiles = uniqueStrings([
    ...gitOutput(projectPath, ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--']).split(/\r?\n/),
    ...gitOutput(projectPath, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/),
  ].map((line) => line.trim()).filter(Boolean));
  const selectedFiles = changedFiles.slice(0, maxFiles);
  let remainingDiffBytes = maxDiffBytes;
  const snippets: string[] = [];

  for (const file of selectedFiles) {
    if (remainingDiffBytes <= 0) break;
    const diff = await diffSnippetForFile(projectPath, file, remainingDiffBytes);
    if (!diff.trim()) continue;
    const truncatedDiff = truncate(diff, remainingDiffBytes);
    remainingDiffBytes -= Buffer.byteLength(truncatedDiff, 'utf-8');
    snippets.push([
      `#### ${file}`,
      '```diff',
      truncatedDiff.trimEnd(),
      '```',
    ].join('\n'));
  }

  const omittedFiles = changedFiles.length > selectedFiles.length
    ? `\n\nOmitted ${changedFiles.length - selectedFiles.length} changed file(s) beyond the ${maxFiles} file limit.`
    : '';
  const diffBudgetNotice = remainingDiffBytes <= 0
    ? '\n\nDiff snippets were truncated because they reached the Tik review-context byte budget.'
    : '';

  return [
    '## Tik-generated review context',
    '',
    'Tik precomputed this bounded review input. Use it as the primary source for review; avoid broad repository scans.',
    '',
    '### git status --short',
    '```text',
    status.trimEnd() || '(clean)',
    '```',
    '',
    '### Changed files',
    changedFiles.length
      ? selectedFiles.map((file) => `- ${file}`).join('\n') + omittedFiles
      : '- (none)',
    '',
    '### Diff snippets',
    snippets.length ? snippets.join('\n\n') + diffBudgetNotice : '(no diff snippets available)',
  ].join('\n');
}

function isGitWorkTree(projectPath: string): boolean {
  return gitOutput(projectPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trimEnd() : '';
}

async function diffSnippetForFile(projectPath: string, file: string, maxBytes: number): Promise<string> {
  const diff = gitOutput(projectPath, ['diff', '--', file]);
  if (diff.trim()) return diff;

  const content = await fs.readFile(path.join(projectPath, file), 'utf-8').catch(() => '');
  if (!content.trim()) return '';
  return [
    `diff --git a/${file} b/${file}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${file}`,
    ...truncate(content, maxBytes)
      .split(/\r?\n/)
      .map((line) => `+${line}`),
  ].join('\n');
}

function truncate(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maxBytes)).toString('utf-8')}\n...[truncated by Tik]`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
