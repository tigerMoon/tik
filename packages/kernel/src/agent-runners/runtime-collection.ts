import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DiffSummary, TranscriptRef } from '@tik/shared';
import type { PreparedRun } from './agent-runtime-runner.js';

const execFileAsync = promisify(execFile);

export async function collectTranscriptFromRunLogs(input: PreparedRun): Promise<TranscriptRef[]> {
  const runDir = runDirectory(input);
  const candidates = [
    path.join(runDir, 'stdout.log'),
    path.join(runDir, 'stderr.log'),
  ];
  const refs: TranscriptRef[] = [];
  for (const filePath of candidates) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile() && stat.size > 0) {
      refs.push({ path: filePath, contentType: 'text/plain' });
    }
  }
  return refs;
}

export async function collectGitDiffSummary(input: PreparedRun): Promise<DiffSummary> {
  const runDir = runDirectory(input);
  await fs.mkdir(runDir, { recursive: true });
  const [numstat, stat, patch] = await Promise.all([
    runGit(['diff', '--numstat'], input.cwd),
    runGit(['diff', '--stat'], input.cwd),
    runGit(['diff', '--binary'], input.cwd),
  ]);
  const parsed = parseNumstat(numstat.stdout);
  const patchPath = path.join(runDir, 'run-diff.patch');
  const statPath = path.join(runDir, 'run-diff-stat.txt');
  await Promise.all([
    fs.writeFile(patchPath, patch.stdout, 'utf-8'),
    fs.writeFile(statPath, stat.stdout, 'utf-8'),
  ]);
  return {
    changedFiles: parsed.changedFiles,
    insertions: parsed.insertions,
    deletions: parsed.deletions,
    patchPath,
    statPath,
  };
}

function runDirectory(input: PreparedRun): string {
  return input.promptFile ? path.dirname(input.promptFile) : path.join(input.cwd, '.tik', 'runs', input.runId);
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

function parseNumstat(stdout: string): Pick<DiffSummary, 'changedFiles' | 'insertions' | 'deletions'> {
  let insertions = 0;
  let deletions = 0;
  const changedFiles: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed, ...fileParts] = line.split('\t');
    const file = fileParts.join('\t').trim();
    if (!file) continue;
    changedFiles.push(file);
    const addedCount = Number(added);
    const removedCount = Number(removed);
    if (Number.isFinite(addedCount)) insertions += addedCount;
    if (Number.isFinite(removedCount)) deletions += removedCount;
  }
  return {
    changedFiles,
    insertions,
    deletions,
  };
}
