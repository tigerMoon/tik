const HIGH_RISK_TOOLS = new Set(['git_commit', 'git_push', 'bash']);
export function shouldRequestDecisionForTool(toolName, input) {
    if (toolName === 'bash') {
        const command = extractCommand(input);
        if (isDangerousShellCommand(command)) {
            return true;
        }
        return !isAllowlistedShellCommand(command);
    }
    return HIGH_RISK_TOOLS.has(toolName);
}
function extractCommand(input) {
    if (input && typeof input === 'object' && 'command' in input) {
        const command = input.command;
        return typeof command === 'string' ? command.trim() : '';
    }
    return '';
}
function isDangerousShellCommand(command) {
    return /(^|[;&|]\s*)(sudo\s+)?rm\b/i.test(command)
        || /(^|[;&|]\s*)mv\b.+\s\/(?:tmp|var|etc|usr|bin|sbin|opt|Library|System|Users)\b/i.test(command)
        || /(^|[;&|]\s*)chmod\b/i.test(command)
        || /(^|[;&|]\s*)chown\b/i.test(command)
        || /\bgit\s+reset\b.*\s--hard\b/i.test(command)
        || /\bgit\s+clean\b/i.test(command)
        || /\bgit\s+push\b/i.test(command)
        || /\bgit\s+merge\b/i.test(command)
        || /\b(?:curl|wget)\b.*\|\s*(?:sh|bash)\b/i.test(command)
        || /\bkubectl\b/i.test(command)
        || /\bdeploy\b/i.test(command)
        || /\bpublish\b/i.test(command);
}
function isAllowlistedShellCommand(command) {
    return /^(?:corepack\s+)?pnpm\s+(?:test|typecheck|build|lint)(?:\b|$)/i.test(command)
        || /^npm\s+(?:test|run\s+(?:test|typecheck|build|lint))(?:\b|$)/i.test(command)
        || /^yarn\s+(?:test|typecheck|build|lint)(?:\b|$)/i.test(command)
        || /^git\s+(?:status|diff|log|show)(?:\b|$)/i.test(command)
        || /^(?:pwd|date|true|false)$/i.test(command);
}
//# sourceMappingURL=workbench-decision-policy.js.map