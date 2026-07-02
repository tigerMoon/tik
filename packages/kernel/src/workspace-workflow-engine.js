import { WorkspaceContextAssembler } from './workspace-context-assembler.js';
import { WorkspacePolicyEngine } from './workspace-policy-engine.js';
import { WorkspaceEventStore } from './workspace-event-store.js';
import { buildWorkspaceEventProjection } from './workspace-event-projection.js';
import { WorkspaceClarifyPhaseExecutor, WorkspaceAcePhaseExecutor, WorkspacePlanPhaseExecutor, WorkspaceSpecifyPhaseExecutor, } from './workspace-phase-executors.js';
export class WorkspaceWorkflowEngine {
    services;
    eventStore;
    contextAssembler;
    policyEngine;
    memoryStore;
    specifyExecutor;
    planExecutor;
    aceExecutor;
    clarifyExecutor;
    constructor(services) {
        this.services = services;
        this.contextAssembler = services.contextAssembler ?? new WorkspaceContextAssembler();
        this.policyEngine = services.policyEngine ?? new WorkspacePolicyEngine(services.policyConfig);
        this.eventStore = services.eventStore ?? new WorkspaceEventStore();
        this.memoryStore = services.memoryStore;
        const phaseServices = {
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
    async runPhase(args) {
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
//# sourceMappingURL=workspace-workflow-engine.js.map