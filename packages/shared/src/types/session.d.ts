/**
 * Session Types
 *
 * Session is the internal runtime container for AgentLoop.
 * It provides multi-turn continuity and multi-agent collaboration
 * without replacing the external Task/Event contract.
 *
 * Key constraints:
 * - Task.status is the external lifecycle (visible to CLI/API/Dashboard)
 * - Session.loopState is internal control only
 * - EventBus remains SSOT; Session is working memory
 * - Multi-agent roles share one taskId, one sessionId, one event stream
 */
import type { ChatMessage, ILLMProvider } from './llm.js';
import type { EvaluationSnapshot } from './task.js';
export type AgentRole = 'planner' | 'coder' | 'reviewer';
export type ExecutionMode = 'single' | 'multi';
export interface AgentRuntime {
    /** Role identifier */
    role: AgentRole;
    /** Role-specific system prompt */
    systemPrompt: string;
    /** LLM provider for this role */
    llm: ILLMProvider;
}
export interface AgentSession {
    /** Unique session ID */
    sessionId: string;
    /** Associated task ID */
    taskId: string;
    /** Accumulated message history for multi-turn reasoning */
    messages: ChatMessage[];
    /** Compressed summary of older messages (token management) */
    contextSummary?: string;
    /** Structured continuation-style memory distilled from prior work */
    compactMemory?: SessionCompactMemory;
    /** Loop control state (internal only, NOT exposed as task status) */
    loopState: 'running' | 'paused' | 'stopped';
    /** Single-agent or multi-agent mode */
    mode: ExecutionMode;
    /** Registered agents (planner/coder/reviewer) */
    agents: Partial<Record<AgentRole, AgentRuntime>>;
    /** Currently active agent role */
    currentAgent: AgentRole;
    /** Last evaluation result */
    lastEvaluation?: EvaluationSnapshot;
    /** Current step counter */
    step: number;
}
export interface SessionCompactMemory {
    goal?: string;
    keyFiles?: string[];
    pendingWork?: string[];
    currentWork?: string;
    blockers?: string[];
    recentActions?: string[];
    implementationReady?: boolean;
    implementationStrict?: boolean;
    currentFocus?: 'exploration' | 'implementation';
    currentAgent?: AgentRole;
    step?: number;
}
//# sourceMappingURL=session.d.ts.map