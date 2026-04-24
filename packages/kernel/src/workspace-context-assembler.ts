import type { WorkflowSubtaskSpec } from '@tik/shared';
import { getWorkflowSkillRouteByPhase } from './workflow-skill-routes.js';
import { WorkspaceExecutionContractSynthesizer } from './workspace-execution-contract-synthesizer.js';

export interface WorkspaceContextAssemblerOptions {
  contractSynthesizer?: WorkspaceExecutionContractSynthesizer;
}

export class WorkspaceContextAssembler {
  private readonly contractSynthesizer: WorkspaceExecutionContractSynthesizer;

  constructor(options?: WorkspaceContextAssemblerOptions) {
    this.contractSynthesizer = options?.contractSynthesizer ?? new WorkspaceExecutionContractSynthesizer();
  }

  buildClarifySubtaskSpec(input: {
    projectName: string;
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    clarificationPath?: string;
    splitReason?: string;
  }): WorkflowSubtaskSpec {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_CLARIFY');
    const sourceProjectPath = input.sourceProjectPath || input.projectPath;
    const effectiveProjectPath = input.effectiveProjectPath || input.projectPath;
    return {
      projectName: input.projectName,
      projectPath: effectiveProjectPath,
      phase: route.phase,
      contract: route.contract,
      role: route.role,
      skillName: route.skillName,
      skillSourceKind: route.skillSourceKind,
      skillPath: route.skillPath,
      description: this.buildClarifyDescription(input),
      inputs: {
        demand: input.demand,
        clarificationPath: input.clarificationPath,
        workspaceRoot: input.workspaceRoot,
        workspaceFile: input.workspaceFile,
        sourceProjectPath,
        effectiveProjectPath,
        projectRoleHint: '.code-workspace is the orchestration container; sourceProjectPath is the original repository target and effectiveProjectPath is the current execution context. Clarification should inform Tik decisions, not replace them.',
      },
      strategy: 'incremental',
      maxIterations: 1,
    };
  }

  buildSpecifySubtaskSpec(input: {
    projectName: string;
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    targetSpecPath?: string;
  }): WorkflowSubtaskSpec {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_SPECIFY');
    const sourceProjectPath = input.sourceProjectPath || input.projectPath;
    const effectiveProjectPath = input.effectiveProjectPath || input.projectPath;
    return {
      projectName: input.projectName,
      projectPath: effectiveProjectPath,
      phase: route.phase,
      contract: route.contract,
      role: route.role,
      skillName: route.skillName,
      skillSourceKind: route.skillSourceKind,
      skillPath: route.skillPath,
      description: this.buildSpecifyDescription(input),
      inputs: {
        demand: input.demand,
        targetSpecPath: input.targetSpecPath,
        workspaceRoot: input.workspaceRoot,
        workspaceFile: input.workspaceFile,
        sourceProjectPath,
        effectiveProjectPath,
        projectRoleHint: '.code-workspace is the orchestration container; sourceProjectPath is the original repository target and effectiveProjectPath is the actual execution path.',
      },
      strategy: 'incremental',
      maxIterations: 1,
    };
  }

  buildPlanSubtaskSpec(input: {
    projectName: string;
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    specContent: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    specPath?: string;
    targetPlanPath?: string;
  }): WorkflowSubtaskSpec {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_PLAN');
    const sourceProjectPath = input.sourceProjectPath || input.projectPath;
    const effectiveProjectPath = input.effectiveProjectPath || input.projectPath;
    return {
      projectName: input.projectName,
      projectPath: effectiveProjectPath,
      phase: route.phase,
      contract: route.contract,
      role: route.role,
      skillName: route.skillName,
      skillSourceKind: route.skillSourceKind,
      skillPath: route.skillPath,
      description: this.buildPlanDescription(input),
      inputs: {
        demand: input.demand,
        specContent: input.specContent,
        resolvedSpecPath: input.specPath,
        targetPlanPath: input.targetPlanPath,
        workspaceRoot: input.workspaceRoot,
        workspaceFile: input.workspaceFile,
        sourceProjectPath,
        effectiveProjectPath,
        projectRoleHint: '.code-workspace is the orchestration container; sourceProjectPath is the original repository target and effectiveProjectPath is the actual execution path.',
      },
      strategy: 'incremental',
      maxIterations: 1,
    };
  }

  buildAceSubtaskSpec(input: {
    projectName: string;
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    specContent: string;
    planContent: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    specPath?: string;
    planPath?: string;
  }): WorkflowSubtaskSpec {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_ACE');
    const sourceProjectPath = input.sourceProjectPath || input.projectPath;
    const effectiveProjectPath = input.effectiveProjectPath || input.projectPath;
    const executionContract = this.contractSynthesizer.synthesize({
      projectPath: effectiveProjectPath,
      demand: input.demand,
      specContent: input.specContent,
      planContent: input.planContent,
    });
    return {
      projectName: input.projectName,
      projectPath: effectiveProjectPath,
      phase: route.phase,
      contract: route.contract,
      role: route.role,
      skillName: route.skillName,
      skillSourceKind: route.skillSourceKind,
      skillPath: route.skillPath,
      description: this.buildAceDescription({ ...input, executionContract }),
      inputs: {
        demand: input.demand,
        specContent: input.specContent,
        planContent: input.planContent,
        executionContract,
        workspaceRoot: input.workspaceRoot,
        workspaceFile: input.workspaceFile,
        sourceProjectPath,
        effectiveProjectPath,
        projectRoleHint: '.code-workspace is the orchestration container; sourceProjectPath is the original repository target and effectiveProjectPath is the actual execution path.',
      },
      strategy: 'incremental',
      maxIterations: 3,
    };
  }

