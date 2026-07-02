import { WorkspaceContextAssembler } from './workspace-context-assembler.js';
import { WorkspacePolicyEngine } from './workspace-policy-engine.js';
import { WorkspaceEventStore } from './workspace-event-store.js';
import { type WorkspaceEventProjection } from './workspace-event-projection.js';
import { WorkspaceMemoryStore } from './workspace-memory.js';
import { type WorkspaceEngineProjectItem, type WorkspaceEngineSnapshot, type WorkspacePhaseExecutorServices, type WorkspacePhaseOutcome, type WorkspacePhaseReporter } from './workspace-phase-executors.js';
import type { WorkspaceWorkflowPolicyConfig } from '@tik/shared';
export interface WorkspaceWorkflowEngineOptions extends Omit<WorkspacePhaseExecutorServices, 'contextAssembler' | 'policyEngine' | 'eventStore'> {
    contextAssembler?: WorkspaceContextAssembler;
    policyEngine?: WorkspacePolicyEngine;
    eventStore?: WorkspaceEventStore;
    memoryStore?: WorkspaceMemoryStore;
    policyConfig?: WorkspaceWorkflowPolicyConfig;
}
export interface WorkspaceWorkflowRunResult extends WorkspacePhaseOutcome {
    events: ReturnType<WorkspaceEventStore['snapshot']>;
    projection: WorkspaceEventProjection;
    policy: Required<WorkspaceWorkflowPolicyConfig>;
}
export declare class WorkspaceWorkflowEngine {
    private readonly services;
    readonly eventStore: WorkspaceEventStore;
    readonly contextAssembler: WorkspaceContextAssembler;
    readonly policyEngine: WorkspacePolicyEngine;
    readonly memoryStore?: WorkspaceMemoryStore;
    private readonly specifyExecutor;
    private readonly planExecutor;
    private readonly aceExecutor;
    private readonly clarifyExecutor;
    constructor(services: WorkspaceWorkflowEngineOptions);
    runPhase(args: {
        phase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
        resolution: {
            workspace: {
                rootPath: string;
                workspaceFile: string;
            };
        };
        snapshot: WorkspaceEngineSnapshot;
        items: WorkspaceEngineProjectItem[];
        provider: string;
        model?: string;
        autoAdvance: boolean;
        reporter: WorkspacePhaseReporter;
    }): Promise<WorkspaceWorkflowRunResult>;
}
//# sourceMappingURL=workspace-workflow-engine.d.ts.map