import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkflowSkillName, WorkflowSkillSourceKind, WorkflowSubtaskSpec } from '@tik/shared';

export interface WorkflowSkillRuntimeContext {
  skillName: WorkflowSkillName;
  skillSourceKind?: WorkflowSkillSourceKind;
  skillPath: string;
  description?: string;
  prompt: string;
}

export interface WorkflowSkillRuntimeAdapter {
  load(spec: WorkflowSubtaskSpec): Promise<WorkflowSkillRuntimeContext>;
}

export class LocalWorkflowSkillRuntimeAdapter implements WorkflowSkillRuntimeAdapter {
  constructor(
    private readonly options: {
      codexHome?: string;
      agentSkillsRoot?: string;
    } = {},
  ) {}

  async load(spec: WorkflowSubtaskSpec): Promise<WorkflowSkillRuntimeContext> {
    const skillPath = await this.resolveSkillPath(spec);
    const prompt = await fs.readFile(skillPath, 'utf-8');
    return {
      skillName: spec.skillName,
      skillSourceKind: spec.skillSourceKind,
      skillPath,
      description: parseSkillDescription(prompt),
      prompt,
    };
  }

  private async resolveSkillPath(spec: WorkflowSubtaskSpec): Promise<string> {
    const explicit = spec.skillPath;
    try {
      await fs.access(explicit);
      return explicit;
    } catch {
      // fall through to local resolution
    }

    const requested = spec.skillName.trim().replace(/^[/$]+/, '');
    const candidates: string[] = [];
    if (spec.skillSourceKind === 'superpowers') {
      candidates.push(path.join(this.options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'skills'));
    } else {
      candidates.push(this.options.agentSkillsRoot ?? path.join(os.homedir(), '.agents', 'skills'));
    }
    if (this.options.codexHome ?? process.env.CODEX_HOME) {
      candidates.push(path.join(this.options.codexHome ?? process.env.CODEX_HOME!, 'skills'));
    }
    candidates.push(path.join(path.dirname(explicit), '..'));

    for (const root of candidates) {
      const direct = path.join(root, requested, 'SKILL.md');
      try {
        await fs.access(direct);
        return direct;
      } catch {
        // continue
      }

      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (!entry.name.localeCompare(requested, undefined, { sensitivity: 'accent' })) {
            const match = path.join(root, entry.name, 'SKILL.md');
            try {
              await fs.access(match);
              return match;
            } catch {
              // continue
            }
          }
        }
      } catch {
        // ignore missing roots
      }
    }

    throw new Error(`Unable to resolve workflow skill runtime path for ${spec.skillName}`);
  }
}

export function buildWorkflowSkillDelegatedDescription(
  spec: WorkflowSubtaskSpec,
  skill: WorkflowSkillRuntimeContext,
): string {
  const adaptedPrompt = adaptWorkflowSkillPromptForDelegation(spec, skill);
  return [
    'Workflow skill delegated subtask.',
    '',
    'Bound skill:',
    `- Skill: ${skill.skillName}`,
    `- Skill path: ${skill.skillPath}`,
    ...(skill.skillSourceKind ? [`- Skill source: ${skill.skillSourceKind}`] : []),
    ...(skill.description ? [`- Skill description: ${skill.description}`] : []),
    '',
    'Execution contract:',
    '- Treat the bound skill as the primary execution workflow for this subtask.',
    '- Follow the skill instructions directly instead of replacing them with a simplified summary.',
    '- Respect the explicit project path and phase contract supplied below.',
    '- Produce concrete project-local outputs and evidence, not just analysis.',
    '',
    'Phase task:',
    spec.description,
    '',
    'Bound skill instructions:',
    adaptedPrompt,
  ].join('\n');
}

