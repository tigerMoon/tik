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
export function normalizeToolCall(call) {
    if (call.name !== 'bash')
        return call;
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
export function dedupeToolCalls(calls) {
    const deduped = [];
    const seen = new Set();
    for (const call of calls) {
        const signature = getToolCallSignature(call);
        if (seen.has(signature))
            continue;
        seen.add(signature);
        deduped.push(call);
    }
    return deduped;
}
export function getToolCallSignature(call) {
    return `${call.name}:${stableStringify(call.arguments)}`;
}
export function isReadLikeTool(toolName) {
    return READ_LIKE_TOOLS.has(toolName);
}
export function isRedundantReadBatch(calls, successfulReadSignatures) {
    if (calls.length === 0)
        return false;
    return calls.every((call) => {
        if (!isReadLikeTool(call.name))
            return false;
        return successfulReadSignatures.has(getToolCallSignature(call));
    });
}
export function shouldShiftFromExplorationToImplementation(calls, executedActions) {
    if (calls.length === 0 || executedActions.length === 0)
        return false;
    if (!calls.every((call) => isReadLikeTool(call.name)))
        return false;
    let hasCacheSignal = false;
    let hasQueryOrServiceSignal = false;
    for (const action of executedActions) {
        if (!action.success)
            continue;
        const path = typeof action.input?.path === 'string'
            ? String(action.input.path).toLowerCase()
            : '';
        const output = stringifyToolOutput(action.output).slice(0, 4000).toLowerCase();
        const signalText = `${path}\n${output}`;
        if (signalText.includes('cachemanager')
            || signalText.includes('/cache/')
            || signalText.includes('.cache.')
            || signalText.includes(' cache ')
            || signalText.includes('cache')) {
            hasCacheSignal = true;
        }
        if (signalText.includes('queryservice')
            || signalText.includes('query service')
            || signalText.includes('/service/')
            || signalText.includes('.service.')
            || signalText.includes('one.api.service')
            || signalText.includes('application.service')) {
            hasQueryOrServiceSignal = true;
        }
        if (hasCacheSignal && hasQueryOrServiceSignal) {
            return true;
        }
    }
    return false;
}
export function sessionMemorySuggestsImplementation(summary) {
    if (!summary)
        return false;
    if (typeof summary !== 'string') {
        if (summary.implementationReady || summary.implementationStrict)
            return true;
        const keyFiles = (summary.keyFiles || []).join(' ').toLowerCase();
        const hasCacheSignal = keyFiles.includes('cache');
        const hasQueryOrServiceSignal = keyFiles.includes('query') || keyFiles.includes('service');
        return hasCacheSignal && hasQueryOrServiceSignal;
    }
    const lowered = summary.toLowerCase();
    if (lowered.includes('implementation ready: yes'))
        return true;
    if (lowered.includes('implementation strict: yes'))
        return true;
    const keyFilesLine = summary
        .split('\n')
        .find((line) => line.toLowerCase().startsWith('key files:'));
    if (!keyFilesLine)
        return false;
    const keyFiles = keyFilesLine.toLowerCase();
    const hasCacheSignal = keyFiles.includes('cache');
    const hasQueryOrServiceSignal = keyFiles.includes('query') || keyFiles.includes('service');
    return hasCacheSignal && hasQueryOrServiceSignal;
}
export function assistantSuggestsImplementationComplete(content) {
    const lowered = content.toLowerCase();
    return (lowered.includes('already implemented')
        || lowered.includes('already exists')
        || lowered.includes('has been implemented')
        || lowered.includes('check if there are any omissions')
        || lowered.includes('check whether anything is missing')
        || lowered.includes('缓存功能已经实现')
        || lowered.includes('已经实现')
        || (lowered.includes('查看了代码') && lowered.includes('遗漏'))
        || (lowered.includes('implemented') && lowered.includes('missing'))
        || lowered.includes('检查一下是否有遗漏')
        || lowered.includes('是否有遗漏'));
}
export function assistantSuggestsNoCodeChangeNeeded(content) {
    const lowered = content.toLowerCase();
    return (lowered.includes('no code changes are needed')
        || lowered.includes('no code change is needed')
        || lowered.includes('no further code changes are needed')
        || lowered.includes('no further code change is needed')
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
        || lowered.includes('已经实现，无需修改'));
}
export function classifyTaskIntent(taskDescription) {
    const lowered = taskDescription.toLowerCase();
    if (lowered.includes('实现')
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
        || isCreationStyleImplementation(lowered)) {
        return 'implementation';
    }
    if (lowered.includes('review')
        || lowered.includes('审查')
        || lowered.includes('review当前')
        || lowered.includes('代码审查')) {
        return 'review';
    }
    if (lowered.includes('看看')
        || lowered.includes('分析')
        || lowered.includes('排查')
        || lowered.includes('定位')
        || lowered.includes('解释')
        || lowered.includes('检查')
        || lowered.includes('inspect')
        || lowered.includes('analyze')
        || lowered.includes('explain')
        || lowered.includes('investigate')
        || lowered.includes('look into')) {
        return 'analysis';
    }
    return 'unknown';
}
export function isVerificationProbeBatch(calls) {
    if (calls.length === 0)
        return false;
    return calls.every((call) => {
        if (isReadLikeTool(call.name))
            return true;
        if (call.name !== 'bash')
            return false;
        const command = String(call.arguments.command || '').toLowerCase();
        return (/\brg\b/.test(command)
            || /\bgrep\b/.test(command)
            || /\bfind\b/.test(command)
            || /\bls\b/.test(command)
            || /\bcat\b/.test(command)
            || /\bwc\s+-l\b/.test(command)
            || /\bhead\b/.test(command)
            || /\btail\b/.test(command));
    });
}
export function enoughEvidenceToConclude(summary, assistantContent, calls) {
    return (sessionMemorySuggestsImplementation(summary)
        && assistantSuggestsImplementationComplete(assistantContent)
        && isVerificationProbeBatch(calls));
}
export function shouldForceImplementationAction(taskDescription, summary, calls) {
    if (classifyTaskIntent(taskDescription) !== 'implementation')
        return false;
    if (!summary)
        return false;
    if (!hasMeaningfulPendingWork(summary))
        return false;
    if (!isVerificationProbeBatch(calls))
        return false;
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
export function hasMeaningfulPendingWork(summary) {
    return extractPendingWork(summary).some(isMeaningfulPendingItem);
}
function hasBlockingPendingWork(summary, options) {
    return extractPendingWork(summary).some((item) => {
        if (options.validationSatisfied && isValidationPendingItem(item))
            return false;
        return isMeaningfulPendingItem(item);
    });
}
function extractPendingWork(summary) {
    if (!summary)
        return [];
    return typeof summary === 'string'
        ? extractPendingItemsFromSummary(summary)
        : (summary.pendingWork || []);
}
function isMeaningfulPendingItem(item) {
    const lowered = item.toLowerCase();
    return (lowered.includes('implement')
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
        || lowered.includes('继续'));
}
function isValidationPendingItem(item) {
    const lowered = item.toLowerCase();
    const hasValidationSignal = (lowered.includes('verify')
        || lowered.includes('validation')
        || lowered.includes('test')
        || lowered.includes('验证')
        || lowered.includes('测试'));
    const hasImplementationSignal = (/\bimplement\b/.test(lowered)
        || lowered.includes('modify')
        || lowered.includes('edit')
        || lowered.includes('read ')
        || lowered.includes('resume')
        || lowered.includes('continue')
        || lowered.includes('新增')
        || lowered.includes('修复')
        || lowered.includes('修改')
        || lowered.includes('阅读')
        || lowered.includes('继续'));
    return hasValidationSignal && !hasImplementationSignal;
}
export function hasWriteLikeAction(actions) {
    return actions.some((action) => action.success && (action.tool === 'write_file' || action.tool === 'edit_file'));
}
export function hasSuccessfulValidationAction(actions) {
    return actions.some((action) => action.success && isValidationAction(action));
}
export function hasFailedAction(actions) {
    return actions.some((action) => !action.success);
}
export function shouldMarkTaskCompleted(taskDescription, summary, assistantContent, actions, options = {}) {
    const intent = classifyTaskIntent(taskDescription);
    const explicitNoChange = assistantSuggestsNoCodeChangeNeeded(assistantContent);
    const wroteCode = hasWriteLikeAction(actions);
    const validationPassed = hasSuccessfulValidationAction(actions);
    const hasFailure = hasFailedAction(actions);
    const validationSatisfied = validationPassed || options.validationAvailable === false;
    const hasPending = hasBlockingPendingWork(summary, { validationSatisfied });
    if (intent === 'implementation') {
        if (wroteCode) {
            return validationSatisfied && !hasPending && !hasFailure;
        }
        if (explicitNoChange && !hasPending)
            return true;
        return false;
    }
    if (intent === 'analysis' || intent === 'review') {
        return !hasPending || explicitNoChange || wroteCode;
    }
    return wroteCode || explicitNoChange || !hasPending;
}
function isValidationAction(action) {
    if (action.tool === 'frontend_run_script') {
        const script = String(action.input?.script || '');
        return isValidationScriptName(script);
    }
    if (action.tool !== 'bash')
        return false;
    const command = String(action.input?.command || '');
    return isValidationCommand(command);
}
function isValidationCommand(command) {
    const normalized = command.toLowerCase();
    const packageScriptMatch = normalized.match(/\b(?:pnpm|npm|yarn|bun)(?:\s+--[^\s]+(?:\s+[^\s]+)?)*\s+(?:run\s+)?([a-z0-9:_-]+)/);
    if (packageScriptMatch && isValidationScriptName(packageScriptMatch[1] || '')) {
        return true;
    }
    return (/(?:^|&&|\|\||;)\s*(?:npx\s+)?(?:vitest|jest|mocha|playwright|cypress|eslint|tsc|pytest)\b/.test(normalized)
        || /\b(mvn|gradle|gradlew)\b.*\b(test|verify|check|build)\b/.test(normalized)
        || /\bgo\s+test\b/.test(normalized)
        || /\bcargo\s+(test|check|build)\b/.test(normalized));
}
function isValidationScriptName(script) {
    return /^(test|test:.+|lint|lint:.+|typecheck|type-check|check|check:.+|build|build:.+)$/i.test(script);
}
function extractPendingItemsFromSummary(summary) {
    const line = summary
        .split('\n')
        .find((entry) => entry.toLowerCase().includes('pending work:'));
    if (!line)
        return [];
    const normalized = line.replace(/^-+\s*/, '');
    const [, pending = ''] = normalized.split(/pending work:\s*/i);
    return pending.split(' | ').map((item) => item.trim()).filter(Boolean);
}
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
    return `{${entries.join(',')}}`;
}
function stringifyToolOutput(output) {
    if (typeof output === 'string')
        return output;
    try {
        return JSON.stringify(output);
    }
    catch {
        return String(output);
    }
}
function normalizeFindCommand(command) {
    if (!command.startsWith('find '))
        return null;
    if (command.includes('|') || command.includes('>') || command.includes('<'))
        return null;
    const parts = command.match(/(?:[^\s"]+|"[^"]*"|'[^']*')+/g);
    if (!parts || parts.length < 4)
        return null;
    if (parts[0] !== 'find')
        return null;
    const searchRoot = parts[1]?.replace(/^["']|["']$/g, '');
    const nameIndex = parts.findIndex((part) => part === '-name');
    if (!searchRoot || nameIndex === -1 || !parts[nameIndex + 1])
        return null;
    const namePattern = parts[nameIndex + 1].replace(/^["']|["']$/g, '');
    if (!namePattern)
        return null;
    return `${searchRoot.replace(/\/+$/, '')}/**/${namePattern}`;
}
function isCreationStyleImplementation(lowered) {
    return CREATION_STYLE_VERBS.some((verb) => lowered.includes(verb))
        && CREATION_STYLE_ARTIFACT_HINTS.some((hint) => lowered.includes(hint));
}
//# sourceMappingURL=tool-call-policy.js.map