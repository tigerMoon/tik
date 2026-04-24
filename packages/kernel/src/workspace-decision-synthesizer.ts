import * as path from 'node:path';
import type {
  WorkspaceDecisionConfidence,
  WorkspaceDecisionOption,
  WorkspaceDecisionPhase,
  WorkspaceDecisionRequest,
  WorkspaceProjectState,
  WorkspaceWorkflowPolicyProfile,
  WorkflowAgentRole,
  WorkflowSubtaskContract,
  WorkflowSkillName,
} from '@tik/shared';
import { generateId } from '@tik/shared';

export interface WorkspaceDecisionSynthesisInput {
  projectName: string;
  phase: WorkspaceDecisionPhase;
  blockerKind?: WorkspaceProjectState['blockerKind'];
  summary?: string;
  demand?: string;
  workflowContract?: WorkflowSubtaskContract;
  workflowRole?: WorkflowAgentRole;
  workflowSkillName?: WorkflowSkillName;
  specPath?: string;
  planPath?: string;
  workflowProfile?: WorkspaceWorkflowPolicyProfile;
  recentProjectEvents?: string[];
  recentWorkspaceEvents?: string[];
  projectKnownArtifacts?: string[];
  sessionNextAction?: string;
  specExcerpt?: string;
  planExcerpt?: string;
}

