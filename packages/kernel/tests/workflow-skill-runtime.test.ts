import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkflowSkillDelegatedDescription,
  LocalWorkflowSkillRuntimeAdapter,
  materializeWorkflowSkillDelegatedSpec,
  parseSkillDescription,
} from '../src/workflow-skill-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

describe('workflow skill runtime adapter', () => {
  it('parses description from SKILL frontmatter lines', () => {
    const description = parseSkillDescription([
      '---',
      'name: test-skill',
      'description: "Test skill description"',
      '---',
      '# Body',
    ].join('\n'));

    expect(description).toBe('Test skill description');
  });

  it('loads a local skill prompt from explicit skillPath', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-skill-runtime-'));
    tempDirs.push(root);
    const skillDir = path.join(root, 'sdd-specify');
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, [
      '---',
      'name: sdd-specify',
      'description: "Generate a spec"',
      '---',
      '# SDD Specify',
      'Use this skill to write spec.md',
    ].join('\n'));

    const adapter = new LocalWorkflowSkillRuntimeAdapter();
    const result = await adapter.load({
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_SPECIFY',
      contract: 'SPECIFY_SUBTASK',
      skillName: 'sdd-specify',
      skillPath,
      description: 'specify',
      inputs: {
        demand: '给 service-a 增加缓存',
      },
    });

    expect(result.skillPath).toBe(skillPath);
    expect(result.description).toBe('Generate a spec');
    expect(result.prompt).toContain('Use this skill to write spec.md');
  });

  it('falls back to ~/.agents/skills-style root when explicit skillPath is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-agent-skills-'));
    tempDirs.push(root);
    const agentSkillsRoot = path.join(root, '.agents', 'skills');
    const skillDir = path.join(agentSkillsRoot, 'sdd-specify');
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, [
      '---',
      'name: sdd-specify',
      'description: "Home installed skill"',
      '---',
      '# SDD Specify',
      'Prefer installed skill source.',
    ].join('\n'));

    const adapter = new LocalWorkflowSkillRuntimeAdapter({
      agentSkillsRoot,
    });
    const result = await adapter.load({
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_SPECIFY',
      contract: 'SPECIFY_SUBTASK',
      skillName: 'sdd-specify',
      skillPath: '/missing/sdd-specify/SKILL.md',
      description: 'specify',
      inputs: {
        demand: '给 service-a 增加缓存',
      },
    });

    expect(result.skillPath).toBe(skillPath);
    expect(result.description).toBe('Home installed skill');
    expect(result.prompt).toContain('Prefer installed skill source.');
  });

  it('loads a superpowers skill from CODEX_HOME skills when source kind is superpowers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-codex-skills-'));
    tempDirs.push(root);
    const codexSkillsRoot = path.join(root, 'skills');
    const skillDir = path.join(codexSkillsRoot, 'deep-interview');
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, [
      '---',
      'name: deep-interview',
      'description: "Clarify with Socratic pressure"',
      '---',
      '# Deep Interview',
      'Ask one high-leverage question.',
    ].join('\n'));

    const adapter = new LocalWorkflowSkillRuntimeAdapter({
      codexHome: root,
    });
    const result = await adapter.load({
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_CLARIFY',
      contract: 'CLARIFY_SUBTASK',
      skillName: 'superpowers-clarify',
      skillSourceKind: 'superpowers',
      skillPath: skillPath,
      description: 'clarify',
      inputs: {
        demand: '不要假设，先澄清需求范围',
      },
    } as any);

    expect(result.skillSourceKind).toBe('superpowers');
    expect(result.skillPath).toBe(skillPath);
    expect(result.description).toBe('Clarify with Socratic pressure');
  });

  it('materializes a delegated subtask description that embeds the bound skill instructions', async () => {
    const spec = {
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_SPECIFY',
      contract: 'SPECIFY_SUBTASK',
      skillName: 'sdd-specify',
      skillPath: '/tmp/sdd-specify/SKILL.md',
      description: 'Generate a project spec for service-a.',
      inputs: {
        demand: '给 service-a 增加缓存',
      },
    } as const;
    const delegated = buildWorkflowSkillDelegatedDescription(spec as any, {
      skillName: 'sdd-specify',
      skillPath: '/tmp/sdd-specify/SKILL.md',
      description: 'Generate a spec',
      prompt: [
        '# Skill Body',
        '1. 调用 MCP 工具 `aiops-sdd-specify`，参数:',
        '   - featureDescription: xxx',
        '2. 工具会自动:',
        '   - 创建 Git 分支 `{number}-{short-name}`',
        'Write spec.md',
      ].join('\n'),
    });

    expect(delegated).toContain('Workflow skill delegated subtask.');
    expect(delegated).toContain('Generate a project spec for service-a.');
    expect(delegated).toContain('# Workspace Delegated Native Mode');
    expect(delegated).toContain('Treat the Target spec path in the phase task as authoritative');
    expect(delegated).toContain('MCP mode is disabled for this delegated subtask.');
    expect(delegated).not.toContain('调用 MCP 工具 `aiops-sdd-specify`');
    expect(delegated).not.toContain('创建 Git 分支');
  });

  it('materializes delegated specs through the runtime adapter', async () => {
    const spec = {
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_PLAN',
      contract: 'PLAN_SUBTASK',
      skillName: 'sdd-plan',
      skillPath: '/tmp/sdd-plan/SKILL.md',
      description: 'Generate plan.',
      inputs: {
        demand: '给 service-a 增加缓存',
      },
    } as any;

    const materialized = await materializeWorkflowSkillDelegatedSpec(spec, {
      load: async () => ({
        skillName: 'sdd-plan',
        skillPath: '/tmp/sdd-plan/SKILL.md',
        description: 'Generate a plan',
        prompt: '# Skill Plan\nProduce plan.md',
      }),
    });

    expect(materialized.description).toContain('Generate plan.');
    expect(materialized.description).toContain('# Workspace Delegated Native Mode');
    expect(materialized.description).toContain('Target plan path');
    expect(materialized.description).toContain('MCP mode is disabled for this delegated subtask.');
    expect(materialized.description).not.toContain('调用 MCP 工具 `aiops-sdd-plan`');
    expect(materialized.metadata).toMatchObject({
      delegatedSkillName: 'sdd-plan',
      delegatedSkillPath: '/tmp/sdd-plan/SKILL.md',
    });
  });
});
