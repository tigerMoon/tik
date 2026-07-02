/**
 * Context Engine (Phase 2.8)
 *
 * Unified context builder for Tik.
 * Pipeline: Raw Fragments → Ranker → Budgeter → Packager → AgentContext
 *
 * Phase 2.8 additions:
 * - buildFromSession returns RuntimeContextEnvelope
 * - BootstrapContextBuilder for environment snapshot
 * - MicroCompactor for session message cleanup
 */
import type { AgentContext, IContextBuilder, IEventBus, RuntimeContextEnvelope, BuildContextOptions } from '@tik/shared';
import type { IContextProvider } from '../plugin/types.js';
export declare class ContextEngine implements IContextBuilder {
    private ranker;
    private budgeter;
    private providers;
    private eventBus?;
    private projectPath;
    private bootstrapBuilder;
    private compactor;
    private candidateFinder;
    private environmentPackLoader;
    constructor(projectPath: string, eventBus?: IEventBus);
    /** Register a context provider */
    addProvider(provider: IContextProvider): void;
    /** Build unified context for a task */
    buildContext(taskId: string, iteration: number, options?: BuildContextOptions): Promise<AgentContext>;
    /** Build session-aware context returning RuntimeContextEnvelope (Phase 2.8) */
    buildFromSession(task: any, session: any, options?: BuildContextOptions): Promise<RuntimeContextEnvelope>;
    updateContext(_taskId: string, _updates: Partial<AgentContext>): Promise<void>;
    private packageContext;
    private extractSpecContext;
    private extractRepoContext;
    private extractGuardrailContext;
    private extractRunContext;
    private extractMemoryContext;
}
//# sourceMappingURL=context-engine.d.ts.map