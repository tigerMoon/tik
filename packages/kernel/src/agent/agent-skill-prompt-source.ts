import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSkillDescription } from '../workflow-skill-runtime.js';

export interface AgentInstalledSkillConfig {
  skillName?: string;
  skillPath?: string;
}

export interface AgentInstalledSkillPrompt {
  skillName: string;
  skillPath: string;
  description?: string;
  prompt: string;
}

export interface AgentInstalledSkillPromptSource {
  load(config: AgentInstalledSkillConfig): Promise<AgentInstalledSkillPrompt>;
}

export class LocalAgentSkillPromptSource implements AgentInstalledSkillPromptSource {
  constructor(
    private readonly options: {
      codexHome?: string;
      agentSkillsRoot?: string;
    } = {},
  ) {}

  async load(config: AgentInstalledSkillConfig): Promise<AgentInstalledSkillPrompt> {
    const skillPath = await this.resolveSkillPath(config);
    const prompt = await fs.readFile(skillPath, 'utf-8');
    const skillName = config.skillName?.trim() || path.basename(path.dirname(skillPath));
    return {
      skillName,
      skillPath,
      description: parseSkillDescription(prompt),
      prompt,
    };
  }

  private async resolveSkillPath(config: AgentInstalledSkillConfig): Promise<string> {
    const requestedName = config.skillName?.trim().replace(/^[/$]+/, '');
    const explicit = config.skillPath?.trim();

    if (explicit) {
      try {
        await fs.access(explicit);
        return explicit;
      } catch {
        // fall through to skill-root resolution
      }
    }

    if (!requestedName) {
      throw new Error('Agent installed skill config requires skillName or skillPath');
    }

    const candidates: string[] = [];
    candidates.push(this.options.agentSkillsRoot ?? path.join(os.homedir(), '.agents', 'skills'));
    if (this.options.codexHome ?? process.env.CODEX_HOME) {
      candidates.push(path.join(this.options.codexHome ?? process.env.CODEX_HOME!, 'skills'));
    }
    if (explicit) {
      candidates.push(path.join(path.dirname(explicit), '..'));
    }

    for (const root of candidates) {
      const direct = path.join(root, requestedName, 'SKILL.md');
      try {
        await fs.access(direct);
        return direct;
      } catch {
        // continue
      }
    }

    throw new Error(`Unable to resolve installed agent skill prompt for ${requestedName}`);
  }
}