export function synthesizeWorkspaceDecision(
  input: WorkspaceDecisionSynthesisInput,
  now: string,
): WorkspaceDecisionRequest {
  const summary = input.summary?.trim();
  const semanticContext = buildSemanticContext(input);
  const artifactOptions = extractArtifactOptions(summary, input.phase);
  if (artifactOptions.length > 0) {
    const artifactKind = artifactOptions[0]?.artifactField === 'planPath' ? 'feature plans' : 'feature specs';
    return buildDecision(now, input, {
      kind: 'approach_choice',
      title: `Choose a ${phaseLabel(input.phase)} target for ${input.projectName}`,
      prompt: buildPrompt(
        `Tik found multiple candidate ${artifactKind} for ${input.projectName}. Choose one artifact before rerunning ${phaseLabel(input.phase)}.`,
        semanticContext,
      ),
      options: artifactOptions,
      recommendedOptionId: artifactOptions.find((option) => option.recommended)?.id,
      allowFreeform: true,
      confidence: 'high',
      rationale: buildRationale(
        'The blocker included multiple concrete artifact paths, so the safest recovery path is to pin one artifact explicitly before continuing.',
        semanticContext,
      ),
      signals: mergeSignals(semanticContext.signals, [
        `artifact-options:${artifactOptions.length}`,
        `artifact-field:${artifactOptions[0]?.artifactField || 'unknown'}`,
      ]),
      sourceSummary: summary,
    });
  }

  const approachOptions = extractApproachOptions(summary, input.phase);
  if (approachOptions.length > 0) {
    return buildDecision(now, input, {
      kind: 'approach_choice',
      title: `Choose an approach for ${input.projectName}`,
      prompt: buildPrompt(
        `Tik detected multiple viable approaches for ${input.projectName}. Pick one before continuing ${phaseLabel(input.phase)}.`,
        semanticContext,
      ),
      options: approachOptions,
      recommendedOptionId: approachOptions.find((option) => option.recommended)?.id,
      allowFreeform: true,
      confidence: 'medium',
      rationale: buildRationale(
        'The blocker summary exposed multiple named approaches, so Tik converted them into explicit decision options instead of leaving the user with a raw text blocker.',
        semanticContext,
      ),
      signals: mergeSignals(semanticContext.signals, [
        `approach-options:${approachOptions.length}`,
      ]),
      sourceSummary: summary,
    });
  }

  if (input.blockerKind === 'REPLAN') {
    const options: WorkspaceDecisionOption[] = [
      {
        id: 'rerun-current-phase',
        label: `Rerun ${phaseLabel(input.phase)}`,
        description: `Clarify the requirement and rerun ${phaseLabel(input.phase)} for ${input.projectName}.`,
        nextPhase: input.phase,
        recommended: true,
      },
      ...(input.phase === 'PARALLEL_PLAN'
        ? [{
          id: 'go-back-to-specify',
          label: 'Go back to specify',
          description: 'The plan likely reflects an underspecified scope. Re-open specify first.',
          nextPhase: 'PARALLEL_SPECIFY' as const,
        }]
        : []),
    ];
    return buildDecision(now, input, {
      kind: 'phase_reroute',
      title: `Replan ${input.projectName}`,
      prompt: buildPrompt(
        `The current ${phaseLabel(input.phase)} result for ${input.projectName} needs a controlled reroute before the workspace can continue.`,
        semanticContext,
      ),
      options,
      recommendedOptionId: options[0]?.id,
      allowFreeform: true,
      confidence: 'medium',
      rationale: buildRationale(
        'This blocker was classified as a replan condition, so the safest choices are to rerun the current phase or step back to an earlier planning phase.',
        semanticContext,
      ),
      signals: mergeSignals(semanticContext.signals, ['replan']),
      sourceSummary: summary,
    });
  }

  if (input.blockerKind === 'EXECUTION_FAILED') {
    const options: WorkspaceDecisionOption[] = [
      {
        id: 'retry-current-phase',
        label: `Retry ${phaseLabel(input.phase)}`,
        description: `Retry ${phaseLabel(input.phase)} with the same target after confirming the approach.`,
        nextPhase: input.phase,
        recommended: true,
      },
      ...(input.phase === 'PARALLEL_ACE'
        ? [{
          id: 'go-back-to-plan',
          label: 'Go back to plan',
          description: 'Revise the plan before another ACE execution attempt.',
          nextPhase: 'PARALLEL_PLAN' as const,
        }]
        : []),
    ];
    return buildDecision(now, input, {
      kind: 'approval',
      title: `Confirm recovery for ${input.projectName}`,
      prompt: buildPrompt(
        `Execution failed during ${phaseLabel(input.phase)} for ${input.projectName}. Confirm whether Tik should retry this phase or step back.`,
        semanticContext,
      ),
      options,
      recommendedOptionId: options[0]?.id,
      allowFreeform: true,
      confidence: 'medium',
      rationale: buildRationale(
        'Execution failures are recoverable, but Tik should not guess whether to retry immediately or step back without a human approval signal.',
        semanticContext,
      ),
      signals: mergeSignals(semanticContext.signals, ['execution-failed']),
      sourceSummary: summary,
    });
  }

  const clarificationCategory = inferClarificationCategory(input, semanticContext);
  const clarificationSignals = mergeSignals(
    semanticContext.signals,
    detectClarificationSignals(summary, semanticContext.semanticText, clarificationCategory),
  );
  const clarificationOptions = buildClarificationOptions(input.phase, clarificationCategory, input.projectName);

  return buildDecision(now, input, {
    kind: 'clarification',
    title: clarificationTitle(input.projectName, clarificationCategory),
    prompt: buildPrompt(
      clarificationPrompt(input.phase, input.projectName, clarificationCategory),
      semanticContext,
    ),
    options: clarificationOptions,
    recommendedOptionId: clarificationOptions.find((option) => option.recommended)?.id,
    allowFreeform: true,
    confidence: clarificationConfidence(semanticContext),
    rationale: buildRationale(
      clarificationRationale(clarificationCategory, semanticContext),
      semanticContext,
    ),
    signals: clarificationSignals,
    sourceSummary: summary,
  });
}

