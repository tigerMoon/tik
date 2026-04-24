import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderRuntimeEvent, WorkflowSubtaskSpec } from '@tik/shared';
import {
  WorkflowSkillExecutorRegistry,
  type WorkflowSkillExecutionOutcome,
  type WorkflowSkillExecutionRequest,
} from './workflow-skill-executor.js';
import {
  LocalWorkflowSkillRuntimeAdapter,
  type WorkflowSkillRuntimeAdapter,
  type WorkflowSkillRuntimeContext,
} from './workflow-skill-runtime.js';

export interface WorkspaceSkillCompletionAdapter {
  complete(
    projectPath: string,
    prompt: string,
    options?: {
      onProviderEvent?: (event: ProviderRuntimeEvent) => void;
    },
  ): Promise<{ content: string; executionMode: 'native' }>;
}

export interface WorkspaceSkillExecutorFactoryOptions {
  completion: WorkspaceSkillCompletionAdapter;
  skillRuntime?: WorkflowSkillRuntimeAdapter;
}

export function createWorkspaceSkillExecutorRegistry(
  options: WorkspaceSkillExecutorFactoryOptions,
): WorkflowSkillExecutorRegistry {
  const registry = new WorkflowSkillExecutorRegistry();
  const skillRuntime = options.skillRuntime ?? new LocalWorkflowSkillRuntimeAdapter();

  registry.register('SPECIFY_SUBTASK', async ({ spec, subtask, onProviderEvent }: WorkflowSkillExecutionRequest) => {
    const result = await materializeWorkspaceSpec(spec, subtask.summary, options.completion, skillRuntime, onProviderEvent);
    return {
      summary: subtask.summary || result.summary,
      outputPath: result.outputPath,
      status: 'completed' as const,
      executionMode: result.executionMode,
    };
  });

  registry.register('PLAN_SUBTASK', async ({ spec, subtask, onProviderEvent }: WorkflowSkillExecutionRequest) => {
    const result = await materializeWorkspacePlan(spec, subtask.summary, options.completion, skillRuntime, onProviderEvent);
    return {
      summary: subtask.summary || result.summary,
      outputPath: result.outputPath,
      valid: await isWorkspacePlanValid(result.outputPath),
      status: 'completed' as const,
      executionMode: result.executionMode,
    };
  });

  registry.register('ACE_SUBTASK', async ({ spec, subtask }: WorkflowSkillExecutionRequest): Promise<WorkflowSkillExecutionOutcome> => {
    return {
      summary: subtask.summary,
      status: subtask.status === 'failed'
        ? 'failed'
        : subtask.status === 'cancelled'
          ? 'blocked'
          : 'completed',
    };
  });

  return registry;
}

async function materializeWorkspaceSpec(
  spec: WorkflowSubtaskSpec,
  summary: string,
  completion: WorkspaceSkillCompletionAdapter,
  skillRuntime: WorkflowSkillRuntimeAdapter,
  onProviderEvent?: (event: ProviderRuntimeEvent) => void,
): Promise<{ outputPath: string; summary: string; executionMode: 'native' }> {
  const specPath = spec.inputs.targetSpecPath || path.join(spec.projectPath, '.specify', 'specs', 'spec.md');
  const specDir = path.dirname(specPath);
  await fs.mkdir(specDir, { recursive: true });
  const skill = await skillRuntime.load(spec);
  const completionResult = await completion.complete(spec.projectPath, buildSkillBoundPrompt(skill, [
    'Return ONLY the final markdown body for the target spec document.',
    `Target spec path: ${specPath}`,
    `Project: ${spec.projectPath}`,
    `Demand: ${spec.inputs.demand}`,
    'Include sections: Goal, Scope, In Scope, Out of Scope, API/Contract Impact, Risks, Acceptance Criteria.',
    'Be concrete and implementation-oriented.',
    'Do not create or modify files yourself.',
    'Do not include progress narration, tool narration, or post-hoc summary outside the document body.',
  ].join('\n')), { onProviderEvent });
  const content = completionResult.content;
  await fs.writeFile(specPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  return {
    outputPath: specPath,
    summary: summary || 'Generated workspace spec draft.',
    executionMode: completionResult.executionMode,
  };
}

async function materializeWorkspacePlan(
  spec: WorkflowSubtaskSpec,
  summary: string,
  completion: WorkspaceSkillCompletionAdapter,
  skillRuntime: WorkflowSkillRuntimeAdapter,
  onProviderEvent?: (event: ProviderRuntimeEvent) => void,
): Promise<{ outputPath: string; summary: string; executionMode: 'native' }> {
  const planPath = spec.inputs.targetPlanPath || path.join(spec.projectPath, '.specify', 'specs', 'plan.md');
  const planDir = path.dirname(planPath);
  await fs.mkdir(planDir, { recursive: true });
  const specPath = spec.inputs.resolvedSpecPath || path.join(planDir, 'spec.md');
  const specContent = spec.inputs.specContent || await safeReadFile(specPath);
  const skill = await skillRuntime.load(spec);
  const completionResult = await completion.complete(spec.projectPath, buildSkillBoundPrompt(skill, [
    'Return ONLY the final markdown body for the target plan document.',
    `Resolved spec path: ${specPath}`,
    `Target plan path: ${planPath}`,
    `Project: ${spec.projectPath}`,
    `Demand: ${spec.inputs.demand}`,
    specContent ? `Spec:\n${specContent.slice(0, 12000)}` : 'Spec: (missing)',
    'Include sections: Architecture Changes, Implementation Steps, Validation, Risks, Rollout Notes.',
    'Avoid placeholders and template wording.',
    'Do not create or modify files yourself.',
    'Do not include progress narration, tool narration, or post-hoc summary outside the document body.',
  ].join('\n\n')), { onProviderEvent });
  const content = completionResult.content;
  await fs.writeFile(planPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  return {
    outputPath: planPath,
    summary: summary || 'Generated workspace plan draft.',
    executionMode: completionResult.executionMode,
  };
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function buildSkillBoundPrompt(
  skill: WorkflowSkillRuntimeContext,
  taskPrompt: string,
): string {
  return [
    'Skill Runtime Binding:',
    `- Skill: ${skill.skillName}`,
    `- Skill path: ${skill.skillPath}`,
    skill.description ? `- Skill description: ${skill.description}` : '',
    '',
    'Use the bound skill semantics for this workspace phase, but do not re-enact repository side effects described by the original skill (for example branch creation or direct file placement decisions outside the target artifact).',
    'Focus on producing the target artifact content that Tik will materialize.',
    '',
    'Workspace phase execution task:',
    taskPrompt,
  ].filter(Boolean).join('\n');
}

export async function isWorkspacePlanValid(planPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(planPath, 'utf-8');
    const templateMarkers = [
      '[FEATURE]',
      '[DATE]',
      'ACTION REQUIRED',
      'NEEDS CLARIFICATION',
      'src/models/services/controllers',
      'TODO',
      'TBD',
    ];
    const lowered = content.toLowerCase();
    if (content.trim().length < 160) return false;
    return !templateMarkers.some((marker) => lowered.includes(marker.toLowerCase()));
  } catch {
    return false;
  }
}
