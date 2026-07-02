export const WORKSPACE_POLICY_PROFILES = {
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
export const DEFAULT_WORKSPACE_POLICY = {
    ...WORKSPACE_POLICY_PROFILES.balanced,
};
export function resolveWorkspaceWorkflowPolicy(config) {
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
    config;
    constructor(config) {
        this.config = resolveWorkspaceWorkflowPolicy(config);
    }
    getConfig() {
        return this.config;
    }
    getPhaseBudgetMs(phase) {
        return this.config.phaseBudgetsMs[phase];
    }
    shouldRunNativeArtifactRescue(input) {
        if (!this.config.enableNativeArtifactRescue)
            return false;
        if (input.phase === 'PARALLEL_ACE')
            return false;
        if (input.artifactState === 'missing' || input.artifactState === 'invalid')
            return true;
        if (input.timedOut)
            return true;
        return false;
    }
    shouldPromoteArtifactToNative(input) {
        return !input.reused || input.materializedDuringRun;
    }
    shouldPromoteAceTimeoutToCompleted(evidence) {
        if (!this.config.enableAceEvidencePromotion)
            return false;
        return Boolean(evidence?.matchedTargets.length);
    }
    shouldEscalateFeedback(input) {
        return input.retryCount < this.config.maxFeedbackRetriesPerPhase[input.phase];
    }
    formatArtifactModeLabel(input) {
        if (input.reused && input.executionMode !== 'native')
            return 'reused';
        return 'mode=native';
    }
}
//# sourceMappingURL=workspace-policy-engine.js.map