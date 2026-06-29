import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactRegistry } from '../src/artifacts/artifact-registry.js';
import { RunProofService } from '../src/agent-runners/run-proof-service.js';
import { FileRunProofStore } from '../src/agent-runners/run-proof-store.js';
import type { AgentRuntimeRunner } from '../src/agent-runners/agent-runtime-runner.js';
import type { AgentRunRecord, DiffSummary, TranscriptRef } from '@tik/shared';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('RunProofService', () => {
  it('creates transcript, diff stat, and review artifacts for a completed run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-run-proof-service-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, '.tik', 'runs', 'run-1'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'runs', 'run-1', 'stdout.log'), 'implemented\n', 'utf-8');
    const runner = makeRunner({
      transcript: [{ path: path.join(root, '.tik', 'runs', 'run-1', 'stdout.log'), contentType: 'text/plain' }],
      diff: {
        changedFiles: ['src/app.ts'],
        insertions: 3,
        deletions: 1,
        patchPath: path.join(root, '.tik', 'runs', 'run-1', 'run-diff.patch'),
      },
    });
    await fs.writeFile(path.join(root, '.tik', 'runs', 'run-1', 'run-diff.patch'), 'diff --git a/src/app.ts b/src/app.ts\n', 'utf-8');
    await fs.writeFile(path.join(root, '.tik', 'runs', 'run-1', 'run-diff-stat.txt'), ' src/app.ts | 4 +++-\n', 'utf-8');
    const service = new RunProofService({
      proofStore: new FileRunProofStore(root),
      artifacts: new FileArtifactRegistry({ rootPath: root }),
    });

    const proof = await service.createProof({
      task: {
        id: 'task-1',
        shortIdentifier: 'TIK-1',
        title: 'Add review loop',
        goal: 'Generate a reviewable run proof',
      },
      run: makeRun(root),
      runner,
      completion: { status: 'completed' },
    });

    expect(proof).toMatchObject({
      taskId: 'task-1',
      runId: 'run-1',
      status: 'ready_for_review',
      risk: 'low',
      transcriptArtifactIds: [expect.any(String)],
      producedArtifactIds: [expect.any(String)],
      diff: {
        filesChanged: 1,
        insertions: 3,
        deletions: 1,
        changedFiles: ['src/app.ts'],
        patchArtifactId: expect.any(String),
        statArtifactId: expect.any(String),
      },
    });
    const artifacts = await new FileArtifactRegistry({ rootPath: root }).list({ taskId: 'task-1' });
    expect(artifacts.map((artifact) => artifact.title).sort()).toEqual([
      'Run Diff: TIK-1 attempt 1',
      'Run Diff Stat: TIK-1 attempt 1',
      'Run Review: TIK-1 attempt 1',
      'Run Transcript: TIK-1 attempt 1',
    ].sort());
    expect(artifacts.find((artifact) => artifact.title.startsWith('Run Review'))).toMatchObject({
      status: 'needs_review',
      kind: 'run_review',
      producedBy: { template: 'run-review', provider: 'codex' },
      changedFiles: ['src/app.ts'],
    });
    expect(artifacts.find((artifact) => artifact.title.startsWith('Run Transcript'))).toMatchObject({
      kind: 'transcript',
    });
    expect(artifacts.find((artifact) => artifact.title.startsWith('Run Diff Stat'))).toMatchObject({
      kind: 'diff',
      contentType: 'text/plain',
    });
  });

  it('records validation command output and marks the proof failed when validation fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-run-proof-service-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, '.tik', 'runs', 'run-1'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'runs', 'run-1', 'stdout.log'), 'implemented\n', 'utf-8');
    await fs.writeFile(path.join(root, '.tik', 'runs', 'run-1', 'run-diff.patch'), 'diff --git a/src/app.ts b/src/app.ts\n', 'utf-8');
    const runner = makeRunner({
      transcript: [{ path: path.join(root, '.tik', 'runs', 'run-1', 'stdout.log'), contentType: 'text/plain' }],
      diff: {
        changedFiles: ['src/app.ts'],
        insertions: 3,
        deletions: 1,
        patchPath: path.join(root, '.tik', 'runs', 'run-1', 'run-diff.patch'),
      },
    });
    const service = new RunProofService({
      proofStore: new FileRunProofStore(root),
      artifacts: new FileArtifactRegistry({ rootPath: root }),
      runCommand: vi.fn(async () => ({
        exitCode: 1,
        stdout: 'typecheck output\n',
        stderr: 'type error\n',
        durationMs: 25,
      })),
    });

    const proof = await service.createProof({
      task: {
        id: 'task-1',
        shortIdentifier: 'TIK-1',
        title: 'Add review loop',
        goal: 'Generate a reviewable run proof',
      },
      run: makeRun(root),
      runner,
      completion: { status: 'completed' },
      validationCommands: ['pnpm typecheck'],
    });

    expect(proof).toMatchObject({
      status: 'validation_failed',
      risk: 'high',
      validationRefs: [
        {
          command: 'pnpm typecheck',
          cwd: root,
          exitCode: 1,
          durationMs: 25,
          stdoutArtifactId: expect.any(String),
          stderrArtifactId: expect.any(String),
          summary: expect.stringContaining('type error'),
        },
      ],
      failure: {
        kind: 'validation_error',
        message: expect.stringContaining('pnpm typecheck'),
        retryable: true,
      },
    });
    const artifacts = await new FileArtifactRegistry({ rootPath: root }).list({ taskId: 'task-1' });
    const validationArtifacts = artifacts.filter((artifact) => artifact.kind === 'validation_log');
    expect(validationArtifacts).toHaveLength(2);
    expect(artifacts.find((artifact) => artifact.kind === 'run_review')?.validationRefs).toEqual([
      proof.validationRefs[0]?.id,
    ]);
  });

  it('marks proof incomplete when diff collection fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-run-proof-service-'));
    tempDirs.push(root);
    const runner = makeRunner({
      transcript: [],
      diffError: new Error('git diff failed'),
    });
    const service = new RunProofService({
      proofStore: new FileRunProofStore(root),
      artifacts: new FileArtifactRegistry({ rootPath: root }),
    });

    const proof = await service.createProof({
      task: {
        id: 'task-1',
        shortIdentifier: 'TIK-1',
        title: 'Add review loop',
        goal: 'Generate a reviewable run proof',
      },
      run: makeRun(root),
      runner,
      completion: { status: 'completed' },
    });

    expect(proof).toMatchObject({
      status: 'proof_incomplete',
      risk: 'high',
      failure: {
        kind: 'collection_error',
        message: expect.stringContaining('git diff failed'),
        retryable: true,
      },
    });
  });
});

function makeRunner(input: {
  transcript: TranscriptRef[];
  diff?: DiffSummary;
  diffError?: Error;
}): AgentRuntimeRunner {
  return {
    name: 'codex',
    prepare: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(),
    collectTranscript: vi.fn(async () => input.transcript),
    collectDiff: vi.fn(async () => {
      if (input.diffError) throw input.diffError;
      return input.diff || { changedFiles: [] };
    }),
    collectArtifacts: vi.fn(async () => []),
    cleanup: vi.fn(),
  };
}

function makeRun(root: string): AgentRunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    shortIdentifier: 'TIK-1',
    attempt: 0,
    runner: 'codex',
    runnerMode: 'codex_exec',
    workflowPath: path.join(root, '.tik', 'WORKFLOW.md'),
    workflowConfigHash: 'config-hash',
    workflowPromptHash: 'prompt-hash',
    status: 'completed_by_agent',
    workspaceRoot: root,
    projectPath: root,
    transcriptRefs: [],
    eventRefs: [],
    artifactIds: [],
  };
}
