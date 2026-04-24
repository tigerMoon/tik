import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceSuperpowersClarifier } from '../src/workspace-superpowers-clarifier.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

async function createSkillRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-clarifier-skills-'));
  tempDirs.push(root);
  const deepInterviewDir = path.join(root, 'deep-interview');
  const ralplanDir = path.join(root, 'ralplan');
  await fs.mkdir(deepInterviewDir, { recursive: true });
  await fs.mkdir(ralplanDir, { recursive: true });
  await fs.writeFile(path.join(deepInterviewDir, 'SKILL.md'), [
    '---',
    'name: deep-interview',
    'description: "Socratic ambiguity clarifier"',
    '---',
    '# Deep Interview',
    'Ask one high-leverage question before proceeding.',
  ].join('\n'));
  await fs.writeFile(path.join(ralplanDir, 'SKILL.md'), [
    '---',
    'name: ralplan',
    'description: "Consensus planning for multiple approaches"',
    '---',
    '# Ralplan',
    'Compare viable approaches and recommend one.',
  ].join('\n'));
  return root;
}

describe('WorkspaceSuperpowersClarifier', () => {
  it('skips clarification for concrete demands with high execution confidence', async () => {
    const skillRoot = await createSkillRoot();
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-clarifier-project-'));
    tempDirs.push(projectPath);
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'test'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'greet.js'), 'export function greet(name) { return name; }\n', 'utf-8');
    await fs.writeFile(path.join(projectPath, 'test', 'greet.test.js'), 'import { greet } from "../src/greet.js";\n', 'utf-8');

    const clarifier = new WorkspaceSuperpowersClarifier({ superpowersRoot: skillRoot });
    const result = await clarifier.clarify({
      projectName: 'demo-service',
      projectPath,
      phase: 'PARALLEL_CLARIFY',
      workflowProfile: 'fast-feedback',
      demand: '在 src/greet.js 中让 greet(name) 对空字符串和空白字符串回退为 Guest，并补齐 test/greet.test.js',
      specExcerpt: [
        '修改 src/greet.js 中的 greet(name)',
        '验证 test/greet.test.js 覆盖空字符串和空白字符串',
      ].join('\n'),
    }, '2026-04-07T10:00:00.000Z');

    expect(result.needsClarification).toBe(false);
    expect(result.category).toBe('skip');
    expect(result.confidence).toBe('high');
    expect(result.decision).toBeUndefined();
    expect(result.summary).toContain('Clarification skipped');
    expect(result.artifactBody).toContain('Needs Human Decision: no');
  });

  it('uses deep-interview for scope ambiguity and emits a clarify decision', async () => {
    const skillRoot = await createSkillRoot();
    const clarifier = new WorkspaceSuperpowersClarifier({ superpowersRoot: skillRoot });
    const result = await clarifier.clarify({
      projectName: 'service-a',
      projectPath: '/repo/service-a',
      phase: 'PARALLEL_CLARIFY',
      workflowProfile: 'balanced',
      demand: '不要假设，先澄清 service-a 和 service-b 谁负责接口改造',
      splitReason: 'Multiple project tokens matched in demand.',
      summary: 'Need to resolve ownership before continuing.',
    }, '2026-04-07T10:00:00.000Z');

    expect(result.needsClarification).toBe(true);
    expect(result.method).toBe('deep-interview');
    expect(result.category).not.toBe('skip');
    expect(result.skillPath).toContain('/deep-interview/SKILL.md');
    expect(result.decision).toMatchObject({
      kind: 'clarification',
      phase: 'PARALLEL_CLARIFY',
      projectName: 'service-a',
      confidence: result.confidence,
    });
    expect(result.decision?.options?.[0]?.nextPhase).toBe('PARALLEL_SPECIFY');
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/clarify-method:deep-interview/),
    ]));
  });

  it('keeps generic clarification decisions aligned with the clarification artifact semantics', async () => {
    const skillRoot = await createSkillRoot();
    const clarifier = new WorkspaceSuperpowersClarifier({ superpowersRoot: skillRoot });
    const result = await clarifier.clarify({
      projectName: 'demo-service',
      projectPath: '/repo/demo-service',
      phase: 'PARALLEL_CLARIFY',
      workflowProfile: 'balanced',
      demand: '不要假设，先澄清这个需求具体要改哪些行为再继续',
      summary: 'The current requirement is too vague to proceed safely.',
    }, '2026-04-07T10:00:00.000Z');

    expect(result.category).toBe('generic');
    expect(result.decision).toMatchObject({
      kind: 'clarification',
      title: 'Clarify demo-service',
      prompt: 'Tik needs a freeform clarification for demo-service before continuing to specify.',
      confidence: 'low',
    });
    expect(result.decision?.options).toEqual([
      expect.objectContaining({
        id: 'clarify-and-continue',
        label: 'Clarify and continue to specify',
        description: 'Provide the missing clarification for demo-service, then continue to specify.',
        nextPhase: 'PARALLEL_SPECIFY',
        recommended: true,
      }),
    ]);
  });

  it('uses ralplan for approach ambiguity and preserves clarify-first reroute semantics', async () => {
    const skillRoot = await createSkillRoot();
    const clarifier = new WorkspaceSuperpowersClarifier({ superpowersRoot: skillRoot });
    const result = await clarifier.clarify({
      projectName: 'service-a',
      projectPath: '/repo/service-a',
      phase: 'PARALLEL_CLARIFY',
      workflowProfile: 'deep-verify',
      demand: [
        '方案A: 保留 DB 查询并加缓存',
        '方案B: 改为外部 API 并补齐契约测试',
        '需要做技术取舍后再继续',
      ].join('\n'),
    }, '2026-04-07T10:00:00.000Z');

    expect(result.needsClarification).toBe(true);
    expect(result.category).toBe('approach');
    expect(result.method).toBe('ralplan');
    expect(result.skillDescription).toBe('Consensus planning for multiple approaches');
    expect(result.decision?.phase).toBe('PARALLEL_CLARIFY');
    expect(result.decision?.options?.[0]?.nextPhase).toBe('PARALLEL_SPECIFY');
    expect(result.artifactBody).toContain('Method: ralplan');
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/clarify-method:ralplan/),
    ]));
  });
});
