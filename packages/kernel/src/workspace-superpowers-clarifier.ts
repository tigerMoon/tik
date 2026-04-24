import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  WorkspaceDecisionOption,
  WorkspaceDecisionRequest,
  WorkspaceDecisionPhase,
  WorkspaceWorkflowPolicyProfile,
} from '@tik/shared';
import { synthesizeWorkspaceDecision } from './workspace-decision-synthesizer.js';
import { WorkspaceExecutionContractSynthesizer } from './workspace-execution-contract-synthesizer.js';
import { parseSkillDescription } from './workflow-skill-runtime.js';

export type WorkspaceClarificationMethod = 'deep-interview' | 'ralplan';
export type WorkspaceClarificationCategory =
  | 'scope'
  | 'constraints'
  | 'validation'
  | 'approval'
  | 'approach'
  | 'generic'
  | 'skip';

export interface WorkspaceSuperpowersClarifierInput {
  projectName: string;
  projectPath: string;
  demand: string;
  phase: WorkspaceDecisionPhase;
  workflowProfile?: WorkspaceWorkflowPolicyProfile;
  splitReason?: string;
  summary?: string;
  specPath?: string;
  planPath?: string;
  recentProjectEvents?: string[];
  recentWorkspaceEvents?: string[];
  sessionNextAction?: string;
  specExcerpt?: string;
  planExcerpt?: string;
}

export interface WorkspaceSuperpowersClarifierResult {
  needsClarification: boolean;
  category: WorkspaceClarificationCategory;
  method: WorkspaceClarificationMethod;
  recommendedNextPhase: Exclude<WorkspaceDecisionPhase, 'PARALLEL_CLARIFY'>;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  signals: string[];
  skillPath: string;
  skillDescription?: string;
  artifactBody: string;
  summary: string;
  decision?: WorkspaceDecisionRequest;
}

export class WorkspaceSuperpowersClarifier {
  private readonly contractSynthesizer: WorkspaceExecutionContractSynthesizer;
  private readonly superpowersRoot: string;

  constructor(options?: {
    contractSynthesizer?: WorkspaceExecutionContractSynthesizer;
    superpowersRoot?: string;
  }) {
    this.contractSynthesizer = options?.contractSynthesizer ?? new WorkspaceExecutionContractSynthesizer();
    this.superpowersRoot = options?.superpowersRoot ?? path.join(os.homedir(), '.codex', 'skills');
  }

  async clarify(input: WorkspaceSuperpowersClarifierInput, now: string): Promise<WorkspaceSuperpowersClarifierResult> {
    const contract = this.contractSynthesizer.synthesize({
      projectPath: input.projectPath,
      demand: input.demand,
      specContent: input.specExcerpt,
      planContent: input.planExcerpt,
    });

    const category = inferClarificationCategory(input, contract?.confidence);
    const threshold = profileThreshold(input.workflowProfile);
    const needsClarification = category !== 'skip';
    const method: WorkspaceClarificationMethod = category === 'approach' || input.phase === 'PARALLEL_PLAN'
      ? 'ralplan'
      : 'deep-interview';
    const skillPath = path.join(this.superpowersRoot, method, 'SKILL.md');
    const skillDescription = await readSkillDescription(skillPath);
    const recommendedNextPhase = input.phase === 'PARALLEL_PLAN'
      ? 'PARALLEL_PLAN'
      : input.phase === 'PARALLEL_ACE'
        ? 'PARALLEL_ACE'
        : 'PARALLEL_SPECIFY';

    const signals = dedupe([
      `clarify-phase:${input.phase}`,
      `clarify-category:${category}`,
      `clarify-method:${method}`,
      ...(input.workflowProfile ? [`workflow-profile:${input.workflowProfile}`] : []),
      ...(contract?.signals || []),
      ...(contract?.confidence !== undefined ? [`execution-confidence:${contract.confidence.toFixed(2)}`] : []),
      ...(input.splitReason ? [normalizeReasonSignal(input.splitReason)] : []),
      ...detectDemandSignals(input.demand, input.summary),
    ]);

    const confidence = needsClarification
      ? clarificationConfidence(contract?.confidence, category)
      : 'high';
    const rationale = needsClarification
      ? buildClarificationRationale({
        category,
        threshold,
        contractConfidence: contract?.confidence,
        splitReason: input.splitReason,
        phase: input.phase,
      })
      : buildSkipRationale(contract?.confidence, threshold, input.phase);
    const summary = needsClarification
      ? buildClarificationSummary({
        category,
        method,
        threshold,
        contractConfidence: contract?.confidence,
        splitReason: input.splitReason,
        demand: input.demand,
      })
      : `Clarification skipped for ${input.projectName}; demand appears concrete enough to continue to ${phaseLabel(recommendedNextPhase)}.`;

    const artifactBody = buildClarificationArtifact({
      now,
      input,
      category,
      method,
      needsClarification,
      confidence,
      rationale,
      signals,
      skillPath,
      skillDescription,
      contractSummary: contract?.summary,
      contractConfidence: contract?.confidence,
      recommendedNextPhase,
      summary,
    });

    if (!needsClarification) {
      return {
        needsClarification,
        category,
        method,
        recommendedNextPhase,
        confidence,
        rationale,
        signals,
        skillPath,
        skillDescription,
        artifactBody,
        summary,
      };
    }

    const decision = synthesizeWorkspaceDecision({
      projectName: input.projectName,
      phase: 'PARALLEL_CLARIFY',
      blockerKind: 'NEED_HUMAN',
      summary,
      demand: input.demand,
      workflowContract: 'CLARIFY_SUBTASK',
      workflowRole: 'planner',
      workflowSkillName: 'superpowers-clarify',
      workflowProfile: input.workflowProfile,
      specPath: input.specPath,
      planPath: input.planPath,
      recentProjectEvents: input.recentProjectEvents,
      recentWorkspaceEvents: input.recentWorkspaceEvents,
      sessionNextAction: input.sessionNextAction,
      specExcerpt: input.specExcerpt,
      planExcerpt: input.planExcerpt,
    }, now);

    const finalDecision = ensureClarifyDecisionDefaults(decision, input.projectName, category, recommendedNextPhase, confidence, rationale, signals);
    return {
      needsClarification,
      category,
      method,
      recommendedNextPhase,
      confidence,
      rationale,
      signals,
      skillPath,
      skillDescription,
      artifactBody,
      summary,
      decision: finalDecision,
    };
  }
}

