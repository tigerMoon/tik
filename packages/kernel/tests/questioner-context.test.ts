import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { MultiAgentWorkflowBundle } from '@tik/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildQuestionerContext } from '../src/multi-agent/questioner-context.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('QuestionerContext', () => {
  it('uses baseRef...HEAD for final evidence and omits prior Questioner history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-questioner-context-'));
    tempDirs.push(root);
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Tik Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'first.ts'), 'export const first = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'second.ts'), 'export const second = 1;\n', 'utf-8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    const baseSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await fs.writeFile(path.join(root, 'first.ts'), 'export const first = 2;\n', 'utf-8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'first change'], { cwd: root });
    await fs.writeFile(path.join(root, 'second.ts'), 'export const second = 2;\n', 'utf-8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'second change'], { cwd: root });
    const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

    const bundle = {
      workflow: {
        id: 'wf-context-range',
        goal: 'Review every workflow commit',
        baseRef: baseSha,
        currentHeadSha: headSha,
        policy: {},
        workspaceBinding: {
          workspaceRoot: root,
          effectiveProjectPath: root,
        },
      },
      taskGraph: {
        subtasks: [],
        globalAcceptanceCriteria: ['All committed changes are reviewed.'],
      },
      subtasks: {},
      contracts: [],
      evidence: [],
      evaluationRuns: [],
      questionerOutputs: [{
        id: 'q-old',
        intent: 'question_final_evidence',
        verdict: 'evidence_sufficient',
        questions: [],
        createdAt: '2026-07-13T00:00:00.000Z',
      }],
    } as MultiAgentWorkflowBundle;

    const context = await buildQuestionerContext(bundle, {
      workflowId: 'wf-context-range',
      questionerRunId: 'qr-context-range',
      invocationId: 'inv-context-range',
      intent: 'question_final_evidence',
      headSha,
      submitUrl: '/submit',
    });

    const nameStatus = context.diff?.excerpts.find((excerpt) => excerpt.path === '__git_diff_name_status__')?.excerpt || '';
    expect(nameStatus).toContain('first.ts');
    expect(nameStatus).toContain('second.ts');
    expect(context.diff?.baseSha).toBe(baseSha);
    expect(context.previousQuestionerOutputs).toEqual([]);
  });

  it('slimQuestionerContext shrinks free-text excerpts while preserving structure and rehashing', async () => {
    const { slimQuestionerContext, estimateContextTokens } = await import(
      '../src/multi-agent/questioner-context.js'
    );
    const bigLog = 'x'.repeat(4000);
    const bigDiff = 'y'.repeat(4000);
    const bigFile = 'z'.repeat(4000);
    const context = {
      schemaVersion: 'questioner-context.v1',
      run: {
        id: 'qr-1',
        workflowId: 'wf-1',
        invocationId: 'inv-1',
        intent: 'question_evaluation',
        headSha: 'head-1',
        contextArtifactRef: '.tik/x/context.json',
        submitUrl: '/submit',
        contextHash: 'original-hash',
      },
      workflow: {
        id: 'wf-1',
        goal: 'test',
        globalAcceptanceCriteria: ['must be small'],
      },
      diff: {
        baseSha: 'base-1',
        headSha: 'head-1',
        files: [{ path: 'a.ts', changeType: 'modified' }],
        // Include the synthetic entries that buildDiffExcerpts always emits
        // at indices 0/1 so we can assert the slim pass keeps them plus at
        // least a few per-file diffs — the regression the review caught.
        excerpts: [
          { path: '__git_diff_stat__', excerpt: bigDiff },
          { path: '__git_diff_name_status__', excerpt: bigDiff },
          { path: 'a.ts', excerpt: bigDiff },
          { path: 'b.ts', excerpt: bigDiff },
          { path: 'c.ts', excerpt: bigDiff },
          { path: 'd.ts', excerpt: bigDiff },
          { path: 'e.ts', excerpt: bigDiff },
        ],
      },
      relevantFiles: [
        { path: 'a.ts', sha256: 'sha-a', excerpt: bigFile, reason: 'r' },
        { path: 'b.ts', sha256: 'sha-b', excerpt: bigFile, reason: 'r' },
        { path: 'c.ts', sha256: 'sha-c', excerpt: bigFile, reason: 'r' },
        { path: 'd.ts', sha256: 'sha-d', excerpt: bigFile, reason: 'r' },
        { path: 'e.ts', sha256: 'sha-e', excerpt: bigFile, reason: 'r' },
      ],
      evaluation: {
        id: 'eval-1',
        readonly: true,
        headSha: 'head-1',
        verdict: 'fail',
        commands: [],
        artifacts: [],
        coverage: [{ criterionId: 'ac-1', status: 'fail', evidence: 'x' }],
        coverageGaps: [{ criterionId: 'ac-1', description: 'gap' }],
        logs: [
          { excerpt: bigLog },
          { excerpt: bigLog },
          { excerpt: bigLog },
          { excerpt: bigLog },
          { excerpt: bigLog },
          { excerpt: bigLog },
        ],
      },
      previousQuestionerOutputs: [],
      outputContract: {
        schemaVersion: 'questioner-output.v2',
        requiredFields: [],
        allowedVerdicts: [],
      },
    } as any;

    const raw = estimateContextTokens(context);
    const slim = slimQuestionerContext(context);
    const slimEstimate = estimateContextTokens(slim);

    // Structure preserved.
    expect(slim.evaluation?.verdict).toBe('fail');
    expect(slim.evaluation?.coverage.map((c) => c.criterionId)).toEqual(['ac-1']);
    expect(slim.evaluation?.coverageGaps.map((g) => g.criterionId)).toEqual(['ac-1']);
    expect(slim.relevantFiles.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    // Slimming cut logs (>4 to ≤4) and excerpt bodies (4000 → <1000).
    expect(slim.evaluation!.logs.length).toBeLessThanOrEqual(4);
    for (const log of slim.evaluation!.logs) {
      expect(log.excerpt.length).toBeLessThan(1000);
    }
    expect(slim.diff!.excerpts.length).toBeLessThanOrEqual(4);
    for (const excerpt of slim.diff!.excerpts) {
      expect(excerpt.excerpt.length).toBeLessThan(1000);
    }
    // Regression: slim must keep synthetic headers AND at least some per-file
    // diffs. Before the fix, slice(0, 4) kept only synthetic entries plus 2
    // file diffs; here we assert file diffs are represented, not just headers.
    const slimPaths = slim.diff!.excerpts.map((entry) => entry.path);
    expect(slimPaths).toContain('__git_diff_stat__');
    expect(slimPaths).toContain('__git_diff_name_status__');
    const filePaths = slimPaths.filter((p) => !p.startsWith('__git_'));
    expect(filePaths.length).toBeGreaterThan(0);
    // Hash was recomputed (differs from the placeholder 'original-hash').
    expect(slim.run.contextHash).not.toBe('original-hash');
    expect(slim.run.contextHash).not.toBe('');
    // Slim is meaningfully smaller — sanity check that this pass is worth doing.
    expect(slimEstimate).toBeLessThan(raw / 2);

    // Idempotent: slim(slim(ctx)) produces the same output and same hash.
    const slimTwice = slimQuestionerContext(slim);
    expect(slimTwice.run.contextHash).toBe(slim.run.contextHash);
    expect(estimateContextTokens(slimTwice)).toBe(slimEstimate);
  });

  it('slimQuestionerContext also compresses coverage, coverageGaps, globalAcceptanceCriteria, and implementationEvidence.summary', async () => {
    const { slimQuestionerContext, estimateContextTokens } = await import(
      '../src/multi-agent/questioner-context.js'
    );
    const bigText = 'x'.repeat(4000);
    const context = {
      schemaVersion: 'questioner-context.v1',
      run: {
        id: 'qr-1', workflowId: 'wf-1', invocationId: 'inv-1', intent: 'question_final_evidence',
        headSha: 'head-1', contextArtifactRef: '.tik/x/context.json', submitUrl: '/submit',
        contextHash: 'original-hash',
      },
      workflow: {
        id: 'wf-1', goal: 'test',
        // 30 criteria, each 4000 chars — this alone is 120k raw.
        globalAcceptanceCriteria: Array.from({ length: 30 }, (_, i) => `ac-${i}: ${bigText}`),
      },
      implementationEvidence: {
        evidenceId: 'ev-1',
        summary: bigText,
        changedFiles: ['a.ts'],
      },
      diff: { baseSha: 'base-1', headSha: 'head-1', files: [], excerpts: [] },
      relevantFiles: [],
      evaluation: {
        id: 'eval-1', readonly: true, headSha: 'head-1', verdict: 'fail',
        commands: [], artifacts: [], logs: [],
        // 30 criteriaResults, each evidence field is 4000 chars.
        coverage: Array.from({ length: 30 }, (_, i) => ({
          criterionId: `ac-${i}`, status: 'fail' as const, evidence: bigText,
        })),
        coverageGaps: Array.from({ length: 10 }, (_, i) => ({
          criterionId: `ac-${i}`, description: bigText,
        })),
      },
      finalEvaluation: {
        id: 'final-1', headSha: 'head-1', verdict: 'fail',
        globalCriteriaCoverage: Array.from({ length: 30 }, (_, i) => ({
          criterionId: `ac-${i}`, status: 'fail' as const, evidence: bigText,
        })),
        requiredEvidence: [],
        coverageGaps: Array.from({ length: 5 }, (_, i) => ({
          criterionId: `ac-${i}`, description: bigText,
        })),
      },
      previousQuestionerOutputs: [],
      outputContract: { schemaVersion: 'questioner-output.v2', requiredFields: [], allowedVerdicts: [] },
    } as any;

    const rawTokens = estimateContextTokens(context);
    const slim = slimQuestionerContext(context);
    const slimTokens = estimateContextTokens(slim);

    // Slim must compress the bulky non-log/diff/file blocks. Structure preserved:
    expect(slim.workflow!.globalAcceptanceCriteria.length).toBeLessThanOrEqual(20);
    for (const ac of slim.workflow!.globalAcceptanceCriteria) {
      expect(ac.length).toBeLessThan(300);
    }
    for (const criterion of slim.evaluation!.coverage) {
      expect(criterion.evidence.length).toBeLessThan(400);
    }
    for (const gap of slim.evaluation!.coverageGaps) {
      expect(gap.description!.length).toBeLessThan(400);
    }
    for (const criterion of slim.finalEvaluation!.globalCriteriaCoverage) {
      expect(criterion.evidence.length).toBeLessThan(400);
    }
    for (const gap of slim.finalEvaluation!.coverageGaps) {
      expect(gap.description!.length).toBeLessThan(400);
    }
    expect(slim.implementationEvidence!.summary.length).toBeLessThan(1000);
    // Total shrink is meaningful — raw is 500k+ tokens, slim should easily
    // drop below 15k. Exact ratio depends on remaining structural JSON, but
    // 90%+ reduction is the target.
    expect(slimTokens).toBeLessThan(rawTokens / 5);
    expect(slimTokens).toBeLessThan(15_000);
  });

  it('budgetDiffExcerpts handles empty / synthetic-only / zero-synthetic cases', async () => {
    const { slimQuestionerContext } = await import(
      '../src/multi-agent/questioner-context.js'
    );
    // Test through slim's public surface — budgetDiffExcerpts is internal.
    const base = {
      schemaVersion: 'questioner-context.v1',
      run: { id: 'q', workflowId: 'w', invocationId: 'i', intent: 'question_evaluation',
        headSha: 'h', contextArtifactRef: '.tik/x/c.json', submitUrl: '/s', contextHash: '' },
      workflow: { id: 'w', goal: 'g', globalAcceptanceCriteria: [] },
      relevantFiles: [],
      previousQuestionerOutputs: [],
      outputContract: { schemaVersion: 'questioner-output.v2', requiredFields: [], allowedVerdicts: [] },
    } as any;

    // Case: empty excerpts
    const empty = slimQuestionerContext({ ...base, diff: { baseSha: 'b', headSha: 'h', files: [], excerpts: [] } });
    expect(empty.diff!.excerpts).toEqual([]);

    // Case: only synthetic entries
    const syntheticOnly = slimQuestionerContext({
      ...base,
      diff: {
        baseSha: 'b', headSha: 'h', files: [],
        excerpts: [
          { path: '__git_diff_stat__', excerpt: 'stat' },
          { path: '__git_diff_name_status__', excerpt: 'names' },
        ],
      },
    });
    expect(syntheticOnly.diff!.excerpts.map((e) => e.path)).toEqual(['__git_diff_stat__', '__git_diff_name_status__']);

    // Case: zero synthetic, many files
    const filesOnly = slimQuestionerContext({
      ...base,
      diff: {
        baseSha: 'b', headSha: 'h', files: [],
        excerpts: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, excerpt: 'x'.repeat(1000) })),
      },
    });
    // No synthetic entries, all slots go to files, capped at 4.
    expect(filesOnly.diff!.excerpts.length).toBeLessThanOrEqual(4);
    for (const entry of filesOnly.diff!.excerpts) {
      expect(entry.path.startsWith('__git_')).toBe(false);
    }
  });
});