function buildDecision(
  now: string,
  input: WorkspaceDecisionSynthesisInput,
  fields: Omit<WorkspaceDecisionRequest, 'id' | 'status' | 'phase' | 'projectName' | 'createdAt' | 'updatedAt'>,
): WorkspaceDecisionRequest {
  return {
    id: generateId(),
    status: 'pending',
    phase: input.phase,
    projectName: input.projectName,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

function extractArtifactOptions(
  summary: string | undefined,
  phase: WorkspaceDecisionPhase,
): WorkspaceDecisionOption[] {
  if (!summary) return [];
  const match = summary.match(/Multiple feature (specs|plans) found; unable to choose automatically:\s*(.+)$/i);
  if (!match) return [];
  const artifactField = match[1]?.toLowerCase() === 'plans' ? 'planPath' : 'specPath';
  const choices = match[2]!.split(',').map((value) => value.trim()).filter(Boolean);
  return choices.map((choice, index) => {
    const featureLabel = path.basename(path.dirname(choice)) || choice;
    return {
      id: `artifact-${index + 1}`,
      label: featureLabel,
      description: choice,
      artifactPath: choice,
      artifactField,
      nextPhase: phase,
      recommended: index === 0,
    };
  });
}

function extractApproachOptions(
  summary: string | undefined,
  phase: WorkspaceDecisionPhase,
): WorkspaceDecisionOption[] {
  if (!summary) return [];
  const matches = summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^(?:[-*]\s*)?(?:option|approach|方案)\s*([A-Za-z0-9_-]+)?\s*[:：-]\s*(.+)$/i))
    .filter(Boolean) as RegExpMatchArray[];

  return matches.map((match, index) => ({
    id: match[1] ? `option-${match[1].toLowerCase()}` : `option-${index + 1}`,
    label: match[2]!.slice(0, 80),
    description: match[2]!,
    nextPhase: phase,
    recommended: index === 0,
  }));
}

function phaseLabel(phase: WorkspaceDecisionPhase): string {
  return phase === 'PARALLEL_CLARIFY'
    ? 'clarify'
    : phase === 'PARALLEL_SPECIFY'
    ? 'specify'
    : phase === 'PARALLEL_PLAN'
      ? 'plan'
      : 'ACE';
}

export function workspaceDecisionConfidenceRank(
  confidence: WorkspaceDecisionConfidence | undefined,
): number {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  return 1;
}

type ClarificationCategory = 'scope' | 'constraints' | 'validation' | 'approval' | 'generic';

interface SemanticContext {
  semanticText: string;
  signals: string[];
  contextSummary: string[];
  evidenceCount: number;
}

function buildSemanticContext(input: WorkspaceDecisionSynthesisInput): SemanticContext {
  const semanticParts = [
    input.summary,
    input.demand,
    input.specExcerpt,
    input.planExcerpt,
    ...(input.recentProjectEvents || []),
    ...(input.recentWorkspaceEvents || []),
  ].filter(Boolean);
  const contextSummary = [
    input.demand ? `demand=${truncate(input.demand, 120)}` : '',
    input.workflowContract ? `contract=${input.workflowContract}` : '',
    input.workflowSkillName ? `skill=${input.workflowSkillName}` : '',
    input.workflowProfile ? `profile=${input.workflowProfile}` : '',
    input.specPath ? `spec=${path.basename(input.specPath)}` : '',
    input.planPath ? `plan=${path.basename(input.planPath)}` : '',
    input.projectKnownArtifacts?.length ? `artifacts=${input.projectKnownArtifacts.map((item) => path.basename(item)).join(',')}` : '',
    input.sessionNextAction ? `next=${truncate(input.sessionNextAction, 80)}` : '',
    input.recentProjectEvents?.[0] ? `recent=${truncate(input.recentProjectEvents[0], 100)}` : '',
  ].filter(Boolean);
  const signals = mergeSignals([], [
    `phase:${input.phase}`,
    ...(input.blockerKind ? [`blocker:${input.blockerKind}`] : []),
    ...(input.workflowContract ? [`contract:${input.workflowContract}`] : []),
    ...(input.workflowRole ? [`role:${input.workflowRole}`] : []),
    ...(input.workflowSkillName ? [`skill:${input.workflowSkillName}`] : []),
    ...(input.workflowProfile ? [`profile:${input.workflowProfile}`] : []),
    ...(input.specPath ? ['artifact:spec'] : []),
    ...(input.planPath ? ['artifact:plan'] : []),
    ...(input.projectKnownArtifacts?.length ? [`known-artifacts:${input.projectKnownArtifacts.length}`] : []),
    ...(input.recentProjectEvents?.length ? [`project-events:${input.recentProjectEvents.length}`] : []),
    ...(input.recentWorkspaceEvents?.length ? [`workspace-events:${input.recentWorkspaceEvents.length}`] : []),
    ...(input.sessionNextAction ? ['memory-next-action'] : []),
    ...(input.specExcerpt ? ['spec-excerpt'] : []),
    ...(input.planExcerpt ? ['plan-excerpt'] : []),
  ]);
  return {
    semanticText: semanticParts.join('\n'),
    signals,
    contextSummary,
    evidenceCount: semanticParts.length,
  };
}