  private buildClarifyDescription(input: {
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    clarificationPath?: string;
    splitReason?: string;
  }): string {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_CLARIFY');
    return [
      'Workspace PARALLEL_CLARIFY subtask.',
      'Clarification route:',
      `- Skill capability: ${route.skillName}`,
      `- Role lane: ${route.role}`,
      `- Skill source: ${route.skillSourceKind}`,
      `- Primary skill path: ${route.skillPath}`,
      ...(input.workspaceRoot ? [`Workspace root: ${input.workspaceRoot}`] : []),
      ...(input.workspaceFile ? [`Workspace file: ${input.workspaceFile}`] : []),
      `Source project path: ${input.sourceProjectPath || input.projectPath}`,
      `Execution project path: ${input.effectiveProjectPath || input.projectPath}`,
      `Demand: ${input.demand}`,
      ...(input.splitReason ? [`Split reason: ${input.splitReason}`] : []),
      ...(input.clarificationPath ? [`Clarification artifact path: ${input.clarificationPath}`] : []),
      `Goal: ${route.summaryGoal}.`,
      'Contract:',
      '- Treat this as a Tik-governed clarification pass, not as a second user-facing conversation system.',
      '- Use superpowers clarification methods to identify the strongest unresolved requirement boundary, technical constraint, or approach choice.',
      '- Produce a durable clarification artifact and structured decision context for Tik.',
      '- Prefer one focused clarification question or a small set of explicit options over broad freeform analysis.',
      '- If the demand is already concrete enough, explicitly say clarification can be skipped and recommend PARALLEL_SPECIFY.',
      `- Return a result equivalent to <promise>${route.completionPromise}</promise> semantics.`,
    ].join('\n');
  }

  private buildSpecifyDescription(input: {
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    targetSpecPath?: string;
  }): string {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_SPECIFY');
    return [
      'Workspace PARALLEL_SPECIFY subtask.',
      'Single-project workflow route:',
      `- Skill: ${route.skillName}`,
      `- Role lane: ${route.role}`,
      `- Skill path: ${route.skillPath}`,
      ...(input.workspaceRoot ? [`Workspace root: ${input.workspaceRoot}`] : []),
      ...(input.workspaceFile ? [`Workspace file: ${input.workspaceFile}`] : []),
      `Source project path: ${input.sourceProjectPath || input.projectPath}`,
      `Execution project path: ${input.effectiveProjectPath || input.projectPath}`,
      `Demand: ${input.demand}`,
      ...(input.targetSpecPath ? [`Target spec path: ${input.targetSpecPath}`] : []),
      `Goal: ${route.summaryGoal}.`,
      `Expected output: ${route.expectedOutput}`,
      'Contract:',
      '- The .code-workspace file is only the orchestration container; do not treat the workspace root itself as the implementation target unless it is also the current source project path.',
      '- Always treat the execution project path above as the path to inspect and modify for this run.',
      '- Keep source project path for audit and integration context only.',
      `- Treat this as the workspace equivalent of routing into the single-project ${route.skillName} skill.`,
      '- Reuse the existing feature spec only if it already matches the exact target spec path above.',
      '- In workspace delegated mode, do not depend on aiops-sdd-specify or branch-creation side effects to choose a feature directory.',
      '- Create or update the target spec file directly at the exact Target spec path above.',
      '- Keep downstream plan generation in the same feature directory as the target spec path.',
      '- Focus on project-local scope, contract impact, risks, and acceptance criteria.',
      '- Finish when the project spec is ready for plan generation.',
      `- Return a result equivalent to <promise>${route.completionPromise}</promise> semantics.`,
    ].join('\n');
  }

