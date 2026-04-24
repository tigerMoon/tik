import { WorkspaceContextAssembler } from './workspace-context-assembler.js';
import { WorkspacePolicyEngine } from './workspace-policy-engine.js';
import { WorkspaceEventStore } from './workspace-event-store.js';
import { buildWorkspaceEventProjection, type WorkspaceEventProjection } from './workspace-event-projection.js';
import { WorkspaceMemoryStore } from './workspace-memory.js';
import {
  WorkspaceClarifyPhaseExecutor,
  WorkspaceAcePhaseExecutor,
  WorkspacePlanPhaseExecutor,
  WorkspaceSpecifyPhaseExecutor,
  type WorkspaceEngineProjectItem,
  type WorkspaceEngineSnapshot,
  type WorkspacePhaseExecutorServices,
  type WorkspacePhaseOutcome,
  type WorkspacePhaseReporter,
} from './workspace-phase-executors.js';
import type { WorkspaceWorkflowPolicyConfig } from '@tik/shared';

export interface WorkspaceWorkflowEngineOptions
  extends Omit<WorkspacePhaseExecutorServices, 'contextAssembler' | 'policyEngine' | 'eventStore'> {
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

export class WorkspaceWorkflowEngine {
  readonly eventStore: WorkspaceEventStore;
  readonly contextAssembler: WorkspaceContextAssembler;
  readonly policyEngine: WorkspacePolicyEngine;
  readonly memoryStore?: WorkspaceMemoryStore;
  private readonly specifyExecutor: WorkspaceSpecifyPhaseExecutor;
  private readonly planExecutor: WorkspacePlanPhaseExecutor;
  private readonly aceExecutor: WorkspaceAcePhaseExecutor;
  private readonly clarifyExecutor: WorkspaceClarifyPhaseExecutor;

  constructor(private readonly services: WorkspaceWorkflowEngineOptions) {
    this.contextAssembler = services.contextAssembler ?? new WorkspaceContextAssembler();
    this.policyEngine = services.policyEngine ?? new WorkspacePolicyEngine(services.policyConfig);
    this.eventStore = services.eventStore ?? new WorkspaceEventStore();
    this.memoryStore = services.memoryStore;
    const phaseServices: WorkspacePhaseExecutorServices = {
      ...services,
      contextAssembler: this.contextAssembler,
      policyEngine: this.policyEngine,
      eventStore: this.eventStore,
    };
    this.clarifyExecutor = new WorkspaceClarifyPhaseExecutor(phaseServices);
    this.specifyExecutor = new WorkspaceSpecifyPhaseExecutor(phaseServices);
    this.planExecutor = new WorkspacePlanPhaseExecutor(phaseServices);
    this.aceExecutor = new WorkspaceAcePhaseExecutor(phaseServices);
  }

  async runPhase(args: {
    phase: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
    resolution: { workspace: { rootPath: string; workspaceFile: string } };
    snapshot: WorkspaceEngineSnapshot;
    items: WorkspaceEngineProjectItem[];
    provider: string;
    model?: string;
    autoAdvance: boolean;
    reporter: WorkspacePhaseReporter;
  }): Promise<WorkspaceWorkflowRunResult> {
    const phaseStartIndex = this.eventStore.snapshot().length;
    const outcome = args.phase === 'PARALLEL_CLARIFY'
      ? await this.clarifyExecutor.run(args)
      : args.phase === 'PARALLEL_SPECIFY'
      ? await this.specifyExecutor.run(args)
      : args.phase === 'PARALLEL_PLAN'
        ? await this.planExecutor.run(args)
        : await this.aceExecutor.run(args);
    const events = this.eventStore.snapshot().slice(phaseStartIndex);
    const projection = buildWorkspaceEventProjection(this.eventStore.snapshot());
    const latestSnapshot = await this.services.orchestrator.getStatus(args.resolution.workspace.rootPath);
    if (this.memoryStore) {
      await this.memoryStore.refresh({
        settings: latestSnapshot.settings,
        state: latestSnapshot.state,
        splitDemands: latestSnapshot.splitDemands,
        projection,
      });
    }
    if (args.phase === 'PARALLEL_CLARIFY' || args.phase === 'PARALLEL_SPECIFY') {
      return {
        ...outcome,
        events,
        projection,
        policy: this.policyEngine.getConfig(),
      };
    }
    return {
      ...outcome,
      events,
      projection,
      policy: this.policyEngine.getConfig(),
    };
  }
}
