/**
 * LLM Provider Types
 *
 * Pluggable LLM interface for Tik.
 * Supports multiple providers (Claude, OpenAI, etc.)
 */
export interface ILLMProvider {
    /** Provider name */
    name: string;
    /** Generate a plan from context. Providers must treat this as plan-only and enforce a read-only tool policy. */
    plan(prompt: string, context: string, options?: LLMCallOptions): Promise<LLMPlanResponse>;
    /** Generate a completion */
    complete(prompt: string, options?: LLMCallOptions): Promise<string>;
    /** Chat completion with tool use */
    chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse>;
    /**
     * Multi-turn chat with system prompt and structured context.
     * Used by session-based AgentLoop for continuous reasoning.
     * Falls back to chat() if not implemented.
     */
    chatWithContext?(messages: ChatMessage[], systemPrompt: string, context: string, tools?: LLMToolDef[], options?: LLMCallOptions): Promise<ChatResponse>;
}
export interface LLMCallOptions {
    /** Working directory for provider-native execution and instruction discovery. */
    cwd?: string;
    /** Callback for streaming text chunks */
    onTextChunk?: (text: string) => void;
    /** Callback when a tool_use block is fully received */
    onToolUse?: (toolCall: LLMToolCall) => void;
    /** Callback for provider-native runtime events (e.g. Codex CLI tool execution) */
    onProviderEvent?: (event: ProviderRuntimeEvent) => void;
    /** Hint that this completion call may need write-capable execution */
    allowWrites?: boolean;
    /** Explicit provider-native tool policy for the current phase. */
    toolPolicy?: LLMToolPolicy;
    /** Abort the provider call if the caller decides the run should stop */
    signal?: AbortSignal;
    /**
     * Stable runtime session key for provider-native state.
     *
     * Tik owns Task/Event/Session as the external contract, but providers such
     * as Codex App Server can maintain their own thread state. When this value is
     * present, provider implementations should reuse the same native provider
     * session/thread across turns. When absent, providers may run an ephemeral
     * one-shot session.
     */
    providerSessionId?: string;
}
export interface LLMToolPolicy {
    /** Planning calls are read-only; execution calls may expose write/exec tools when the caller allows them. */
    phase: 'plan' | 'execute';
    /** Exact provider-native tools allowed during this call. */
    allowedTools: readonly string[];
    /** Whether provider-native file writes/edits are allowed. */
    allowWrites: boolean;
    /** Whether provider-native shell/exec tools are allowed. */
    allowExec: boolean;
}
export declare const PLAN_READ_ONLY_TOOL_NAMES: readonly ["read_file", "glob", "grep", "git_status", "git_diff", "git_log"];
export declare const PLAN_READ_ONLY_TOOL_POLICY: LLMToolPolicy;
export type ProviderRuntimeEvent = {
    type: 'tool.called';
    toolName: string;
    input: Record<string, unknown>;
} | {
    type: 'tool.result';
    toolName: string;
    output: unknown;
    success: boolean;
    error?: string;
    durationMs?: number;
};
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Tool call ID (for tool result messages) */
    toolCallId?: string;
    /** Agent role name (for multi-agent attribution) */
    name?: string;
    /** Tool calls from assistant message (preserved for API fidelity) */
    toolCalls?: LLMToolCall[];
}
export interface ChatResponse {
    content: string;
    toolCalls?: LLMToolCall[];
    executedActions?: Array<{
        tool: string;
        input: unknown;
        output?: unknown;
        success: boolean;
    }>;
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        /** Tokens read from cache (Anthropic prompt caching) */
        cacheReadTokens?: number;
        /** Tokens written to cache (Anthropic prompt caching) */
        cacheCreateTokens?: number;
    };
}
export interface LLMToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface LLMToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface LLMPlanResponse {
    goals: string[];
    actions: Array<{
        tool: string;
        input: unknown;
        reason: string;
    }>;
    reasoning: string;
}
//# sourceMappingURL=llm.d.ts.map