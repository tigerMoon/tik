/**
 * Claude LLM Provider
 *
 * Uses Anthropic native tool_use API for reliable structured output.
 * Supports:
 *   ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for auth
 *   ANTHROPIC_BASE_URL for custom endpoints
 *   TIK_MODEL for model selection
 */
import type { ILLMProvider, LLMPlanResponse, ChatMessage, ChatResponse, LLMToolDef, LLMCallOptions } from '@tik/shared';
/** Check if Claude API credentials are available */
export declare function hasClaudeCredentials(): boolean;
export declare class ClaudeLLMProvider implements ILLMProvider {
    name: string;
    private client;
    private model;
    private streamTimeoutMs;
    private streamIdleTimeoutMs;
    constructor(model?: string);
    plan(prompt: string, context: string, options?: LLMCallOptions): Promise<LLMPlanResponse>;
    /**
     * Execute a read-only tool locally during the planning phase.
     */
    private executePlanTool;
    complete(prompt: string, _options?: LLMCallOptions): Promise<string>;
    chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse>;
    /**
     * Multi-turn chat with explicit system prompt and context.
     * Supports streaming via options.onTextChunk callback.
     */
    chatWithContext(messages: ChatMessage[], systemPrompt: string, context: string, tools?: LLMToolDef[], options?: LLMCallOptions): Promise<ChatResponse>;
    /** Parse Anthropic response into ChatResponse */
    private parseResponse;
}
//# sourceMappingURL=claude-llm.d.ts.map