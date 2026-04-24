import type {
  WorkflowExecutablePhase,
  WorkflowSubtaskSpec,
  WorkspaceWorkflowPolicyConfig,
  WorkspaceWorkflowPolicyProfile,
} from '@tik/shared';
import type { CompletionEvidence } from './workspace-completion-evidence.js';

export type WorkspacePhaseArtifactState =
  | 'ready'
  | 'missing'
  | 'invalid';

export interface NativeRescueDecisionInput {
  phase: WorkflowSubtaskSpec['phase'];
  artifactState: WorkspacePhaseArtifactState;
  timedOut: boolean;
  delegatedStatus?: string;
}

export interface FeedbackEscalationDecisionInput {
  phase: WorkflowExecutablePhase;
  retryCount: number;
}

type WorkspaceWorkflowPolicy = {
  profile: WorkspaceWorkflowPolicyProfile;
  phaseBudgetsMs: Record<WorkflowExecutablePhase, number>;
  maxFeedbackRetriesPerPhase: Record<WorkflowExecutablePhase, number>;
  enableNativeArtifactRescue: boolean;
  enableAceEvidencePromotion: boolean;
};

export const WORKSPACE_POLICY_PROFILES: Record<WorkspaceWorkflowPolicyProfile, WorkspaceWorkflowPolicy> = {
  balanced: {
    profile: 'balanced',
    phaseBudgetsMs: {
      PARALLEL_CLARIFY: 120_000,
      PARALLEL_SPECIFY: 300_000,
      PARALLEL_PLAN: 300_000,
      PARALLEL_ACE: 600_000,
    },
    maxFeedbackRetriesPerPhase: {
      PARALLEL_CLARIFY: 1,
      PARALLEL_SPECIFY: 1,
      PARALLEL_PLAN: 1,
      PARALLEL_ACE: 2,
    },
    enableNativeArtifactRescue: true,
    enableAceEvidencePromotion: true,
  },
  'fast-feedback': {
    profile: 'fast-feedback',
    phaseBudgetsMs: {
      PARALLEL_CLARIFY: 90_000,
      PARALLEL_SPECIFY: 180_000,
      PARALLEL_PLAN: 180_000,
      PARALLEL_ACE: 420_000,
    },
    maxFeedbackRetriesPerPhase: {
      PARALLEL_CLARIFY: 1,
      PARALLEL_SPECIFY: 1,
      PARALLEL_PLAN: 1,
      PARALLEL_ACE: 1,
    },
    enableNativeArtifactRescue: true,
    enableAceEvidencePromotion: true,
  },
  'deep-verify': {
    profile: 'deep-verify',
    phaseBudgetsMs: {
      PARALLEL_CLARIFY: 180_000,
      PARALLEL_SPECIFY: 420_000,
      PARALLEL_PLAN: 420_000,
      PARALLEL_ACE: 900_000,
    },
    maxFeedbackRetriesPerPhase: {
      PARALLEL_CLARIFY: 2,
      PARALLEL_SPECIFY: 2,
      PARALLEL_PLAN: 2,
      PARALLEL_ACE: 3,
    },
    enableNativeArtifactRescue: true,
    enableAceEvidencePromotion: true,
  },
};

export const DEFAULT_WORKSPACE_POLICY: WorkspaceWorkflowPolicy = {
  ...WORKSPACE_POLICY_PROFILES.balanced,
};

export function resolveWorkspaceWorkflowPolicy(
  config?: WorkspaceWorkflowPolicyConfig,
): WorkspaceWorkflowPolicy {
  const profile = config?.profile ?? 'balanced';
  const base = WORKSPACE_POLICY_PROFILES[profile];
  return {
    profile,
    phaseBudgetsMs: {
      ...base.phaseBudgetsMs,
      ...(config?.phaseBudgetsMs || {}),
    },
    maxFeedbackRetriesPerPhase: {
      ...base.maxFeedbackRetriesPerPhase,
      ...(config?.maxFeedbackRetriesPerPhase || {}),
    },
    enableNativeArtifactRescue: config?.enableNativeArtifactRescue ?? base.enableNativeArtifactRescue,
    enableAceEvidencePromotion: config?.enableAceEvidencePromotion ?? base.enableAceEvidencePromotion,
  };
}

export class WorkspacePolicyEngine {
  private readonly config: WorkspaceWorkflowPolicy;

  constructor(config?: WorkspaceWorkflowPolicyConfig) {
    this.config = resolveWorkspaceWorkflowPolicy(config);
  }

  getConfig(): WorkspaceWorkflowPolicy {
    return this.config;
  }

  getPhaseBudgetMs(phase: WorkflowExecutablePhase): number {
    return this.config.phaseBudgetsMs[phase];
  }

  shouldRunNativeArtifactRescue(input: NativeRescueDecisionInput): boolean {
    if (!this.config.enableNativeArtifactRescue) return false;
    if (input.phase === 'PARALLEL_ACE') return false;
    if (input.artifactState === 'missing' || input.artifactState === 'invalid') return true;
    if (input.timedOut) return true;
    return false;
  }

  shouldPromoteArtifactToNative(input: { reused: boolean; materializedDuringRun: boolean }): boolean {
    return !input.reused || input.materializedDuringRun;
  }

  shouldPromoteAceTimeoutToCompleted(evidence: CompletionEvidence | null): boolean {
    if (!this.config.enableAceEvidencePromotion) return false;
    return Boolean(evidence?.matchedTargets.length);
  }

  shouldEscalateFeedback(input: FeedbackEscalationDecisionInput): boolean {
    return input.retryCount < this.config.maxFeedbackRetriesPerPhase[input.phase];
  }

  formatArtifactModeLabel(input: { reused: boolean; executionMode?: 'native' | 'fallback' }): string {
    if (input.reused && input.executionMode !== 'native') return 'reused';
    return 'mode=native';
  }
}
