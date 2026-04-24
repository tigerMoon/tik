/**
 * Tool System Types
 *
 * Standardized tool interface with scheduling support.
 * Tools are categorized by type to determine execution strategy:
 * - READ: parallel execution allowed
 * - WRITE: serial execution (one at a time)
 * - EXEC: blocking execution (waits for completion)
 */

import { z } from 'zod';

// ─── Tool Types ──────────────────────────────────────────────

export type ToolType = 'read' | 'write' | 'exec';

// ─── Tool Interface ──────────────────────────────────────────

export interface Tool {
  /** Unique tool name */
  name: string;
  /** Tool type (determines scheduling) */
  type: ToolType;
  /** Human-readable description */
  description: string;
  /** Input schema (zod schema) */
  inputSchema: z.ZodType;
  /** Execute the tool */
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

// ─── Tool Context ────────────────────────────────────────────

export interface ToolContext {
  /** Current working directory */
  cwd: string;
  /** Task ID being executed */
  taskId: string;
  /** High-probability absolute paths inferred from the current task */
  likelyTargetPaths?: string[];
  /** Whether session memory indicates implementation should be prioritized over exploration */
  implementationReady?: boolean;
  /** Environment variables */
  env?: Record<string, string>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

// ─── Tool Result ─────────────────────────────────────────────

export interface ToolResult {
  /** Whether the tool succeeded */
  success: boolean;
  /** Output data */
  output: unknown;
  /** Error message if failed */
  error?: string;
  /** Files modified */
  filesModified?: string[];
  /** Execution duration in ms */
  durationMs: number;
}

// ─── Tool Registry ───────────────────────────────────────────

export interface IToolRegistry {
  /** Register a tool */
  register(tool: Tool): void;

  /** Get a tool by name */
  get(name: string): Tool | undefined;

  /** List all registered tools */
  list(): Tool[];

  /** Check if a tool exists */
  has(name: string): boolean;
}

// ─── Tool Scheduler ──────────────────────────────────────────

export interface IToolScheduler {
  /** Execute a tool with appropriate scheduling */
  execute(toolName: string, input: unknown, context: ToolContext): Promise<ToolResult>;

  /** Execute multiple tools with dependency awareness */
  executeBatch(
    actions: Array<{
      toolName: string;
      input: unknown;
      dependsOn?: number[];
    }>,
    context: ToolContext,
  ): Promise<ToolResult[]>;

  /** Cancel all running tools */
  cancelAll(): Promise<void>;
}

// ─── Built-in Tool Names ─────────────────────────────────────

export const BuiltinTools = {
  // File operations
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  EDIT_FILE: 'edit_file',
  GLOB: 'glob',
  GREP: 'grep',

  // Shell operations
  BASH: 'bash',

  // Git operations
  GIT_STATUS: 'git_status',
  GIT_DIFF: 'git_diff',
  GIT_LOG: 'git_log',
  GIT_COMMIT: 'git_commit',
} as const;
