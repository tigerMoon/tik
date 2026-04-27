/**
 * LLM Provider Types
 *
 * Pluggable LLM interface for Tik.
 * Supports multiple providers (Claude, OpenAI, etc.)
 */

// ─── LLM Provider Interface ─────────────────────────────────

export interface ILLMProvider {
  /** Provider name */
  name: string;

  /** Generate a plan from context */
  plan(prompt: string, context: string): Promise<LLMPlanResponse>;

  /** Generate a completion */
  complete(prompt: string, options?: LLMCallOptions): Promise<string>;

  /** Chat completion with tool use */
  chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse>;

  /**
   * Multi-turn chat with system prompt and structured context.
   * Used by session-based AgentLoop for continuous reasoning.
   * Falls back to chat() if not implemented.
   */
  chatWithContext?(
    messages: ChatMessage[],
    systemPrompt: string,
    context: string,
    tools?: LLMToolDef[],
    options?: LLMCallOptions,
  ): Promise<ChatResponse>;
}

// ─── LLM Call Options ───────────────────────────────────────

export interface LLMCallOptions {
  /** Callback for streaming text chunks */
  onTextChunk?: (text: string) => void;
  /** Callback when a tool_use block is fully received */
  onToolUse?: (toolCall: LLMToolCall) => void;
  /** Callback for provider-native runtime events (e.g. Codex CLI tool execution) */
  onProviderEvent?: (event: ProviderRuntimeEvent) => void;
  /** Hint that this completion call may need write-capable execution */
  allowWrites?: boolean;
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

export type ProviderRuntimeEvent =
  | {
      type: 'tool.called';
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool.result';
      toolName: string;
      output: unknown;
      success: boolean;
      error?: string;
      durationMs?: number;
    };

// ─── Chat Types ──────────────────────────────────────────────

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