function buildPrompt(base: string, semanticContext: SemanticContext): string {
  if (semanticContext.contextSummary.length === 0) return base;
  return `${base} Context: ${semanticContext.contextSummary.join(' | ')}.`;
}

function buildRationale(base: string, semanticContext: SemanticContext): string {
  if (semanticContext.contextSummary.length === 0) return base;
  return `${base} Evidence: ${semanticContext.contextSummary.join(' | ')}.`;
}

function mergeSignals(base: string[], extra: string[]): string[] {
  return Array.from(new Set([...base, ...extra.filter(Boolean)]));
}

function inferClarificationCategory(
  input: WorkspaceDecisionSynthesisInput,
  semanticContext: SemanticContext,
): ClarificationCategory {
  const text = semanticContext.semanticText.toLowerCase();
  if (/(approve|approval|确认|是否继续)/i.test(semanticContext.semanticText)) {
    return 'approval';
  }
  if (/(test|测试|验收|validation|校验|assert|coverage|用例)/i.test(text)) {
    return 'validation';
  }
  if (/(constraint|限制|依赖|dependency|前置|兼容|consistency|一致性|回滚|rollback)/i.test(text)) {
    return 'constraints';
  }
  if (/(scope|范围|边界|ownership|归属|谁来改|跨项目|project)/i.test(text)) {
    return 'scope';
  }
  if (input.phase === 'PARALLEL_ACE' && input.workflowContract === 'ACE_SUBTASK') {
    return 'constraints';
  }
  return 'generic';
}

function detectClarificationSignals(
  summary: string | undefined,
  semanticText: string,
  category: ClarificationCategory,
): string[] {
  const text = `${summary || ''}\n${semanticText}`;
  const signals: string[] = ['needs-clarification'];
  if (category === 'scope' || /(scope|范围|边界|out of scope|in scope)/i.test(text)) {
    signals.push('unclear-scope');
  }
  if (category === 'constraints' || /(constraint|限制|前提|依赖|dependency|前置条件|一致性|兼容)/i.test(text)) {
    signals.push('missing-constraints');
  }
  if (category === 'validation' || /(test|测试|验收|validation|校验|assert|coverage|用例)/i.test(text)) {
    signals.push('validation-gap');
  }
  if (category === 'approval' || /(approve|approval|确认|是否继续)/i.test(text)) {
    signals.push('approval-needed');
  }
  if (/timeout|超时/i.test(text)) {
    signals.push('timeout');
  }
  if (/template|skeleton|模板/i.test(text)) {
    signals.push('template-output');
  }
  return Array.from(new Set(signals));
}

