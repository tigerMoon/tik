import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatResponse, ILLMProvider } from '@tik/shared';
import { AgentRuntime } from '../src/agent/agent-runtime.js';
import { BUILTIN_AGENTS } from '../src/agent/builtin-agents.js';
import { LocalAgentSkillPromptSource } from '../src/agent/agent-skill-prompt-source.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createMockLLM(onPrompt: (prompt: string) => void): ILLMProvider {
  return {
    name: 'mock',
    async chatWithContext(_messages, systemPrompt): Promise<ChatResponse> {
      onPrompt(systemPrompt);
      return {
        content: 'ok',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
    async chat(): Promise<ChatResponse> {
      throw new Error('not used');
    },
    async plan() {
      throw new Error('not used');
    },
    async complete() {
      throw new Error('not used');
    },
  };
}

describe('agent installed skill prompt support', () => {
  it('frontend-coder is configured to use the external frontend-dev skill', () => {
    const frontendCoder = BUILTIN_AGENTS.find((spec) => spec.id === 'frontend-coder');
    expect(frontendCoder).toBeDefined();
    expect(frontendCoder?.skillName).toBe('frontend-dev');
    expect(frontendCoder?.skillOptional).toBe(true);
  });

  it('loads an installed skill prompt and appends it to the agent instructions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-agent-installed-skill-'));
    tempDirs.push(root);
    const agentSkillsRoot = path.join(root, '.agents', 'skills');
    const skillDir = path.join(agentSkillsRoot, 'frontend-dev');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: frontend-dev',
      'description: "Frontend delivery checklist"',
      '---',
      '# Frontend Dev',
      'Always run browser validation before claiming the page is done.',
      'Use frontend_browser_screenshot for before/after review artifacts.',
    ].join('\n'));

    const spec = BUILTIN_AGENTS.find((item) => item.id === 'frontend-coder');
    expect(spec).toBeDefined();

    let seenPrompt = '';
    const runtime = new AgentRuntime(
      spec!,
      createMockLLM((prompt) => { seenPrompt = prompt; }),
      {
        skillPromptSource: new LocalAgentSkillPromptSource({ agentSkillsRoot }),
      },
    );

    await runtime.runTurn({
      messages: [{ role: 'user', content: '实现营销页首屏动效和样式修复' }],
      context: 'frontend context',
    });

    expect(seenPrompt).toContain('Use frontend_browser_screenshot');
    expect(seenPrompt).toContain('Frontend delivery checklist');
    expect(seenPrompt).toContain('Installed skill overlay');
  });

  it('falls back to base instructions when an optional installed skill is missing', async () => {
    const spec = BUILTIN_AGENTS.find((item) => item.id === 'frontend-coder');
    expect(spec).toBeDefined();

    let seenPrompt = '';
    const runtime = new AgentRuntime(
      spec!,
      createMockLLM((prompt) => { seenPrompt = prompt; }),
      {
        skillPromptSource: new LocalAgentSkillPromptSource({
          agentSkillsRoot: '/definitely/missing/skills-root',
        }),
      },
    );

    await runtime.runTurn({
      messages: [{ role: 'user', content: '实现营销页首屏动效和样式修复' }],
      context: 'frontend context',
    });

    expect(seenPrompt).toContain('You are the Frontend Coder agent in a coding system.');
    expect(seenPrompt).not.toContain('Installed skill overlay');
  });
});
