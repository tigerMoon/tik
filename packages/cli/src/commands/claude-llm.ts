/**
 * Claude LLM Provider
 *
 * Uses Anthropic native tool_use API for reliable structured output.
 * Supports:
 *   ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for auth
 *   ANTHROPIC_BASE_URL for custom endpoints
 *   TIK_MODEL for model selection
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ILLMProvider,
  LLMPlanResponse,
  ChatMessage,
  ChatResponse,
  LLMToolDef,
  LLMCallOptions,
} from '@tik/shared';

/** Check if Claude API credentials are available */
export function hasClaudeCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// ─── Tool Definitions for plan generation ────────────────────

const PLAN_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'File path to read' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates parent directories)',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing a specific string',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'String to find' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern',
    input_schema: {
      type: 'object' as const,
      properties: { pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.java")' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents using regex',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'File or directory to search' },
        glob: { type: 'string', description: 'File filter (e.g. "*.java")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    description: 'Show git working tree status',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Show git diff',
    input_schema: {
      type: 'object' as const,
      properties: { args: { type: 'string', description: 'Additional git diff args' } },
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git commits',
    input_schema: {
      type: 'object' as const,
      properties: { count: { type: 'number', description: 'Number of commits' } },
    },
  },
];

const DEFAULT_STREAM_TIMEOUT_MS = 90_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldFallbackToNonStreaming(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes('unexpected event order')
    || lowered.includes('before "message_start"')
    || lowered.includes('before receiving "message_stop"')
  );
}

// ─── Claude LLM Provider ─────────────────────────────────────

export class ClaudeLLMProvider implements ILLMProvider {
  name = 'claude';
  private client: Anthropic;
  private model: string;
  private streamTimeoutMs: number;
  private streamIdleTimeoutMs: number;

  constructor(model = 'claude-sonnet-4-6') {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const envModel = process.env.TIK_MODEL;

    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
    this.model = envModel || model;
    this.streamTimeoutMs = parseTimeoutMs(
      process.env.TIK_CLAUDE_STREAM_TIMEOUT_MS,
      DEFAULT_STREAM_TIMEOUT_MS,
    );
    this.streamIdleTimeoutMs = parseTimeoutMs(
      process.env.TIK_CLAUDE_STREAM_IDLE_TIMEOUT_MS,
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    );
  }

  async plan(prompt: string, context: string): Promise<LLMPlanResponse> {
    const systemPrompt = `You are Tik, an AI agent that executes software engineering tasks.

Your workflow:
1. EXPLORE: Use tools to understand the codebase (read files, search, list directories)
2. PLAN: Once you understand the code, make the actual changes (write files, edit files)

You are working on a real project. Use tools to explore first, then implement.
When you have enough understanding, proceed to make changes.
After making all changes, respond with a text summary (no more tool calls).`;

    const userMessage = `Task: ${prompt}\n\nProject Context:\n${context.slice(0, 30000)}`;

    // Multi-turn tool use loop — like Claude Code
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userMessage },
    ];

    const allActions: Array<{ tool: string; input: Record<string, unknown>; reason: string }> = [];
    const maxTurns = 20; // Safety limit
    let reasoning = '';

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: PLAN_TOOLS,
        messages,
      });

      // Collect text blocks
      const textParts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text);
      if (textParts.length > 0) {
        reasoning = textParts.join('\n');
      }

      // Collect tool use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (process.env.TIK_DEBUG) {
        console.error(`\n[DEBUG] Turn ${turn + 1}: ${toolUseBlocks.length} tool calls, stop=${response.stop_reason}\n`);
        for (const t of toolUseBlocks) {
          console.error(`  [DEBUG] ${t.name}: ${JSON.stringify(t.input).slice(0, 100)}`);
        }
      }

      // If no tool calls, Claude is done — return the plan
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        // Any remaining tool calls from this turn are the final actions
        for (const block of toolUseBlocks) {
          allActions.push({
            tool: block.name,
            input: block.input as Record<string, unknown>,
            reason: '',
          });
        }
        break;
      }

      // Execute tool calls and feed results back to Claude
      // Add assistant message with the full response content
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool and build tool_result messages
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const result = await this.executeTool(block.name, block.input as Record<string, unknown>);

        allActions.push({
          tool: block.name,
          input: block.input as Record<string, unknown>,
          reason: result.success ? '' : `Error: ${result.error}`,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result.output === 'string'
            ? result.output.slice(0, 10000)
            : JSON.stringify(result.output).slice(0, 10000),
          is_error: !result.success,
        });
      }

      // Feed results back
      messages.push({ role: 'user', content: toolResults });
    }

    return {
      goals: [reasoning.split('\n')[0] || 'Execute the task'],
      actions: allActions,
      reasoning,
    };
  }

  /**
   * Execute a tool locally during the planning phase.
   * This enables the multi-turn explore → plan → execute loop.
   */
  private async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ success: boolean; output: unknown; error?: string }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs/promises');
    const execFileAsync = promisify(execFile);

    try {
      switch (name) {
        case 'bash': {
          const cmd = String(input.command || '');
          const { stdout, stderr } = await execFileAsync('bash', ['-c', cmd], {
            timeout: 30_000,
            maxBuffer: 1024 * 1024 * 5,
          });
          return { success: true, output: stdout + (stderr ? `\nSTDERR: ${stderr}` : '') };
        }
        case 'read_file': {
          const content = await fs.readFile(String(input.path), 'utf-8');
          return { success: true, output: content };
        }
        case 'write_file': {
          const { mkdir } = await import('node:fs/promises');
          const { dirname } = await import('node:path');
          await mkdir(dirname(String(input.path)), { recursive: true });
          await fs.writeFile(String(input.path), String(input.content), 'utf-8');
          return { success: true, output: `Written ${String(input.content).length} bytes to ${input.path}` };
        }
        case 'edit_file': {
          const content = await fs.readFile(String(input.path), 'utf-8');
          if (!content.includes(String(input.old_string))) {
            return { success: false, output: null, error: 'String not found' };
          }
          await fs.writeFile(String(input.path), content.replace(String(input.old_string), String(input.new_string)), 'utf-8');
          return { success: true, output: `Edited ${input.path}` };
        }
        case 'glob': {
          const { stdout } = await execFileAsync('find', ['.', '-name', String(input.pattern), '-maxdepth', '5'], {
            timeout: 10_000,
          });
          return { success: true, output: stdout };
        }
        case 'grep': {
          try {
            const { stdout } = await execFileAsync('grep', ['-rn', '--max-count=30', String(input.pattern), String(input.path || '.')], {
              timeout: 10_000,
            });
            return { success: true, output: stdout };
          } catch (e) {
            return { success: true, output: 'No matches' };
          }
        }
        case 'git_status': {
          const { stdout } = await execFileAsync('git', ['status', '--short'], { timeout: 5_000 });
          return { success: true, output: stdout };
        }
        case 'git_diff': {
          const { stdout } = await execFileAsync('git', ['diff', '--stat'], { timeout: 5_000 });
          return { success: true, output: stdout };
        }
        case 'git_log': {
          const { stdout } = await execFileAsync('git', ['log', '--oneline', '-n', String(input.count || 10)], { timeout: 5_000 });
          return { success: true, output: stdout };
        }
        default:
          return { success: false, output: null, error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message };
    }
  }

  async complete(prompt: string, _options?: LLMCallOptions): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
  }

  async chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse> {
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const systemMsg = messages.find(m => m.role === 'system')?.content;

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: 4096,
      messages: anthropicMessages,
    };
    if (systemMsg) params.system = systemMsg;

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }));
    }

    const response = await this.client.messages.create(params);

    return this.parseResponse(response);
  }

  /**
   * Multi-turn chat with explicit system prompt and context.
   * Supports streaming via options.onTextChunk callback.
   */
  async chatWithContext(
    messages: ChatMessage[],
    systemPrompt: string,
    context: string,
    tools?: LLMToolDef[],
    options?: LLMCallOptions,
  ): Promise<ChatResponse> {
    // Build Anthropic messages from ChatMessage[], handling tool results properly
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // system prompt passed separately

      if (msg.role === 'tool') {
        // Tool results must be sent as user messages with tool_result content blocks
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId || 'unknown',
          content: msg.content.slice(0, 10000),
        };
        // Merge consecutive tool results into one user message
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Anthropic.ToolResultBlockParam[]).push(toolResultBlock);
        } else {
          anthropicMessages.push({ role: 'user', content: [toolResultBlock] });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        // Reconstruct full assistant message with tool_use blocks
        // This is critical: Claude API requires tool_use blocks in assistant
        // messages to match with subsequent tool_result blocks
        if (msg.toolCalls?.length) {
          const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          anthropicMessages.push({ role: 'assistant', content: blocks });
        } else {
          anthropicMessages.push({ role: 'assistant', content: msg.content });
        }
        continue;
      }

      // user messages
      anthropicMessages.push({ role: 'user', content: msg.content });
    }

    // Build system prompt with cache_control for prompt caching
    // Anthropic caches system prompt blocks marked with cache_control,
    // so repeated calls within a session avoid re-processing the same prefix
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    systemBlocks.push({
      type: 'text',
      text: systemPrompt,
      ...(context ? {} : { cache_control: { type: 'ephemeral' } }),
    } as any);
    if (context) {
      systemBlocks.push({
        type: 'text',
        text: `<project-context>\n${context.slice(0, 30000)}\n</project-context>`,
        cache_control: { type: 'ephemeral' },
      } as any);
    }

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: 4096,
      system: systemBlocks,
      messages: anthropicMessages,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }));
    }

    // Use streaming API for real-time output
    if (options?.onTextChunk) {
      const stream = this.client.messages.stream(params);
      let streamTimedOut = false;
      let timeoutReason = 'unknown';
      let lastActivityAt = Date.now();
      let absoluteTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const refreshActivity = () => {
        lastActivityAt = Date.now();
      };

      const scheduleIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          streamTimedOut = true;
          timeoutReason = `idle timeout after ${this.streamIdleTimeoutMs}ms without Claude stream activity`;
          stream.abort();
        }, this.streamIdleTimeoutMs);
      };

      const clearTimers = () => {
        if (absoluteTimer) clearTimeout(absoluteTimer);
        if (idleTimer) clearTimeout(idleTimer);
      };

      absoluteTimer = setTimeout(() => {
        streamTimedOut = true;
        timeoutReason = `overall timeout after ${this.streamTimeoutMs}ms waiting for Claude response`;
        stream.abort();
      }, this.streamTimeoutMs);

      scheduleIdleTimer();

      stream.on('text', (text) => {
        refreshActivity();
        scheduleIdleTimer();
        options.onTextChunk!(text);
      });

      stream.on('streamEvent', () => {
        refreshActivity();
        scheduleIdleTimer();
      });

      stream.on('message', () => {
        refreshActivity();
        scheduleIdleTimer();
      });

      try {
        const response = await stream.finalMessage();
        return this.parseResponse(response);
      } catch (error) {
        if (streamTimedOut) {
          try {
            if (process.env.TIK_DEBUG) {
              console.error('[DEBUG] Claude stream timed out, falling back to non-streaming request');
            }
            const response = await this.client.messages.create(params);
            return this.parseResponse(response);
          } catch {
            throw new Error(
              `Claude stream timed out: ${timeoutReason}. Last activity was ${Date.now() - lastActivityAt}ms ago.`,
            );
          }
        }

        if (shouldFallbackToNonStreaming(error)) {
          if (process.env.TIK_DEBUG) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[DEBUG] Claude stream parser failed, falling back to non-streaming request: ${message}`);
          }

          const response = await this.client.messages.create(params);
          return this.parseResponse(response);
        }

        throw error;
      } finally {
        clearTimers();
      }
    }

    // Non-streaming fallback
    const response = await this.client.messages.create(params);
    return this.parseResponse(response);
  }

  /** Parse Anthropic response into ChatResponse */
  private parseResponse(response: Anthropic.Message): ChatResponse {
    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => ({
        id: b.id,
        name: b.name,
        arguments: b.input as Record<string, unknown>,
      }));

    // Include cache hit info in usage for observability
    const usage = response.usage as any;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        cacheReadTokens: cacheRead,
        cacheCreateTokens: cacheCreate,
      },
    };
  }
}
