import type { ProviderOption } from '../types.js';
import { hasClaudeCredentials } from '../commands/claude-llm.js';
import { hasOpenAICredentials } from '../commands/openai-llm.js';
import { hasCodexCli, hasCodexLogin } from '../commands/codex-cli.js';

export const interactiveProviderHelp = 'LLM provider (default: codex): auto, claude, openai, codex (governed implementation), codex-delegate (delegated subtask execution), mock';
export const planningProviderHelp = 'LLM provider (default: codex): auto, claude, openai, codex, mock';
export const serverProviderHelp = 'LLM provider (default: codex): auto, claude, openai, codex, mock';

export function resolveProvider(provider: ProviderOption = 'codex'): ProviderOption {
  const envProvider = (process.env.TIK_LLM_PROVIDER as ProviderOption | undefined) || 'codex';
  const requested = provider === 'auto' ? envProvider : provider;

  if (requested === 'mock') return 'mock';
  if (requested === 'claude') {
    if (!hasClaudeCredentials()) throw new Error('Claude credentials not found. Set ANTHROPIC_API_KEY.');
    return 'claude';
  }
  if (requested === 'openai') {
    if (!hasOpenAICredentials()) throw new Error('OpenAI credentials not found. Set OPENAI_API_KEY.');
    return 'openai';
  }
  if (requested === 'codex') {
    if (!hasCodexCli()) throw new Error('Codex CLI not found. Install `codex` first.');
    if (!hasCodexLogin()) throw new Error('Codex CLI is not logged in. Run `codex login` first.');
    return 'codex';
  }
  if (requested === 'codex-delegate') {
    if (!hasCodexCli()) throw new Error('Codex CLI not found. Install `codex` first.');
    if (!hasCodexLogin()) throw new Error('Codex CLI is not logged in. Run `codex login` first.');
    return 'codex-delegate';
  }

  if (hasCodexCli() && hasCodexLogin()) return 'codex';
  if (hasClaudeCredentials()) return 'claude';
  if (hasOpenAICredentials()) return 'openai';
  return 'mock';
}
