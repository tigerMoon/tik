/**
 * LLM Provider Types
 *
 * Pluggable LLM interface for Tik.
 * Supports multiple providers (Claude, OpenAI, etc.)
 */
export const PLAN_READ_ONLY_TOOL_NAMES = [
    'read_file',
    'glob',
    'grep',
    'git_status',
    'git_diff',
    'git_log',
];
export const PLAN_READ_ONLY_TOOL_POLICY = {
    phase: 'plan',
    allowedTools: PLAN_READ_ONLY_TOOL_NAMES,
    allowWrites: false,
    allowExec: false,
};
//# sourceMappingURL=llm.js.map