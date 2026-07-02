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
export type ToolType = 'read' | 'write' | 'exec';
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
export interface IToolScheduler {
    /** Execute a tool with appropriate scheduling */
    execute(toolName: string, input: unknown, context: ToolContext): Promise<ToolResult>;
    /** Execute multiple tools with dependency awareness */
    executeBatch(actions: Array<{
        toolName: string;
        input: unknown;
        dependsOn?: number[];
    }>, context: ToolContext): Promise<ToolResult[]>;
    /** Cancel all running tools */
    cancelAll(): Promise<void>;
}
export declare const BuiltinTools: {
    readonly READ_FILE: "read_file";
    readonly WRITE_FILE: "write_file";
    readonly EDIT_FILE: "edit_file";
    readonly GLOB: "glob";
    readonly GREP: "grep";
    readonly BASH: "bash";
    readonly GIT_STATUS: "git_status";
    readonly GIT_DIFF: "git_diff";
    readonly GIT_LOG: "git_log";
    readonly GIT_COMMIT: "git_commit";
};
//# sourceMappingURL=tool.d.ts.map