export async function materializeWorkflowSkillDelegatedSpec(
  spec: WorkflowSubtaskSpec,
  runtime: WorkflowSkillRuntimeAdapter,
): Promise<WorkflowSubtaskSpec> {
  const skill = await runtime.load(spec);
  return {
    ...spec,
    description: buildWorkflowSkillDelegatedDescription(spec, skill),
    metadata: {
      ...(spec.metadata || {}),
      delegatedSkillName: skill.skillName,
      delegatedSkillSourceKind: skill.skillSourceKind,
      delegatedSkillPath: skill.skillPath,
      delegatedSkillDescription: skill.description,
    },
  };
}

export function parseSkillDescription(contents: string): string | undefined {
  for (const line of contents.split('\n')) {
    const value = line.trim();
    if (!value.startsWith('description:')) continue;
    const description = value.slice('description:'.length).trim().replace(/^"+|"+$/g, '');
    if (description) return description;
  }
  return undefined;
}

function adaptWorkflowSkillPromptForDelegation(
  spec: WorkflowSubtaskSpec,
  skill: WorkflowSkillRuntimeContext,
): string {
  if (skill.skillName === 'sdd-specify') {
    return buildNativeSpecifyDelegationPrompt(spec, skill.prompt);
  }
  if (skill.skillName === 'sdd-plan') {
    return buildNativePlanDelegationPrompt(spec, skill.prompt);
  }
  return skill.prompt;
}

function buildNativeSpecifyDelegationPrompt(
  spec: WorkflowSubtaskSpec,
  _prompt: string,
): string {
  return [
    '# Workspace Delegated Native Mode',
    '',
    '- This installed skill source has been loaded into Tik from ~/.agents/skills.',
    '- MCP mode is disabled for this delegated subtask. Do not call aiops-sdd-specify or any other aiops-* tool.',
    '- Use only the native Codex tools already available in this subtask to inspect the minimum relevant project context and write the target spec artifact.',
    '- Do not create Git branches, allocate feature numbers, or rely on branch-derived side effects to choose the output directory.',
    '- Treat the Target spec path in the phase task as authoritative. Create parent directories if needed, then create or update exactly that file.',
    '- Do not write to a generic `.specify/specs/spec.md` path or any historical feature directory unless the phase task points there explicitly.',
    '- Read only the minimum files needed to understand the demand and current architecture. Avoid broad repository exploration.',
    '',
    'Required output shape:',
    '- Write a concrete spec that is ready for downstream plan generation.',
    '- Include Goal, Scope, In Scope, Out of Scope, API/Contract Impact, Risks, and Acceptance Criteria.',
    '- If the exact target spec already exists and already matches the demand, confirm it with file-based evidence instead of rewriting it.',
    '- Finish only when the exact target spec path exists on disk or you can state a concrete blocker.',
    '',
    `Delegated demand: ${spec.inputs.demand}`,
  ].join('\n');
}

function buildNativePlanDelegationPrompt(
  spec: WorkflowSubtaskSpec,
  _prompt: string,
): string {
  return [
    '# Workspace Delegated Native Mode',
    '',
    '- This installed skill source has been loaded into Tik from ~/.agents/skills.',
    '- MCP mode is disabled for this delegated subtask. Do not call aiops-sdd-plan or any other aiops-* tool.',
    '- Use only the native Codex tools already available in this subtask to inspect the repository, read the resolved spec, and write the target plan artifact.',
    '- Treat the Resolved spec path and Target plan path in the phase task as authoritative. Create parent directories if needed, then create or update exactly that file.',
    '- Do not write to a generic `.specify/specs/plan.md` path or any historical feature directory unless the phase task points there explicitly.',
    '- Read only the minimum project files needed to turn the spec into a real executable plan.',
    '',
    'Required output shape:',
    '- The plan must include real architecture changes, implementation steps, validation, risks, and rollout notes.',
    '- The plan must not contain placeholders such as [FEATURE], [DATE], ACTION REQUIRED, NEEDS CLARIFICATION, TODO, or TBD.',
    '- If the first draft still looks templated, keep refining until the exact target plan path contains a concrete, executable plan.',
    '- Finish only when the exact target plan path exists on disk and passes the plan quality gate, or you can state a concrete blocker.',
    '',
    `Delegated demand: ${spec.inputs.demand}`,
  ].join('\n');
}
