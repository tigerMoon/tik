import type { SessionCompactMemory } from '@tik/shared';

export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ExecutedActionLike {
  tool: string;
  input: unknown;
  output?: unknown;
  success: boolean;
}

export type TaskIntent = 'implementation' | 'analysis' | 'review' | 'unknown';

const READ_LIKE_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
]);

const CREATION_STYLE_VERBS = [
  '设计一个',
  '做一个',
  '创建一个',
  '生成一个',
  '搭一个',
  '写一个',
  'build ',
  'create ',
  'make ',
];

const CREATION_STYLE_ARTIFACT_HINTS = [
  '页面',
  '网页',
  'h5',
  'html',
  '游戏',
  'demo',
  'app',
  '应用',
  '组件',
  '网站',
  'landing page',
  'tool',
  '工具',
  '脚本',
  'script',
  'bot',
];

export function normalizeToolCall(call: RuntimeToolCall): RuntimeToolCall {
  if (call.name !== 'bash') return call;

  const command = String(call.arguments.command || '').trim();
  const catMatch = command.match(/^cat(?:\s+-[A-Za-z]+)*\s+(.+)$/);
  if (catMatch) {
    const rawPath = catMatch[1].trim().replace(/^["']|["']$/g, '');
    if (!rawPath || rawPath.includes('|') || rawPath.includes('>') || rawPath.includes('<')) {
      return call;
    }

    return {
      id: call.id,
      name: 'read_file',
      arguments: {
        path: rawPath,
      },
    };
  }

  const findAsGlob = normalizeFindCommand(command);
  if (findAsGlob) {
    return {
      id: call.id,
      name: 'glob',
      arguments: {
        pattern: findAsGlob,
      },
    };
  }

  return call;
}

export function dedupeToolCalls(calls: RuntimeToolCall[]): RuntimeToolCall[] {
  const deduped: RuntimeToolCall[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    const signature = getToolCallSignature(call);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(call);
  }

  return deduped;
}

export function getToolCallSignature(call: RuntimeToolCall): string {
  return `${call.name}:${stableStringify(call.arguments)}`;
}

export function isReadLikeTool(toolName: string): boolean {
  return READ_LIKE_TOOLS.has(toolName);
}

export function isRedundantReadBatch(
  calls: RuntimeToolCall[],
  successfulReadSignatures: Set<string>,
): boolean {
  if (calls.length === 0) return false;
  return calls.every((call) => {
    if (!isReadLikeTool(call.name)) return false;
    return successfulReadSignatures.has(getToolCallSignature(call));
  });
}

export function shouldShiftFromExplorationToImplementation(
  calls: RuntimeToolCall[],
  executedActions: ExecutedActionLike[],
): boolean {
  if (calls.length === 0 || executedActions.length === 0) return false;
  if (!calls.every((call) => isReadLikeTool(call.name))) return false;

  let hasCacheSignal = false;
  let hasQueryOrServiceSignal = false;

  for (const action of executedActions) {
    if (!action.success) continue;

    const path = typeof (action.input as { path?: unknown })?.path === 'string'
      ? String((action.input as { path?: unknown }).path).toLowerCase()
      : '';
    const output = stringifyToolOutput(action.output).slice(0, 4000).toLowerCase();
    const signalText = `${path}\n${output}`;

    if (
      signalText.includes('cachemanager')
      || signalText.includes('/cache/')
      || signalText.includes('.cache.')
      || signalText.includes(' cache ')
      || signalText.includes('cache')
    ) {
      hasCacheSignal = true;
    }

    if (
      signalText.includes('queryservice')
      || signalText.includes('query service')
      || signalText.includes('/service/')
      || signalText.includes('.service.')
      || signalText.includes('one.api.service')
      || signalText.includes('application.service')
    ) {
      hasQueryOrServiceSignal = true;
    }

    if (hasCacheSignal && hasQueryOrServiceSignal) {
      return true;
    }
  }

  return false;
}

export function sessionMemorySuggestsImplementation(summary?: string | SessionCompactMemory): boolean {
  if (!summary) return false;

  if (typeof summary !== 'string') {
    if (summary.implementationReady || summary.implementationStrict) return true;
    const keyFiles = (summary.keyFiles || []).join(' ').toLowerCase();
    const hasCacheSignal = keyFiles.includes('cache');
    const hasQueryOrServiceSignal = keyFiles.includes('query') || keyFiles.includes('service');
    return hasCacheSignal && hasQueryOrServiceSignal;
  }

  const lowered = summary.toLowerCase();
  if (lowered.includes('implementation ready: yes')) return true;
  if (lowered.includes('implementation strict: yes')) return true;

  const keyFilesLine = summary
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('key files:'));
  if (!keyFilesLine) return false;

  const keyFiles = keyFilesLine.toLowerCase();
  const hasCacheSignal = keyFiles.includes('cache');
  const hasQueryOrServiceSignal = keyFiles.includes('query') || keyFiles.includes('service');
  return hasCacheSignal && hasQueryOrServiceSignal;
}

export function assistantSuggestsImplementationComplete(content: string): boolean {
  const lowered = content.toLowerCase();
  return (
    lowered.includes('already implemented')
    || lowered.includes('already exists')
    || lowered.includes('has been implemented')
    || lowered.includes('check if there are any omissions')
    || lowered.includes('check whether anything is missing')
    || lowered.includes('缓存功能已经实现')
    || lowered.includes('已经实现')
    || (lowered.includes('查看了代码') && lowered.includes('遗漏'))
    || (lowered.includes('implemented') && lowered.includes('missing'))
    || lowered.includes('检查一下是否有遗漏')
    || lowered.includes('是否有遗漏')
  );
}

export function assistantSuggestsNoCodeChangeNeeded(content: string): boolean {
  const lowered = content.toLowerCase();
  return (
    lowered.includes('no code changes are needed')
    || lowered.includes('no code change is needed')
    || lowered.includes('no changes are required')
    || lowered.includes('no code changes required')
    || lowered.includes('does not need code changes')
    || lowered.includes('无需改代码')
    || lowered.includes('不需要改代码')
    || lowered.includes('无需修改代码')
    || lowered.includes('不需要修改代码')
    || lowered.includes('无需代码改动')
    || lowered.includes('不需要代码改动')
    || lowered.includes('already implemented')
    || lowered.includes('already exists')
    || lowered.includes('缓存功能已经实现')
    || lowered.includes('已经实现，无需修改')
  );
}

export function classifyTaskIntent(taskDescription: string): TaskIntent {
  const lowered = taskDescription.toLowerCase();

  if (
    lowered.includes('实现')
    || lowered.includes('修改')
    || lowered.includes('新增')
    || lowered.includes('加缓存')
    || lowered.includes('做缓存')
    || lowered.includes('修复')
    || lowered.includes('优化')
    || lowered.includes('refactor')
    || lowered.includes('implement')
    || lowered.includes('fix ')
    || lowered.includes('add ')
    || lowered.includes('build ')
    || lowered.includes('create ')
    || lowered.includes('make ')
    || lowered.includes('cache')
    || isCreationStyleImplementation(lowered)
  ) {
    return 'implementation';
  }

  if (
    lowered.includes('review')
    || lowered.includes('审查')
    || lowered.includes('review当前')
    || lowered.includes('代码审查')
  ) {
    return 'review';
  }

  if (
    lowered.includes('看看')
    || lowered.includes('分析')
    || lowered.includes('排查')
    || lowered.includes('定位')
    || lowered.includes('解释')
    || lowered.includes('检查')
    || lowered.includes('inspect')
    || lowered.includes('analyze')
    || lowered.includes('explain')
    || lowered.includes('investigate')
    || lowered.includes('look into')
  ) {
    return 'analysis';
  }

  return 'unknown';
}

export function isVerificationProbeBatch(calls: RuntimeToolCall[]): boolean {
  if (calls.length === 0) return false;

  return calls.every((call) => {
    if (isReadLikeTool(call.name)) return true;
    if (call.name !== 'bash') return false;

    const command = String(call.arguments.command || '').toLowerCase();
    return (
      /\brg\b/.test(command)
      || /\bgrep\b/.test(command)
      || /\bfind\b/.test(command)
      || /\bls\b/.test(command)
      || /\bcat\b/.test(command)
      || /\bwc\s+-l\b/.test(command)
      || /\bhead\b/.test(command)
      || /\btail\b/.test(command)
    );
  });
}

export function enoughEvidenceToConclude(
  summary: string | SessionCompactMemory | undefined,
  assistantContent: string,
  calls: RuntimeToolCall[],
): boolean {
  return (
    sessionMemorySuggestsImplementation(summary)
    && assistantSuggestsImplementationComplete(assistantContent)
    && isVerificationProbeBatch(calls)
  );
}

export function shouldForceImplementationAction(
  taskDescription: string,
  summary: string | SessionCompactMemory | undefined,
  calls: RuntimeToolCall[],
): boolean {
  if (classifyTaskIntent(taskDescription) !== 'implementation') return false;
  if (!summary) return false;
  if (!hasMeaningfulPendingWork(summary)) return false;
  if (!isVerificationProbeBatch(calls)) return false;

  if (typeof summary !== 'string') {
    return summary.currentFocus === 'implementation'
      || !!summary.implementationReady
      || !!summary.implementationStrict;
  }

  const lowered = summary.toLowerCase();
  return lowered.includes('current focus: implementation')
    || lowered.includes('implementation strict: yes')
    || lowered.includes('implementation ready: yes');
}

export function hasMeaningfulPendingWork(summary?: string | SessionCompactMemory): boolean {
  if (!summary) return false;

  const pendingItems = typeof summary === 'string'
    ? extractPendingItemsFromSummary(summary)
    : (summary.pendingWork || []);

  return pendingItems.some((item) => {
    const lowered = item.toLowerCase();
    return (
      lowered.includes('implement')
      || lowered.includes('verify')
      || lowered.includes('read ')
      || lowered.includes('modify')
      || lowered.includes('change')
      || lowered.includes('resume')
      || lowered.includes('continue')
      || lowered.includes('补')
      || lowered.includes('实现')
      || lowered.includes('修改')
      || lowered.includes('验证')
      || lowered.includes('阅读')
      || lowered.includes('继续')
    );
  });
}

export function hasWriteLikeAction(actions: ExecutedActionLike[]): boolean {
  return actions.some((action) =>
    action.success && (action.tool === 'write_file' || action.tool === 'edit_file'),
  );
}

export function shouldMarkTaskCompleted(
  taskDescription: string,
  summary: string | SessionCompactMemory | undefined,
  assistantContent: string,
  actions: ExecutedActionLike[],
): boolean {
  const intent = classifyTaskIntent(taskDescription);
  const explicitNoChange = assistantSuggestsNoCodeChangeNeeded(assistantContent);
  const wroteCode = hasWriteLikeAction(actions);
  const hasPending = hasMeaningfulPendingWork(summary);

  if (intent === 'implementation') {
    if (wroteCode) return true;
    if (explicitNoChange && !hasPending) return true;
    return false;
  }

  if (intent === 'analysis' || intent === 'review') {
    return !hasPending || explicitNoChange || wroteCode;
  }

  return wroteCode || explicitNoChange || !hasPending;
}

function extractPendingItemsFromSummary(summary: string): string[] {
  const line = summary
    .split('\n')
    .find((entry) => entry.toLowerCase().includes('pending work:'));
  if (!line) return [];
  const normalized = line.replace(/^-+\s*/, '');
  const [, pending = ''] = normalized.split(/pending work:\s*/i);
  return pending.split(' | ').map((item) => item.trim()).filter(Boolean);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${entries.join(',')}}`;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function normalizeFindCommand(command: string): string | null {
  if (!command.startsWith('find ')) return null;
  if (command.includes('|') || command.includes('>') || command.includes('<')) return null;

  const parts = command.match(/(?:[^\s"]+|"[^"]*"|'[^']*')+/g);
  if (!parts || parts.length < 4) return null;
  if (parts[0] !== 'find') return null;

  const searchRoot = parts[1]?.replace(/^["']|["']$/g, '');
  const nameIndex = parts.findIndex((part) => part === '-name');
  if (!searchRoot || nameIndex === -1 || !parts[nameIndex + 1]) return null;

  const namePattern = parts[nameIndex + 1].replace(/^["']|["']$/g, '');
  if (!namePattern) return null;

  return `${searchRoot.replace(/\/+$/, '')}/**/${namePattern}`;
}

function isCreationStyleImplementation(lowered: string): boolean {
  return CREATION_STYLE_VERBS.some((verb) => lowered.includes(verb))
    && CREATION_STYLE_ARTIFACT_HINTS.some((hint) => lowered.includes(hint));
}
