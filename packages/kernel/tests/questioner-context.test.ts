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
});
