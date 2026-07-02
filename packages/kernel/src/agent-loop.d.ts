/**
 * Agent Loop (Phase 2 - Session-Based)
 *
 * The unified execution loop for both single-agent and multi-agent modes.
 * Uses AgentSession for multi-turn LLM continuity and agent role collaboration.
 *
 * Architecture (from roadmap_2.md):
 *   Task → Session → AgentLoop → single/multi agent → EventBus
 *
 * Key constraints:
 *   - Task.status is the external lifecycle (driven by ExecutionKernel)
 *   - Session.loopState is internal control only
 *   - EventBus remains SSOT
 *   - Multi-agent roles share one taskId, one sessionId, one event stream
 *
 * Execution flow per step:
 *   1. Build context (SIGHT)
 *   2. LLM call with message history + context
 *   3. Record assistant response to messages
 *   4. Execute tool calls, record results to messages
 *   5. Evaluate (if appropriate for current agent/mode)
 *   6. Switch agent (multi mode, after evaluation)
 */
import type { Task, TaskResult, EvaluationSnapshot, IEventBus, ILLMProvider, IContextBuilder, ControlCommand, ConvergenceStrategy, AgentSession, RuntimeContextEnvelope, ToolResultRef } from '@tik/shared';
import type { ToolScheduler } from './tool-scheduler.js';
/** Renders RuntimeContextEnvelope into a formatted string for LLM */
export interface IContextRenderer {
    render(envelope: RuntimeContextEnvelope): string;
}
/** Stores large tool results externally, returns preview reference */
export interface IToolResultStore {
    shouldStore(output: string): boolean;
    store(taskId: string, toolCallId: string, toolName: string, output: string, isError?: boolean): Promise<ToolResultRef>;
}
export interface IACEEngine {
    evaluateIteration(taskId: string, iteration: number): Promise<EvaluationSnapshot>;
    checkConvergence(evaluation: EvaluationSnapshot, stableCount: number, strategy: ConvergenceStrategy): boolean;
}
/** Callback for streaming text chunks from LLM */
export type StreamChunkHandler = (chunk: string, meta: {
    taskId: string;
    agent: string;
}) => void;
export declare class AgentLoop {
    private eventBus;
    private toolScheduler;
    private contextBuilder;
    private llmProvider;
    private aceEngine;
    private onPhaseChange?;
    private contextRenderer?;
    private toolResultStore?;
    private onStreamChunk?;
    private injectedConstraints;
    private currentStrategy;
    private pendingPlanPatch;
    constructor(eventBus: IEventBus, toolScheduler: ToolScheduler, contextBuilder: IContextBuilder, llmProvider: ILLMProvider, aceEngine: IACEEngine, onPhaseChange?: (status: string) => void, contextRenderer?: IContextRenderer, toolResultStore?: IToolResultStore, onStreamChunk?: StreamChunkHandler);
    /**
     * Run the agent loop.
     *
     * If a session is provided, uses session-based multi-turn execution.
     * If not, falls back to legacy per-iteration mode (Phase 1 compat).
     */
    run(task: Task, session?: AgentSession): Promise<TaskResult>;
    private runSessionBased;
    private static readonly LLM_MAX_RETRIES;
    private static readonly LLM_RETRY_DELAYS;
    private callLLM;
    private callLLMOnce;
    private emitUsageEvent;
    /** Determine if an LLM error is retryable */
    private isRetryableError;
    private handleToolCalls;
    private runProjectHarnessIfNeeded;
    private hasValidationTool;
    private resolveInferredProjectHarnessCommands;
    private readConfiguredHarnessCommands;
    private inferDefaultHarnessCommand;
    /** Record a single tool result to session messages and events */
    private recordToolResult;
    private recordPolicyDeniedToolCalls;
    private getImplementationToolDefs;
    private constrainToolDefsForSession;
    private enterStrictImplementationMode;
    private nextAgent;
    private isDelegateProvider;
    private shouldEvaluate;
    /**
     * Convert a Zod schema (or raw object) to a valid JSON Schema
     * that LLM providers (Claude/OpenAI) require.
     */
    private toJsonSchema;
    private zodToJsonSchema;
    private isOptionalZod;
    private getAgentSpec;
    private getToolDefs;
    private buildContextString;
    private appendTaskContextSnapshot;
    private renderTaskContextSnapshot;
    private extractLikelyTargetPaths;
    private pushMessage;
    /**
     * Update session.contextSummary with structured session memory.
     * Rule-based extraction — no LLM calls.
     * Tracks: goal, key files, recent actions, decisions, blockers.
     */
    private updateContextSummary;
    private renderCompactMemory;
    private extractRelevantPaths;
    private extractPathsFromText;
    handleControl(command: ControlCommand, session?: AgentSession): void;
    private waitForSessionRunState;
    private runLegacy;
    private generatePlan;
    private executePlan;
    private emitEvent;
}
//# sourceMappingURL=agent-loop.d.ts.map