async function readSkillDescription(skillPath: string): Promise<string | undefined> {
  try {
    const contents = await fs.readFile(skillPath, 'utf-8');
    return parseSkillDescription(contents);
  } catch {
    return undefined;
  }
}

function profileThreshold(profile?: WorkspaceWorkflowPolicyProfile): number {
  if (profile === 'deep-verify') return 0.75;
  if (profile === 'fast-feedback') return 0.45;
  return 0.6;
}

function inferClarificationCategory(
  input: WorkspaceSuperpowersClarifierInput,
  contractConfidence?: number,
): WorkspaceClarificationCategory {
  const text = `${input.demand}\n${input.summary || ''}\n${input.splitReason || ''}`.toLowerCase();
  const ambiguityCue = /(?:don't assume|clarify|澄清|不明确|不清楚|未定|待确认|缺少|缺失|missing|unclear|unspecified|how to|which|what test|验收标准|验证方案)/i.test(text);
  const threshold = profileThreshold(input.workflowProfile);
  if (/(don't assume|deep interview|clarify|澄清|不明确|不清楚)/i.test(text)) return 'generic';
  if (/(方案|approach|option|tradeoff|取舍|A\/B|or |either |choose)/i.test(text)) return 'approach';
  if (/(scope|范围|边界|ownership|归属|跨项目|谁来改|non-goal|out of scope)/i.test(text) && ambiguityCue) return 'scope';
  if (/(constraint|限制|依赖|dependency|兼容|回滚|rollback|前置)/i.test(text) && ambiguityCue) return 'constraints';
  if (/(test|测试|验证|验收|validation|coverage|用例)/i.test(text) && ambiguityCue) return 'validation';
  if (/(approve|approval|确认|是否继续)/i.test(text)) return 'approval';
  if ((input.splitReason || '').toLowerCase().includes('no explicit project token matched')) return 'scope';
  if ((input.splitReason || '').toLowerCase().includes('multiple project tokens matched')) return 'scope';
  if (contractConfidence === undefined) return ambiguityCue ? 'generic' : 'skip';
  if (contractConfidence < threshold) return ambiguityCue ? 'generic' : 'skip';
  return 'skip';
}

function clarificationConfidence(
  contractConfidence: number | undefined,
  category: WorkspaceClarificationCategory,
): 'low' | 'medium' | 'high' {
  if (category === 'approach') return 'medium';
  if (contractConfidence === undefined) return 'low';
  if (contractConfidence >= 0.75) return 'high';
  if (contractConfidence >= 0.5) return 'medium';
  return 'low';
}

function buildClarificationRationale(input: {
  category: WorkspaceClarificationCategory;
  threshold: number;
  contractConfidence?: number;
  splitReason?: string;
  phase: WorkspaceDecisionPhase;
}): string {
  const parts = [
    `Tik selected a clarification pass because ${categoryReason(input.category)}.`,
    input.contractConfidence !== undefined
      ? `Execution-ready confidence (${input.contractConfidence.toFixed(2)}) is below the clarify threshold (${input.threshold.toFixed(2)}) or the demand carries an explicit ambiguity signal.`
      : 'Execution-ready confidence could not be established from the current demand alone.',
    input.splitReason ? `Split context: ${input.splitReason}.` : '',
    `Recommended reroute target after clarification: ${phaseLabel(input.phase === 'PARALLEL_CLARIFY' ? 'PARALLEL_SPECIFY' : input.phase)}.`,
  ].filter(Boolean);
  return parts.join(' ');
}

function buildSkipRationale(contractConfidence: number | undefined, threshold: number, phase: WorkspaceDecisionPhase): string {
  if (contractConfidence === undefined) {
    return `Tik did not find a strong ambiguity signal in ${phaseLabel(phase)}, so it can continue without a dedicated clarify pass.`;
  }
  return `Execution-ready confidence (${contractConfidence.toFixed(2)}) is above the clarify threshold (${threshold.toFixed(2)}) and no strong ambiguity signal was detected, so Tik can continue without a dedicated clarify pass.`;
}

function buildClarificationSummary(input: {
  category: WorkspaceClarificationCategory;
  method: WorkspaceClarificationMethod;
  threshold: number;
  contractConfidence?: number;
  splitReason?: string;
  demand: string;
}): string {
  const lines = [
    `Clarification category: ${input.category}`,
    `Clarification method: ${input.method}`,
    input.contractConfidence !== undefined
      ? `Execution-ready confidence: ${input.contractConfidence.toFixed(2)} (threshold ${input.threshold.toFixed(2)})`
      : `Execution-ready confidence: unavailable (threshold ${input.threshold.toFixed(2)})`,
    input.splitReason ? `Split reason: ${input.splitReason}` : '',
    `Demand: ${input.demand}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function buildClarificationArtifact(input: {
  now: string;
  input: WorkspaceSuperpowersClarifierInput;
  category: WorkspaceClarificationCategory;
  method: WorkspaceClarificationMethod;
  needsClarification: boolean;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  signals: string[];
  skillPath: string;
  skillDescription?: string;
  contractSummary?: string;
  contractConfidence?: number;
  recommendedNextPhase: Exclude<WorkspaceDecisionPhase, 'PARALLEL_CLARIFY'>;
  summary: string;
}): string {
  return [
    `# Clarification Artifact: ${input.input.projectName}`,
    '',
    `- Generated At: ${input.now}`,
    `- Phase: PARALLEL_CLARIFY`,
    `- Category: ${input.category}`,
    `- Method: ${input.method}`,
    `- Needs Human Decision: ${input.needsClarification ? 'yes' : 'no'}`,
    `- Confidence: ${input.confidence}`,
    `- Recommended Next Phase: ${input.recommendedNextPhase}`,
    `- Skill Path: ${input.skillPath}`,
    ...(input.skillDescription ? [`- Skill Description: ${input.skillDescription}`] : []),
    ...(input.contractConfidence !== undefined ? [`- Execution Contract Confidence: ${input.contractConfidence.toFixed(2)}`] : []),
    ...(input.contractSummary ? [`- Execution Contract Summary: ${input.contractSummary}`] : []),
    '',
    '## Demand',
    '',
    input.input.demand,
    '',
    ...(input.input.splitReason ? ['## Split Context', '', input.input.splitReason, ''] : []),
    '## Summary',
    '',
    input.summary,
    '',
    '## Rationale',
    '',
    input.rationale,
    '',
    '## Signals',
    '',
    ...input.signals.map((signal) => `- ${signal}`),
  ].join('\n');
}

function ensureClarifyDecisionDefaults(
  decision: WorkspaceDecisionRequest,
  projectName: string,
  category: WorkspaceClarificationCategory,
  recommendedNextPhase: Exclude<WorkspaceDecisionPhase, 'PARALLEL_CLARIFY'>,
  confidence: 'low' | 'medium' | 'high',
  rationale: string,
  signals: string[],
): WorkspaceDecisionRequest {
  const options = buildClarifyDecisionOptions(projectName, category, recommendedNextPhase);
  return {
    ...decision,
    kind: 'clarification',
    title: clarifyDecisionTitle(projectName, category),
    prompt: clarifyDecisionPrompt(projectName, category, recommendedNextPhase),
    confidence,
    rationale,
    signals: dedupe([...(decision.signals || []), ...signals]),
    options,
    recommendedOptionId: options.find((option) => option.recommended)?.id,
    allowFreeform: decision.allowFreeform ?? true,
  };
}

function phaseLabel(phase: WorkspaceDecisionPhase): string {
  if (phase === 'PARALLEL_CLARIFY') return 'clarify';
  if (phase === 'PARALLEL_PLAN') return 'plan';
  if (phase === 'PARALLEL_ACE') return 'ACE';
  return 'specify';
}

function categoryReason(category: WorkspaceClarificationCategory): string {
  if (category === 'approach') return 'multiple viable approaches are visible';
  if (category === 'scope') return 'scope or ownership boundaries are still unclear';
  if (category === 'constraints') return 'key constraints are missing';
  if (category === 'validation') return 'validation targets are underspecified';
  if (category === 'approval') return 'an approval-style choice is still unresolved';
  return 'the demand is not yet concrete enough for a safe downstream handoff';
}

function detectDemandSignals(demand: string, summary?: string): string[] {
  const text = `${demand}\n${summary || ''}`.toLowerCase();
  return dedupe([
    /(don't assume|deep interview|clarify|澄清|不明确)/i.test(text) ? 'explicit-clarify-request' : '',
    /(方案|approach|option|tradeoff|取舍|a\/b)/i.test(text) ? 'multiple-approaches' : '',
    /(scope|范围|边界|ownership|归属|跨项目)/i.test(text) ? 'scope-boundary' : '',
    /(constraint|限制|依赖|dependency|兼容|rollback|回滚)/i.test(text) ? 'constraint-gap' : '',
    /(test|验证|验收|validation|coverage|用例)/i.test(text) ? 'validation-gap' : '',
  ]);
}

function normalizeReasonSignal(reason: string): string {
  return `split:${reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)}`;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildClarifyDecisionOptions(
  projectName: string,
  category: WorkspaceClarificationCategory,
  recommendedNextPhase: Exclude<WorkspaceDecisionPhase, 'PARALLEL_CLARIFY'>,
): WorkspaceDecisionOption[] {
  const nextPhase = phaseLabel(recommendedNextPhase);
  const detail = category === 'skip' || category === 'generic'
    ? 'clarification'
    : category === 'approval'
      ? 'confirmation'
      : category;

  return [{
    id: category === 'approval' ? 'confirm-and-continue' : 'clarify-and-continue',
    label: category === 'approval'
      ? `Confirm and continue to ${nextPhase}`
      : `Clarify and continue to ${nextPhase}`,
    description: `Provide the missing ${detail} for ${projectName}, then continue to ${nextPhase}.`,
    nextPhase: recommendedNextPhase,
    recommended: true,
  }];
}

function clarifyDecisionTitle(
  projectName: string,
  category: WorkspaceClarificationCategory,
): string {
  if (category === 'scope') return `Clarify scope for ${projectName}`;
  if (category === 'constraints') return `Clarify constraints for ${projectName}`;
  if (category === 'validation') return `Clarify validation for ${projectName}`;
  if (category === 'approval') return `Confirm direction for ${projectName}`;
  if (category === 'approach') return `Clarify approach for ${projectName}`;
  return `Clarify ${projectName}`;
}

function clarifyDecisionPrompt(
  projectName: string,
  category: WorkspaceClarificationCategory,
  recommendedNextPhase: Exclude<WorkspaceDecisionPhase, 'PARALLEL_CLARIFY'>,
): string {
  const nextPhase = phaseLabel(recommendedNextPhase);
  if (category === 'scope') {
    return `Tik needs a clearer scope or ownership boundary for ${projectName} before continuing to ${nextPhase}.`;
  }
  if (category === 'constraints') {
    return `Tik needs missing technical or business constraints for ${projectName} before continuing to ${nextPhase}.`;
  }
  if (category === 'validation') {
    return `Tik needs clearer validation or acceptance targets for ${projectName} before continuing to ${nextPhase}.`;
  }
  if (category === 'approval') {
    return `Tik needs an explicit human confirmation for ${projectName} before continuing to ${nextPhase}.`;
  }
  if (category === 'approach') {
    return `Tik needs a clearer implementation approach for ${projectName} before continuing to ${nextPhase}.`;
  }
  return `Tik needs a freeform clarification for ${projectName} before continuing to ${nextPhase}.`;
}
