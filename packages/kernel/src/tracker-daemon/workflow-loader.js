import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Liquid } from 'liquidjs';
import { parse as parseYaml } from 'yaml';
const DEFAULT_CONFIG = {
    tracker: {
        kind: 'json',
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done', 'Closed', 'Canceled', 'Cancelled'],
    },
    polling: {
        intervalMs: 30_000,
        maxConcurrentAgents: 3,
    },
    workspace: {
        root: '.symphony/workspaces',
        cleanupTerminal: false,
        hooks: {
            afterCreate: [],
            beforeRun: [],
            afterRun: [],
            beforeRemove: [],
        },
    },
    agent: {
        timeoutMs: 90_000,
    },
};
export async function loadTrackerWorkflow(rootPath, fileName = 'WORKFLOW.md') {
    const workflowPath = path.isAbsolute(fileName) ? fileName : path.join(rootPath, fileName);
    const raw = await fs.readFile(workflowPath, 'utf-8');
    const { frontMatter, body } = splitFrontMatter(raw);
    const parsed = parseWorkflowYaml(frontMatter);
    if (parsed.version !== 2) {
        throw new Error('Workflow files must declare version: 2.');
    }
    const config = normalizeConfig(parsed);
    await validateWorkflowV2(rootPath, config);
    const promptTemplate = body.trim();
    const engine = new Liquid({ strictVariables: true, strictFilters: true });
    const parsedTemplate = engine.parse(promptTemplate);
    return {
        version: 2,
        path: workflowPath,
        workflowConfigHash: sha256(canonicalize(parsed)),
        workflowPromptHash: sha256(promptTemplate),
        config,
        promptTemplate,
        renderPrompt(task, input) {
            return renderPrompt(engine, parsedTemplate, task, input);
        },
        resolveRouting(task) {
            return resolveWorkflowRouting(config, task);
        },
    };
}
export async function resolveTrackerWorkflowPath(workspaceRoot, explicitPath) {
    const candidates = explicitPath
        ? [path.isAbsolute(explicitPath) ? explicitPath : path.join(workspaceRoot, explicitPath)]
        : [
            path.join(workspaceRoot, '.tik', 'WORKFLOW.md'),
            path.join(workspaceRoot, 'WORKFLOW.md'),
        ];
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    return candidates[0];
}
function splitFrontMatter(raw) {
    if (!raw.startsWith('---\n')) {
        return { frontMatter: '', body: raw };
    }
    const end = raw.indexOf('\n---', 4);
    if (end === -1) {
        return { frontMatter: '', body: raw };
    }
    return {
        frontMatter: raw.slice(4, end),
        body: raw.slice(end + 4).replace(/^\r?\n/, ''),
    };
}
function normalizeConfig(parsed) {
    const topLevelHooks = parsed.hooks || {};
    const workspaceHooks = parsed.workspace?.hooks || {};
    const apiKeyEnv = parsed.tracker?.api_key_env || parsed.tracker?.apiKeyEnv;
    return {
        tracker: {
            kind: parsed.tracker?.kind || DEFAULT_CONFIG.tracker.kind,
            taskFile: parsed.tracker?.task_file || parsed.tracker?.taskFile || parsed.tracker?.issue_file || parsed.tracker?.issueFile,
            endpoint: parsed.tracker?.endpoint,
            ...(apiKeyEnv ? { apiKeyEnv: stripEnvPrefix(String(apiKeyEnv)) } : resolveApiKey(parsed.tracker?.api_key || parsed.tracker?.apiKey)),
            projectSlug: parsed.tracker?.project_slug || parsed.tracker?.projectSlug,
            activeStates: toStringArray(parsed.tracker?.active_states || parsed.tracker?.activeStates, DEFAULT_CONFIG.tracker.activeStates),
            terminalStates: toStringArray(parsed.tracker?.terminal_states || parsed.tracker?.terminalStates, DEFAULT_CONFIG.tracker.terminalStates),
        },
        polling: {
            intervalMs: toNumber(parsed.polling?.interval_ms || parsed.polling?.intervalMs, DEFAULT_CONFIG.polling.intervalMs),
            maxConcurrentAgents: toNumber(parsed.polling?.max_concurrent_agents
                || parsed.polling?.maxConcurrentAgents
                || parsed.agent?.max_concurrent_agents
                || parsed.agent?.maxConcurrentAgents, DEFAULT_CONFIG.polling.maxConcurrentAgents),
        },
        workspace: {
            root: parsed.workspace?.root || DEFAULT_CONFIG.workspace.root,
            cleanupTerminal: toBoolean(parsed.workspace?.cleanup_terminal ?? parsed.workspace?.cleanupTerminal, DEFAULT_CONFIG.workspace.cleanupTerminal),
            hooks: {
                afterCreate: toStringArray(workspaceHooks.after_create || workspaceHooks.afterCreate || topLevelHooks.after_create || topLevelHooks.afterCreate, []),
                beforeRun: toStringArray(workspaceHooks.before_run || workspaceHooks.beforeRun || topLevelHooks.before_run || topLevelHooks.beforeRun, []),
                afterRun: toStringArray(workspaceHooks.after_run || workspaceHooks.afterRun || topLevelHooks.after_run || topLevelHooks.afterRun, []),
                beforeRemove: toStringArray(workspaceHooks.before_remove || workspaceHooks.beforeRemove || topLevelHooks.before_remove || topLevelHooks.beforeRemove, []),
            },
        },
        agent: {
            timeoutMs: toNumber(parsed.agent?.timeout_ms || parsed.agent?.timeoutMs, DEFAULT_CONFIG.agent.timeoutMs),
        },
        selector: {
            includeLabels: toStringArray(parsed.selector?.include_labels || parsed.selector?.includeLabels, []),
            excludeLabels: toStringArray(parsed.selector?.exclude_labels || parsed.selector?.excludeLabels, []),
        },
        routing: {
            defaultRunner: normalizeRunner(parsed.routing?.default_runner || parsed.routing?.defaultRunner),
            defaultMode: normalizeMode(parsed.routing?.default_mode || parsed.routing?.defaultMode),
            rules: normalizeRoutingRules(parsed.routing?.rules),
        },
        concurrency: {
            lock: normalizeLock(parsed.concurrency?.lock),
            respectLabels: toStringArray(parsed.concurrency?.respect_labels || parsed.concurrency?.respectLabels, []),
        },
        sandbox: {
            envWhitelist: toStringArray(parsed.sandbox?.env_whitelist || parsed.sandbox?.envWhitelist, []),
        },
        validation: {
            commands: toStringArray(parsed.validation?.commands || parsed.validation_commands || parsed.validationCommands, []),
        },
        hooks: {
            root: parsed.hooks?.root || '.tik/hooks',
            timeoutMs: toNumber(parsed.hooks?.timeout_ms || parsed.hooks?.timeoutMs, 30_000),
            allowExecutableOnly: toBoolean(parsed.hooks?.allow_executable_only ?? parsed.hooks?.allowExecutableOnly, true),
        },
    };
}
function renderPrompt(engine, parsedTemplate, task, input) {
    const view = {
        task: {
            id: task.id,
            shortIdentifier: task.shortIdentifier,
            title: task.title,
            description: task.description || '',
            state: task.state,
            sourceUrl: task.sourceUrl || '',
            labels: task.labels,
        },
        issue: {
            id: task.id,
            identifier: task.shortIdentifier,
            title: task.title,
            description: task.description || '',
            state: task.state,
            url: task.sourceUrl || '',
            labels: task.labels,
        },
        attempt: input?.attempt || 0,
        previousReview: input?.previousReview || '',
    };
    try {
        return engine.renderSync(parsedTemplate, view);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const variable = message.match(/undefined variable:\s*([^,]+)/i)?.[1]?.trim();
        throw new Error(variable ? `Unknown workflow template variable: ${variable}` : message);
    }
}
function parseWorkflowYaml(source) {
    if (!source.trim())
        return {};
    const parsed = parseYaml(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
    }
    return parsed;
}
function resolveWorkflowRouting(config, task) {
    const routing = config.routing;
    if (!routing) {
        throw new Error('Workflow v2 routing is not configured.');
    }
    const labels = new Set(task.labels.map(normalizeLabel));
    const phaseRouting = resolveWorkflowPhaseRouting(routing, task);
    if (phaseRouting) {
        return phaseRouting;
    }
    const explicitRunnerLabels = [
        labels.has('runner:codex') ? 'runner:codex' : undefined,
        labels.has('runner:claude') || labels.has('runner:claude-code') ? 'runner:claude' : undefined,
    ].filter((label) => Boolean(label));
    if (explicitRunnerLabels.length > 1) {
        throw new Error(`Conflicting explicit runner labels for ${task.shortIdentifier}: ${explicitRunnerLabels.join(', ')}`);
    }
    if (explicitRunnerLabels.length === 1) {
        const runner = explicitRunnerLabels[0] === 'runner:codex' ? 'codex' : 'claude-code';
        return {
            runner,
            mode: defaultModeForRunner(runner, routing.defaultMode),
            matchedSource: 'explicit-label',
            matchedLabels: explicitRunnerLabels,
        };
    }
    const implementationRule = resolveImplementationRuleRouting(routing, labels);
    if (implementationRule) {
        return implementationRule;
    }
    for (let index = 0; index < routing.rules.length; index += 1) {
        const rule = routing.rules[index];
        const matchedLabels = rule.labelsAny.filter((label) => labels.has(normalizeLabel(label)));
        if (matchedLabels.length === 0)
            continue;
        return {
            runner: rule.runner,
            mode: rule.mode,
            matchedSource: `rule[${index}]`,
            matchedLabels,
        };
    }
    if (routing.defaultRunner) {
        return {
            runner: routing.defaultRunner,
            mode: defaultModeForRunner(routing.defaultRunner, routing.defaultMode),
            matchedSource: 'default',
        };
    }
    throw new Error(`No workflow routing rule matched ${task.shortIdentifier}, and routing.default_runner is not configured.`);
}
function resolveWorkflowPhaseRouting(routing, task) {
    const phase = task.agentLoop?.phase;
    const kind = task.agentLoop?.kind;
    if (!phase && !kind) {
        return undefined;
    }
    if (phase === 'needs_claude_review' || phase === 'claude_reviewing' || kind === 'claude_review') {
        return {
            runner: 'claude-code',
            mode: configuredModeForRunner(routing, 'claude-code'),
            matchedSource: 'phase',
            matchedLabels: phase ? [phase] : kind ? [kind] : undefined,
        };
    }
    if (phase === 'needs_codex_fix' || phase === 'codex_fixing' || kind === 'codex_fix' || kind === 'codex_implement') {
        return {
            runner: 'codex',
            mode: configuredModeForRunner(routing, 'codex'),
            matchedSource: 'phase',
            matchedLabels: phase ? [phase] : kind ? [kind] : undefined,
        };
    }
    return undefined;
}
function configuredModeForRunner(routing, runner) {
    const matchingRule = routing.rules.find((rule) => rule.runner === runner);
    return matchingRule?.mode || defaultModeForRunner(runner, routing.defaultMode);
}
function resolveImplementationRuleRouting(routing, labels) {
    for (let index = 0; index < routing.rules.length; index += 1) {
        const rule = routing.rules[index];
        if (rule.runner !== 'codex')
            continue;
        const matchedLabels = rule.labelsAny.filter((label) => labels.has(normalizeLabel(label)));
        if (matchedLabels.length === 0)
            continue;
        return {
            runner: rule.runner,
            mode: rule.mode,
            matchedSource: `rule[${index}]`,
            matchedLabels,
        };
    }
    return undefined;
}
async function validateWorkflowV2(rootPath, config) {
    if (!config.routing) {
        throw new Error('Workflow v2 requires routing configuration.');
    }
    const hookRoot = config.hooks?.root || '.tik/hooks';
    const configuredHooks = Object.values(config.workspace.hooks).flat();
    for (const hook of configuredHooks) {
        await validateWorkflowHook(rootPath, hookRoot, hook, config.hooks?.allowExecutableOnly !== false);
    }
}
async function validateWorkflowHook(rootPath, hookRoot, hook, executableOnly) {
    const normalizedHook = hook.trim();
    if (!normalizedHook)
        return;
    const hookRootNormalized = normalizePathLike(hookRoot);
    const hookNormalized = normalizePathLike(normalizedHook);
    if (path.isAbsolute(normalizedHook) || hookNormalized.includes('..') || !hookNormalized.startsWith(`${hookRootNormalized}/`)) {
        throw new Error(`Workflow v2 hook must be under ${hookRoot}: ${hook}`);
    }
    const hookPath = path.join(rootPath, normalizedHook);
    const stat = await fs.stat(hookPath).catch((error) => {
        if (error.code === 'ENOENT') {
            throw new Error(`Workflow v2 hook does not exist: ${hook}`);
        }
        throw error;
    });
    if (!stat.isFile()) {
        throw new Error(`Workflow v2 hook must be a file: ${hook}`);
    }
    if (executableOnly && (stat.mode & 0o111) === 0) {
        throw new Error(`Workflow v2 hook must be executable: ${hook}`);
    }
}
function normalizeRoutingRules(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((item) => {
        const candidate = item;
        const runner = normalizeRunner(candidate.runner);
        const mode = normalizeMode(candidate.mode);
        if (!runner)
            throw new Error('Workflow v2 routing rule requires runner.');
        return {
            labelsAny: toStringArray(candidate.labels_any || candidate.labelsAny, []),
            runner,
            mode: mode || defaultModeForRunner(runner),
        };
    });
}
function normalizeRunner(value) {
    if (value === 'codex')
        return 'codex';
    if (value === 'claude' || value === 'claude-code' || value === 'claude_code')
        return 'claude-code';
    return undefined;
}
function normalizeMode(value) {
    if (value === 'codex_exec'
        || value === 'codex_app_server'
        || value === 'claude_print'
        || value === 'claude_hooked') {
        return value;
    }
    return undefined;
}
function defaultModeForRunner(runner, preferred) {
    if (preferred && modeMatchesRunner(runner, preferred))
        return preferred;
    return runner === 'codex' ? 'codex_app_server' : 'claude_print';
}
function modeMatchesRunner(runner, mode) {
    return runner === 'codex' ? mode.startsWith('codex_') : mode.startsWith('claude_');
}
function normalizeLock(value) {
    if (value === 'repository_branch' || value === 'repo_branch')
        return 'repository_branch';
    if (value === 'none')
        return 'none';
    return undefined;
}
function normalizeLabel(label) {
    return label.trim().toLowerCase();
}
function normalizePathLike(value) {
    return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function canonicalize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
export function defaultTrackerWorkflowContent() {
    return [
        '---',
        'version: 2',
        'tracker:',
        '  kind: json',
        'polling:',
        '  interval_ms: 30000',
        '  max_concurrent_agents: 3',
        'workspace:',
        '  root: .tik/workspaces',
        '  cleanup_terminal: false',
        '  hooks:',
        '    after_create: []',
        '    before_run: []',
        '    after_run: []',
        '    before_remove: []',
        'agent:',
        '  timeout_ms: 90000',
        'routing:',
        '  default_runner: codex',
        '  default_mode: codex_app_server',
        'sandbox:',
        '  env_whitelist: []',
        'validation:',
        '  commands: []',
        '---',
        'Implement {{ task.shortIdentifier }}: {{ task.title }}.',
        '',
        '{{ task.description }}',
        '',
    ].join('\n');
}
export async function readTrackerWorkflowFile(workspaceRoot) {
    const workflowPath = await resolveTrackerWorkflowPath(workspaceRoot);
    try {
        return {
            path: workflowPath,
            exists: true,
            content: await fs.readFile(workflowPath, 'utf-8'),
        };
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return {
            path: workflowPath,
            exists: false,
            content: defaultTrackerWorkflowContent(),
        };
    }
}
export async function writeTrackerWorkflowFile(workspaceRoot, content) {
    const workflowPath = await resolveTrackerWorkflowPath(workspaceRoot);
    const normalized = content.endsWith('\n') ? content : `${content}\n`;
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.writeFile(workflowPath, normalized, 'utf-8');
    return {
        path: workflowPath,
        content: normalized,
    };
}
function resolveApiKey(value) {
    if (typeof value !== 'string' || !value)
        return {};
    if (value.startsWith('$'))
        return { apiKeyEnv: stripEnvPrefix(value) };
    return { apiKey: value };
}
function stripEnvPrefix(value) {
    return value.startsWith('$') ? value.slice(1) : value;
}
function toStringArray(value, fallback) {
    if (Array.isArray(value))
        return value.map((item) => String(item).trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim())
        return [value.trim()];
    return fallback;
}
function toNumber(value, fallback) {
    if (typeof value === 'string' && /^\d+$/.test(value))
        return Number(value);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function toBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
//# sourceMappingURL=workflow-loader.js.map