  private buildPlanDescription(input: {
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    specContent: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    specPath?: string;
    targetPlanPath?: string;
  }): string {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_PLAN');
    return [
      'Workspace PARALLEL_PLAN subtask.',
      'Single-project workflow route:',
      `- Skill: ${route.skillName}`,
      `- Role lane: ${route.role}`,
      `- Skill path: ${route.skillPath}`,
      ...(input.workspaceRoot ? [`Workspace root: ${input.workspaceRoot}`] : []),
      ...(input.workspaceFile ? [`Workspace file: ${input.workspaceFile}`] : []),
      `Source project path: ${input.sourceProjectPath || input.projectPath}`,
      `Execution project path: ${input.effectiveProjectPath || input.projectPath}`,
      `Demand: ${input.demand}`,
      `Goal: ${route.summaryGoal}.`,
      `Expected output: ${route.expectedOutput}`,
      ...(input.specPath ? [`Resolved spec path: ${input.specPath}`] : []),
      ...(input.targetPlanPath ? [`Target plan path: ${input.targetPlanPath}`] : []),
      'Contract:',
      '- The .code-workspace file is only the orchestration container; the source project path above is the original repository root and the execution project path above is the real runtime root for this subtask.',
      `- Treat this as the workspace equivalent of routing into the single-project ${route.skillName} skill.`,
      '- In workspace delegated mode, do not depend on aiops-sdd-plan to pick or create the feature directory.',
      '- Read the resolved feature-local spec and produce an executable technical plan in the exact Target plan path above.',
      '- Do not leave placeholders such as [FEATURE], ACTION REQUIRED, NEEDS CLARIFICATION, TODO, TBD.',
      '- The plan must include real architecture changes, implementation steps, validation, risks, and rollout notes.',
      '- If an existing plan is already real and complete, confirm it rather than rewriting it.',
      `- Return a result equivalent to <promise>${route.completionPromise}</promise> semantics only after the plan is truly executable.`,
      input.specContent ? `Spec excerpt:\n${input.specContent.slice(0, 6000)}` : 'Spec excerpt: (missing)',
    ].join('\n\n');
  }

  private buildAceDescription(input: {
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    demand: string;
    specContent: string;
    planContent: string;
    workspaceRoot?: string;
    workspaceFile?: string;
    specPath?: string;
    planPath?: string;
    executionContract?: WorkflowSubtaskSpec['inputs']['executionContract'];
  }): string {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_ACE');
    return [
      'Workspace PARALLEL_ACE subtask.',
      'Single-project workflow route:',
      `- Skill: ${route.skillName}`,
      `- Role lane: ${route.role}`,
      `- Skill path: ${route.skillPath}`,
      ...(input.workspaceRoot ? [`Workspace root: ${input.workspaceRoot}`] : []),
      ...(input.workspaceFile ? [`Workspace file: ${input.workspaceFile}`] : []),
      `Source project path: ${input.sourceProjectPath || input.projectPath}`,
      `Execution project path: ${input.effectiveProjectPath || input.projectPath}`,
      `Demand: ${input.demand}`,
      `Goal: ${route.summaryGoal}.`,
      ...(input.specPath ? [`Resolved spec path: ${input.specPath}`] : []),
      ...(input.planPath ? [`Resolved plan path: ${input.planPath}`] : []),
      'Contract:',
      '- The .code-workspace file is only the orchestration container; all concrete code reading, editing, and validation must be scoped to the execution project path above.',
      `- Treat this as the workspace equivalent of routing into the single-project ${route.skillName} skill.`,
      '- Use the current spec and plan as the execution contract for this project.',
      '- Prefer producing or validating concrete implementation changes over generic exploration.',
      '- If you cannot converge, return a blocker that the workspace orchestrator can aggregate.',
      `- Finish with either completed work or a clear blocked/failed outcome for this project, equivalent to <promise>${route.completionPromise}</promise> or a workspace-visible blocker.`,
      ...(input.executionContract?.summary ? [`Execution-ready contract: ${input.executionContract.summary}`] : []),
      ...(typeof input.executionContract?.confidence === 'number'
        ? [`Execution-ready confidence: ${(input.executionContract.confidence * 100).toFixed(0)}%`]
        : []),
      ...(input.executionContract?.rationale ? [`Execution-ready rationale: ${input.executionContract.rationale}`] : []),
      ...(input.executionContract?.targetFiles?.length
        ? ['Execution-ready target files:', ...input.executionContract.targetFiles.map((file) => `- ${file}`)]
        : []),
      ...(input.executionContract?.candidateFiles?.length
        ? ['Execution-ready ranked candidates:', ...input.executionContract.candidateFiles.map((candidate) => `- ${candidate.path} (score=${candidate.score}; ${candidate.reason})`)]
        : []),
      ...(input.executionContract?.targetMethods?.length
        ? ['Execution-ready target methods:', ...input.executionContract.targetMethods.map((method) => `- ${method}`)]
        : []),
      ...(input.executionContract?.cachePatternReferences?.length
        ? ['Cache pattern references:', ...input.executionContract.cachePatternReferences.map((item) => `- ${item}`)]
        : []),
      ...(input.executionContract?.validationTargets?.length
        ? ['Validation targets:', ...input.executionContract.validationTargets.map((item) => `- ${item}`)]
        : []),
      ...(input.executionContract?.signals?.length
        ? ['Execution signals:', ...input.executionContract.signals.map((item) => `- ${item}`)]
        : []),
      'Execution contract files:',
      input.specPath ? `- Read ${input.specPath} directly from disk.` : '- Resolve and read the feature-local spec.md directly from disk.',
      input.planPath ? `- Read ${input.planPath} directly from disk.` : '- Resolve and read the feature-local plan.md directly from disk.',
      '- Do not rely on large inlined excerpts when the source files are available.',
    ].join('\n\n');
  }
}
