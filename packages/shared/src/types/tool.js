/**
 * Tool System Types
 *
 * Standardized tool interface with scheduling support.
 * Tools are categorized by type to determine execution strategy:
 * - READ: parallel execution allowed
 * - WRITE: serial execution (one at a time)
 * - EXEC: blocking execution (waits for completion)
 */
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
};
//# sourceMappingURL=tool.js.map