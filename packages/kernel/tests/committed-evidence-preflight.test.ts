import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { MultiAgentWorkflowBundle } from '@tik/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { validateCommittedEvidencePreflight } from '../src/multi-agent/committed-evidence-preflight.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('committed evidence preflight', () => {
  it('accepts same-head evidence whose files and strict test selector exist in the commit', async () => {
    const fixture = await createFixture();
    const result = await validateCommittedEvidencePreflight({
      bundle: buildBundle(fixture),
      projectPath: fixture.root,
      headSha: fixture.headSha,
      subtaskId: 'st-api',
      validationCommands: ['mvn test -Dtest=ExampleTest -Dsurefire.failIfNoSpecifiedTests=true'],
    });

    expect(result).toEqual({ accepted: true, issues: [] });
  });

  it('rejects stale evidence and a requested head that differs from repository HEAD', async () => {
    const fixture = await createFixture();
    const bundle = buildBundle(fixture);
    bundle.evidence[0].headSha = fixture.baseSha;

    const result = await validateCommittedEvidencePreflight({
      bundle,
      projectPath: fixture.root,
      headSha: fixture.baseSha,
      subtaskId: 'st-api',
    });

    expect(result.accepted).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'head_mismatch',
      'changed_file_not_in_diff',
    ]));
  });

  it('rejects changed files that are not part of the committed workflow diff', async () => {
    const fixture = await createFixture();
    const bundle = buildBundle(fixture);
    bundle.evidence[0].payload = {
      observedChangedFiles: [{ path: 'src/test/java/example/ExampleTest.java', changeType: 'modified' }],
    };

    const result = await validateCommittedEvidencePreflight({
      bundle,
      projectPath: fixture.root,
      headSha: fixture.headSha,
      subtaskId: 'st-api',
    });

    expect(result.accepted).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'changed_file_not_in_diff' }),
    ]));
  });

  it('rejects Maven selectors that can empty-run or do not exist at the reviewed commit', async () => {
    const fixture = await createFixture();
    const result = await validateCommittedEvidencePreflight({
      bundle: buildBundle(fixture),
      projectPath: fixture.root,
      headSha: fixture.headSha,
      subtaskId: 'st-api',
      validationCommands: ['mvn test -Dtest=MissingTest -Dsurefire.failIfNoSpecifiedTests=false'],
    });

    expect(result.accepted).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'non_strict_test_selector',
      'test_selector_not_found',
    ]));
  });

  it('accepts review evidence for a review workflow without implementation evidence', async () => {
    const fixture = await createFixture();
    const bundle = buildBundle(fixture);
    bundle.workflow.mode = 'review';
    bundle.taskGraph!.subtasks = [{
      id: 'st-api',
      title: 'API review',
      goal: 'Review the API change',
      kind: 'review',
      assignedReviewer: 'codex',
      dependsOn: [],
      allowedPaths: ['src/main/java/example/**'],
      blockedPaths: [],
      acceptanceCriteria: [],
      verificationCommands: [],
    }];
    bundle.evidence = [{
      id: 'ev-review',
      workflowId: 'wf-preflight',
      subtaskId: 'st-api',
      kind: 'review',
      title: 'Readonly review',
      headSha: fixture.headSha,
      payload: { reviewScope: ['src/main/java/example/Example.java'] },
      createdAt: '2026-07-13T00:00:00.000Z',
    }];

    const result = await validateCommittedEvidencePreflight({
      bundle,
      projectPath: fixture.root,
      headSha: fixture.headSha,
      subtaskId: 'st-api',
    });

    expect(result).toEqual({ accepted: true, issues: [] });
  });

  it('rejects evidence that omits a committed file in the evaluated scope', async () => {
    const fixture = await createFixture({ secondChangedFile: true });
    const result = await validateCommittedEvidencePreflight({
      bundle: buildBundle(fixture),
      projectPath: fixture.root,
      headSha: fixture.headSha,
      subtaskId: 'st-api',
    });

    expect(result.accepted).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'changed_files_mismatch',
      message: expect.stringContaining('src/main/java/example/Second.java'),
    }));
  });
});

async function createFixture(options: { secondChangedFile?: boolean } = {}): Promise<{ root: string; baseSha: string; headSha: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-committed-evidence-preflight-'));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, 'src/main/java/example'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/test/java/example'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), '.tik/\n', 'utf-8');
  await fs.writeFile(path.join(root, 'src/main/java/example/Example.java'), 'package example; class Example { int value = 1; }\n', 'utf-8');
  await fs.writeFile(path.join(root, 'src/test/java/example/ExampleTest.java'), 'package example; class ExampleTest {}\n', 'utf-8');
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Tik Test'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
  const baseSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await fs.writeFile(path.join(root, 'src/main/java/example/Example.java'), 'package example; class Example { int value = 2; }\n', 'utf-8');
  if (options.secondChangedFile) {
    await fs.writeFile(path.join(root, 'src/main/java/example/Second.java'), 'package example; class Second {}\n', 'utf-8');
  }
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'implementation'], { cwd: root });
  const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  return { root, baseSha, headSha };
}

function buildBundle(fixture: { baseSha: string; headSha: string }): MultiAgentWorkflowBundle {
  return {
    workflow: {
      id: 'wf-preflight',
      baseRef: fixture.baseSha,
      currentHeadSha: fixture.headSha,
    },
    taskGraph: {
      finalValidationCommands: [],
    },
    contracts: [],
    evidence: [{
      id: 'ev-implementation',
      workflowId: 'wf-preflight',
      subtaskId: 'st-api',
      kind: 'implementation',
      title: 'Implementation',
      headSha: fixture.headSha,
      payload: {
        observedChangedFiles: [{ path: 'src/main/java/example/Example.java', changeType: 'modified' }],
      },
      createdAt: '2026-07-13T00:00:00.000Z',
    }],
  } as MultiAgentWorkflowBundle;
}