function buildClarificationOptions(
  phase: WorkspaceDecisionPhase,
  category: ClarificationCategory,
  projectName: string,
): WorkspaceDecisionOption[] {
  const rerunPhase = phase === 'PARALLEL_CLARIFY'
    ? 'PARALLEL_SPECIFY'
    : phase;
  if (category === 'generic') {
    return [{
      id: 'clarify-and-continue',
      label: `Clarify and continue to ${phaseLabel(rerunPhase)}`,
      description: `Provide the missing clarification for ${projectName} and continue to ${phaseLabel(rerunPhase)}.`,
      nextPhase: rerunPhase,
      recommended: true,
    }];
  }
  const rerunLabel = category === 'validation'
    ? `Clarify validation and continue to ${phaseLabel(rerunPhase)}`
    : category === 'constraints'
      ? `Clarify constraints and continue to ${phaseLabel(rerunPhase)}`
      : category === 'scope'
        ? `Clarify scope and continue to ${phaseLabel(rerunPhase)}`
        : `Confirm and continue to ${phaseLabel(rerunPhase)}`;

  const options: WorkspaceDecisionOption[] = [
    {
      id: 'clarify-and-rerun',
      label: rerunLabel,
      description: `Provide the missing ${category} details for ${projectName} and continue to ${phaseLabel(rerunPhase)}.`,
      nextPhase: rerunPhase,
      recommended: true,
    },
  ];

  if (phase === 'PARALLEL_ACE') {
    options.push({
      id: 'go-back-to-plan',
      label: 'Go back to plan',
      description: 'Step back to the planning phase and make the missing execution assumptions explicit before another ACE attempt.',
      nextPhase: 'PARALLEL_PLAN',
    });
  } else if (phase === 'PARALLEL_PLAN') {
    options.push({
      id: 'go-back-to-specify',
      label: 'Go back to specify',
      description: 'Step back to the specification phase and tighten the scope before planning again.',
      nextPhase: 'PARALLEL_SPECIFY',
    });
  } else if (phase === 'PARALLEL_CLARIFY') {
    options.push({
      id: 'skip-clarify-and-specify',
      label: 'Skip clarify and proceed to specify',
      description: 'Acknowledge the ambiguity risk and let Tik continue directly to specification.',
      nextPhase: 'PARALLEL_SPECIFY',
    });
  }

  return options;
}

function clarificationTitle(projectName: string, category: ClarificationCategory): string {
  if (category === 'scope') return `Clarify scope for ${projectName}`;
  if (category === 'constraints') return `Clarify constraints for ${projectName}`;
  if (category === 'validation') return `Clarify validation for ${projectName}`;
  if (category === 'approval') return `Confirm direction for ${projectName}`;
  return `Clarify ${projectName}`;
}

function clarificationPrompt(
  phase: WorkspaceDecisionPhase,
  projectName: string,
  category: ClarificationCategory,
): string {
  if (category === 'scope') {
    return `Tik needs a clearer scope boundary for ${projectName} before ${phaseLabel(phase)} can continue safely.`;
  }
  if (category === 'constraints') {
    return `Tik needs missing technical or business constraints for ${projectName} before ${phaseLabel(phase)} can continue safely.`;
  }
  if (category === 'validation') {
    return `Tik needs clearer validation or acceptance targets for ${projectName} before ${phaseLabel(phase)} can continue safely.`;
  }
  if (category === 'approval') {
    return `Tik needs an explicit human approval signal for ${projectName} before ${phaseLabel(phase)} can continue safely.`;
  }
  return `Tik needs a clarification for ${projectName} before ${phaseLabel(phase)} can continue safely.`;
}

function clarificationRationale(
  category: ClarificationCategory,
  semanticContext: SemanticContext,
): string {
  if (category === 'scope') {
    return 'Tik found signals that the blocker is about scope or ownership boundaries, so it is asking for a scoped clarification instead of blindly retrying the phase.';
  }
  if (category === 'constraints') {
    return 'Tik found signals that key constraints or assumptions are missing, so it is escalating for clarification before another execution attempt.';
  }
  if (category === 'validation') {
    return 'Tik found signals that the validation target is underspecified, so it is asking for explicit acceptance criteria before continuing.';
  }
  if (category === 'approval') {
    return 'Tik found signals that continuing would be a materially branching decision, so it is asking for an approval-style confirmation.';
  }
  return semanticContext.evidenceCount > 1
    ? 'Tik combined the available demand, artifact, and event context but still could not infer a safe structured choice, so it escalated as a clarification.'
    : 'Tik did not have enough structured evidence to synthesize options, so it is asking for a freeform clarification.';
}

function clarificationConfidence(semanticContext: SemanticContext): WorkspaceDecisionConfidence {
  if (semanticContext.evidenceCount >= 4) return 'high';
  if (semanticContext.evidenceCount >= 2) return 'medium';
  return 'low';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
