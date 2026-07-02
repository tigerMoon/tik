import { ClaudeCodeRunner } from './claude-code-runner.js';
import { CodexRunner } from './codex-runner.js';
export function createDefaultRuntimeRunners() {
    return {
        codex: new CodexRunner({ executable: process.env.TIK_CODEX_BIN || 'codex' }),
        'claude-code': new ClaudeCodeRunner({ executable: process.env.TIK_CLAUDE_CODE_BIN || 'claude' }),
    };
}
//# sourceMappingURL=default-runtime-runners.js.map