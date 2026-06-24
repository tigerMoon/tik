import type { AgentRuntimeName } from '../tracker-daemon/types.js';
import type { AgentRuntimeRunner } from './agent-runtime-runner.js';
import { ClaudeCodeRunner } from './claude-code-runner.js';
import { CodexRunner } from './codex-runner.js';

export function createDefaultRuntimeRunners(): Partial<Record<AgentRuntimeName, AgentRuntimeRunner>> {
  return {
    codex: new CodexRunner({ executable: process.env.TIK_CODEX_BIN || 'codex' }),
    'claude-code': new ClaudeCodeRunner({ executable: process.env.TIK_CLAUDE_CODE_BIN || 'claude' }),
  };
}
