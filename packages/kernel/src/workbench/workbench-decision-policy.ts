const HIGH_RISK_TOOLS = new Set(['git_commit', 'git_push', 'bash']);

export function shouldRequestDecisionForTool(toolName: string, input: unknown): boolean {
  if (toolName === 'bash') {
    const command = JSON.stringify(input ?? {});
    return /rm\s+-rf|sudo\s+rm|chmod\s+-R\s+777|curl\b.*\|\s*(?:sh|bash)|wget\b.*\|\s*(?:sh|bash)|kubectl|deploy|publish|git push|git merge/i.test(command);
  }

  return HIGH_RISK_TOOLS.has(toolName);
}
