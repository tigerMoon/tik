import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import { inspectFrontendProject } from './frontend-project.js';
const EXECUTION_SCRIPT_ALLOWLIST = new Set([
    'dev',
    'start',
    'build',
    'test',
    'lint',
    'typecheck',
    'check',
    'preview',
    'storybook',
]);
const URL_REGEX = /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+[^\s]*/i;
const PLAYWRIGHT_BROWSER_ALIAS = {
    chromium: 'chromium',
    firefox: 'firefox',
    webkit: 'webkit',
};
function buildPackageManagerArgs(packageManager, script) {
    switch (packageManager) {
        case 'pnpm':
            return { command: 'pnpm', args: [script], display: `pnpm ${script}` };
        case 'yarn':
            return { command: 'yarn', args: [script], display: `yarn ${script}` };
        case 'bun':
            return { command: 'bun', args: ['run', script], display: `bun run ${script}` };
        case 'npm':
        case 'unknown':
        default:
            return { command: 'npm', args: ['run', script], display: `npm run ${script}` };
    }
}
function createSuggestedCommands(packageManager, scripts) {
    const suggested = {};
    for (const script of Object.keys(scripts)) {
        suggested[script] = buildPackageManagerArgs(packageManager, script).display;
    }
    return suggested;
}
function getDefaultPreviewScript(scripts) {
    for (const candidate of ['dev', 'start', 'preview', 'storybook']) {
        if (scripts[candidate])
            return candidate;
    }
    return undefined;
}
export function getFrontendCommandCatalog(projectPath) {
    const report = inspectFrontendProject(projectPath);
    return {
        packageManager: report.packageManager,
        availableScripts: Object.keys(report.scripts),
        scripts: report.scripts,
        defaultPreviewScript: getDefaultPreviewScript(report.scripts),
        suggestedCommands: createSuggestedCommands(report.packageManager, report.scripts),
    };
}
function decodeHtmlEntities(input) {
    return input
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
function stripTags(input) {
    return decodeHtmlEntities(input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}
function parseAttributes(attrText) {
    const attrs = {};
    const regex = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = regex.exec(attrText)) !== null) {
        const [, name, doubleQuoted, singleQuoted, bare] = match;
        attrs[name] = doubleQuoted ?? singleQuoted ?? bare ?? '';
    }
    return attrs;
}
function extractTagContents(html, tag) {
    const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const text = stripTags(match[1] || '');
        if (text)
            results.push(text);
    }
    return results;
}
function extractOpeningTags(html, tag) {
    const regex = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        results.push(parseAttributes(match[1] || ''));
    }
    return results;
}
function extractLinkedAssets(html, tag) {
    const regex = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    const key = tag === 'script' ? 'src' : 'href';
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const attrs = parseAttributes(match[1] || '');
        if (tag === 'link' && attrs.rel !== 'stylesheet')
            continue;
        if (attrs[key])
            results.push(attrs[key]);
    }
    return results;
}
function parseElements(html) {
    const regex = /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;
    const elements = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const [raw, tagName, attrText] = match;
        if (raw.startsWith('</') || raw.startsWith('<!'))
            continue;
        const tag = tagName.toLowerCase();
        const attrs = parseAttributes(attrText || '');
        const start = regex.lastIndex;
        const closingIndex = html.toLowerCase().indexOf(`</${tag}>`, start);
        const text = closingIndex >= 0 ? stripTags(html.slice(start, closingIndex)) : '';
        elements.push({ tag, attrs, text });
    }
    return elements;
}
function matchesSimpleSelector(element, selector) {
    const query = selector.trim();
    if (!query)
        return false;
    if (query.startsWith('text=')) {
        return element.text.toLowerCase().includes(query.slice(5).toLowerCase());
    }
    const attrMatch = query.match(/\[([^\]=]+)(?:=(["']?)([^\]"']+)\2)?\]/);
    const attrName = attrMatch?.[1];
    const attrValue = attrMatch?.[3];
    const selectorWithoutAttr = attrMatch ? query.replace(attrMatch[0], '') : query;
    const idMatch = selectorWithoutAttr.match(/#([A-Za-z0-9_-]+)/);
    const classMatches = Array.from(selectorWithoutAttr.matchAll(/\.([A-Za-z0-9_-]+)/g)).map((item) => item[1]);
    const tagMatch = selectorWithoutAttr.match(/^[A-Za-z][A-Za-z0-9_-]*/);
    if (tagMatch && element.tag !== tagMatch[0].toLowerCase())
        return false;
    if (idMatch && element.attrs.id !== idMatch[1])
        return false;
    if (classMatches.length > 0) {
        const classSet = new Set((element.attrs.class || '').split(/\s+/).filter(Boolean));
        if (!classMatches.every((className) => classSet.has(className)))
            return false;
    }
    if (attrName) {
        if (!(attrName in element.attrs))
            return false;
        if (typeof attrValue === 'string' && element.attrs[attrName] !== attrValue)
            return false;
    }
    return true;
}
async function terminateProcess(child) {
    if (child.killed || child.exitCode !== null)
        return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
        if (child.exitCode === null)
            child.kill('SIGKILL');
    }, 1_000);
    try {
        await once(child, 'exit');
    }
    catch {
        // ignore
    }
    finally {
        clearTimeout(killTimer);
    }
}
function sanitizeArtifactStem(input) {
    const normalized = input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || 'frontend';
}
function resolveArtifactPath(context, outputPath) {
    if (outputPath?.trim()) {
        return path.resolve(context.cwd, outputPath.trim());
    }
    const stem = sanitizeArtifactStem(context.taskId || 'task');
    return path.join(context.cwd, '.tik-artifacts', `${stem}-browser.png`);
}
function buildPlaywrightScreenshotCommand(input) {
    const args = ['screenshot', input.url, input.outputPath, '--timeout', String(input.timeoutMs), '-b', PLAYWRIGHT_BROWSER_ALIAS[input.browser]];
    if (input.fullPage)
        args.push('--full-page');
    if (input.waitForSelector?.trim())
        args.push('--wait-for-selector', input.waitForSelector.trim());
    if (typeof input.waitForTimeoutMs === 'number' && Number.isFinite(input.waitForTimeoutMs) && input.waitForTimeoutMs > 0) {
        args.push('--wait-for-timeout', String(Math.trunc(input.waitForTimeoutMs)));
    }
    if (input.viewportSize?.trim())
        args.push('--viewport-size', input.viewportSize.trim());
    return {
        command: 'playwright',
        args,
        display: ['playwright', ...args].join(' '),
    };
}
function describePlaywrightFailure(stderr, exitCode) {
    if (/playwright install/i.test(stderr) || /Executable doesn'?t exist/i.test(stderr)) {
        return 'Playwright browser binary is not installed. Run `playwright install chromium` on the host before using frontend_browser_screenshot.';
    }
    return `Playwright screenshot exited with code ${exitCode}`;
}
async function runPlaywrightScreenshot(input, context) {
    const command = buildPlaywrightScreenshotCommand(input);
    const child = spawn(command.command, command.args, {
        cwd: context.cwd,
        env: {
            ...process.env,
            ...context.env,
            CI: '1',
            FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: context.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => {
        if (child.exitCode === null)
            child.kill('SIGTERM');
    }, Math.max(input.timeoutMs + (input.waitForTimeoutMs ?? 0) + 1_000, 5_000));
    try {
        const [exitCode] = await once(child, 'exit');
        return {
            command: command.display,
            stdout,
            stderr,
            exitCode,
        };
    }
    finally {
        clearTimeout(timeout);
        await terminateProcess(child);
    }
}
async function fetchHtml(url) {
    const response = await fetch(url);
    const html = await response.text();
    return {
        httpStatus: response.status,
        html,
    };
}
async function launchPreview(script, timeoutMs, context) {
    const catalog = getFrontendCommandCatalog(context.cwd);
    if (!catalog.scripts[script]) {
        throw new Error(`Script "${script}" not found in package.json`);
    }
    if (!EXECUTION_SCRIPT_ALLOWLIST.has(script)) {
        throw new Error(`Script "${script}" is not allowed by frontend preview tooling`);
    }
    const command = buildPackageManagerArgs(catalog.packageManager, script);
    const child = spawn(command.command, command.args, {
        cwd: context.cwd,
        env: {
            ...process.env,
            ...context.env,
            CI: '1',
            FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: context.signal,
    });
    const stdoutRef = { value: '' };
    const stderrRef = { value: '' };
    let discoveredUrl = null;
    const maybeCaptureUrl = (chunk) => {
        if (discoveredUrl)
            return;
        const match = chunk.match(URL_REGEX);
        if (match)
            discoveredUrl = match[0];
    };
    child.stdout?.on('data', (chunk) => {
        const text = String(chunk);
        stdoutRef.value += text;
        maybeCaptureUrl(text);
    });
    child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        stderrRef.value += text;
        maybeCaptureUrl(text);
    });
    const url = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            clearInterval(check);
            reject(new Error(`Timed out waiting for preview URL from script "${script}"`));
        }, timeoutMs);
        const check = setInterval(() => {
            if (discoveredUrl) {
                clearInterval(check);
                clearTimeout(timeout);
                resolve(discoveredUrl);
                return;
            }
            if (child.exitCode !== null) {
                clearInterval(check);
                clearTimeout(timeout);
                reject(new Error(`Script "${script}" exited before exposing a preview URL`));
            }
        }, 50);
    });
    return {
        child,
        command: command.display,
        stdoutRef,
        stderrRef,
        url,
    };
}
async function resolvePageSource(input, context) {
    const timeoutMs = input.timeoutMs ?? 30_000;
    const explicitUrl = input.url?.trim();
    if (explicitUrl) {
        const fetched = await fetchHtml(explicitUrl);
        return {
            url: explicitUrl,
            httpStatus: fetched.httpStatus,
            html: fetched.html,
            stdout: '',
            stderr: '',
        };
    }
    const catalog = getFrontendCommandCatalog(context.cwd);
    const selectedScript = input.script || catalog.defaultPreviewScript;
    if (!selectedScript) {
        throw new Error('No preview-like script found in package.json');
    }
    const launched = await launchPreview(selectedScript, timeoutMs, context);
    try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const fetched = await fetchHtml(launched.url);
        return {
            script: selectedScript,
            command: launched.command,
            url: launched.url,
            httpStatus: fetched.httpStatus,
            html: fetched.html,
            stdout: launched.stdoutRef.value,
            stderr: launched.stderrRef.value,
        };
    }
    finally {
        await terminateProcess(launched.child);
    }
}
function buildSelectorHint(element) {
    if (element.attrs.id)
        return `#${element.attrs.id}`;
    if (element.attrs.class)
        return `.${element.attrs.class.split(/\s+/).filter(Boolean).join('.')}`;
    return element.tag;
}
export const frontendProjectInfoTool = {
    name: 'frontend_project_info',
    type: 'read',
    description: 'Inspect the frontend stack, scripts, entrypoints, and component/style roots for UI tasks',
    inputSchema: z.object({}),
    async execute(_input, context) {
        const start = Date.now();
        try {
            const report = inspectFrontendProject(context.cwd);
            return {
                success: true,
                output: report,
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
    },
};
export const frontendCommandCatalogTool = {
    name: 'frontend_command_catalog',
    type: 'read',
    description: 'List available frontend scripts and recommended commands for dev/build/test/lint flows',
    inputSchema: z.object({}),
    async execute(_input, context) {
        const start = Date.now();
        try {
            return {
                success: true,
                output: getFrontendCommandCatalog(context.cwd),
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
    },
};
export const frontendRunScriptTool = {
    name: 'frontend_run_script',
    type: 'exec',
    description: 'Run a safe frontend package script such as build, test, lint, or typecheck',
    inputSchema: z.object({
        script: z.string().describe('Frontend package script name to run'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { script, timeoutMs = 60_000 } = input;
        const catalog = getFrontendCommandCatalog(context.cwd);
        if (!catalog.scripts[script]) {
            return {
                success: false,
                output: null,
                error: `Script "${script}" not found in package.json`,
                durationMs: Date.now() - start,
            };
        }
        if (!EXECUTION_SCRIPT_ALLOWLIST.has(script)) {
            return {
                success: false,
                output: null,
                error: `Script "${script}" is not allowed by frontend_run_script`,
                durationMs: Date.now() - start,
            };
        }
        const command = buildPackageManagerArgs(catalog.packageManager, script);
        const child = spawn(command.command, command.args, {
            cwd: context.cwd,
            env: {
                ...process.env,
                ...context.env,
                CI: '1',
                FORCE_COLOR: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: context.signal,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        const timeout = setTimeout(() => {
            if (child.exitCode === null)
                child.kill('SIGTERM');
        }, timeoutMs);
        try {
            const [exitCode] = await once(child, 'exit');
            const success = exitCode === 0;
            return {
                success,
                output: {
                    script,
                    command: command.display,
                    stdout,
                    stderr,
                    exitCode,
                },
                error: success ? undefined : `Script "${script}" exited with code ${exitCode}`,
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: {
                    script,
                    command: command.display,
                    stdout,
                    stderr,
                },
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
        finally {
            clearTimeout(timeout);
            await terminateProcess(child);
        }
    },
};
export const frontendPreviewProbeTool = {
    name: 'frontend_preview_probe',
    type: 'exec',
    description: 'Start a short-lived frontend preview/dev command, detect the local URL, probe it, then stop the process',
    inputSchema: z.object({
        url: z.string().optional().describe('Existing page URL to probe directly'),
        script: z.string().optional().describe('Preview-like script name to run; defaults to dev/start/preview/storybook'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
    }),
    async execute(input, context) {
        const start = Date.now();
        try {
            const page = await resolvePageSource(input, context);
            return {
                success: true,
                output: {
                    script: page.script,
                    command: page.command,
                    url: page.url,
                    httpStatus: page.httpStatus,
                    bodySnippet: page.html.slice(0, 500),
                    stdout: page.stdout,
                    stderr: page.stderr,
                },
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
    },
};
export const frontendHtmlSnapshotTool = {
    name: 'frontend_html_snapshot',
    type: 'exec',
    description: 'Fetch a local preview page and summarize its HTML structure, headings, and linked assets',
    inputSchema: z.object({
        url: z.string().optional().describe('Existing page URL to snapshot directly'),
        script: z.string().optional().describe('Preview-like script name to run before fetching the page'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
    }),
    async execute(input, context) {
        const start = Date.now();
        try {
            const page = await resolvePageSource(input, context);
            const h1 = extractTagContents(page.html, 'h1');
            const h2 = extractTagContents(page.html, 'h2');
            const h3 = extractTagContents(page.html, 'h3');
            const title = extractTagContents(page.html, 'title')[0] || '';
            const lang = extractOpeningTags(page.html, 'html')[0]?.lang || '';
            const stylesheets = extractLinkedAssets(page.html, 'link');
            const scripts = extractLinkedAssets(page.html, 'script');
            const forms = extractOpeningTags(page.html, 'form');
            const buttons = extractOpeningTags(page.html, 'button');
            const images = extractOpeningTags(page.html, 'img');
            const anchors = extractOpeningTags(page.html, 'a');
            const dataTestIds = parseElements(page.html)
                .map((element) => element.attrs['data-testid'])
                .filter((value) => typeof value === 'string' && value.length > 0)
                .slice(0, 20);
            return {
                success: true,
                output: {
                    script: page.script,
                    command: page.command,
                    url: page.url,
                    httpStatus: page.httpStatus,
                    title,
                    lang,
                    h1,
                    h2,
                    h3,
                    stylesheets,
                    scripts,
                    dataTestIds,
                    landmarkCounts: {
                        forms: forms.length,
                        buttons: buttons.length,
                        images: images.length,
                        links: anchors.length,
                    },
                    bodySnippet: stripTags(page.html).slice(0, 500),
                    stdout: page.stdout,
                    stderr: page.stderr,
                },
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
    },
};
export const frontendDomQueryTool = {
    name: 'frontend_dom_query',
    type: 'exec',
    description: 'Run a lightweight selector query against fetched frontend HTML and return matching elements',
    inputSchema: z.object({
        selector: z.string().describe('Simple selector: #id, .class, tag, tag.class, [attr=value], or text=...'),
        url: z.string().optional().describe('Existing page URL to query directly'),
        script: z.string().optional().describe('Preview-like script name to run before querying the page'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { selector } = input;
        try {
            const page = await resolvePageSource(input, context);
            const matches = parseElements(page.html)
                .filter((element) => matchesSimpleSelector(element, selector))
                .slice(0, 20)
                .map((element) => ({
                tag: element.tag,
                id: element.attrs.id,
                className: element.attrs.class,
                text: element.text,
                attrs: element.attrs,
            }));
            return {
                success: true,
                output: {
                    selector,
                    script: page.script,
                    command: page.command,
                    url: page.url,
                    httpStatus: page.httpStatus,
                    matchCount: matches.length,
                    matches,
                    stdout: page.stdout,
                    stderr: page.stderr,
                },
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
    },
};
export const frontendAccessibilityAuditTool = {
    name: 'frontend_accessibility_audit',
    type: 'exec',
    description: 'Run a lightweight structural accessibility audit against fetched frontend HTML',
    inputSchema: z.object({
        url: z.string().optional().describe('Existing page URL to audit directly'),
        script: z.string().optional().describe('Preview-like script name to run before auditing the page'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
    }),
    async execute(input, context) {
        const start = Date.now();
        try {
            const page = await resolvePageSource(input, context);
            const elements = parseElements(page.html);
            const labelsByFor = new Set(extractOpeningTags(page.html, 'label')
                .map((attrs) => attrs.for)
                .filter((value) => typeof value === 'string' && value.length > 0));
            const issues = [];
            for (const element of elements) {
                if (element.tag === 'img' && !('alt' in element.attrs)) {
                    issues.push({
                        rule: 'image-alt',
                        severity: 'major',
                        message: 'Image is missing an alt attribute.',
                        selectorHint: buildSelectorHint(element),
                    });
                }
                if (element.tag === 'button') {
                    const hasAccessibleName = Boolean(element.text
                        || element.attrs['aria-label']
                        || element.attrs.title);
                    if (!hasAccessibleName) {
                        issues.push({
                            rule: 'button-name',
                            severity: 'major',
                            message: 'Button does not have visible text or an aria-label/title.',
                            selectorHint: buildSelectorHint(element),
                        });
                    }
                }
                if (element.tag === 'a') {
                    const href = element.attrs.href || '';
                    if (!href || href === '#') {
                        issues.push({
                            rule: 'anchor-href',
                            severity: 'moderate',
                            message: 'Anchor is missing a meaningful href.',
                            selectorHint: buildSelectorHint(element),
                        });
                    }
                }
                if (element.tag === 'input') {
                    const type = (element.attrs.type || 'text').toLowerCase();
                    if (type !== 'hidden') {
                        const hasName = Boolean(element.attrs['aria-label']
                            || element.attrs.title
                            || (element.attrs.id && labelsByFor.has(element.attrs.id)));
                        if (!hasName) {
                            issues.push({
                                rule: 'input-label',
                                severity: 'major',
                                message: 'Input is missing an associated label or aria-label/title.',
                                selectorHint: buildSelectorHint(element),
                            });
                        }
                    }
                }
            }
            return {
                success: true,
                output: {
                    script: page.script,
                    command: page.command,
                    url: page.url,
                    httpStatus: page.httpStatus,
                    issueCount: issues.length,
                    issues,
                    stdout: page.stdout,
                    stderr: page.stderr,
                },
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
    },
};
export const frontendBrowserScreenshotTool = {
    name: 'frontend_browser_screenshot',
    type: 'exec',
    description: 'Capture a real browser screenshot with Playwright CLI against a local preview or explicit URL',
    inputSchema: z.object({
        url: z.string().optional().describe('Existing page URL to capture directly'),
        script: z.string().optional().describe('Preview-like script name to run before taking the screenshot'),
        outputPath: z.string().optional().describe('Relative or absolute path for the PNG artifact'),
        browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Browser engine to use'),
        fullPage: z.boolean().optional().describe('Capture the full scrollable page'),
        waitForSelector: z.string().optional().describe('Selector to wait for before capturing'),
        waitForTimeoutMs: z.number().optional().describe('Extra wait time before capture'),
        timeoutMs: z.number().optional().describe('Playwright timeout in milliseconds'),
        viewportSize: z.string().optional().describe('Viewport size, for example "1440,900"'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { url, script, outputPath, browser = 'chromium', fullPage, waitForSelector, waitForTimeoutMs, timeoutMs = 15_000, viewportSize, } = input;
        let preview;
        try {
            const targetUrl = url?.trim();
            if (!targetUrl) {
                const catalog = getFrontendCommandCatalog(context.cwd);
                const selectedScript = script || catalog.defaultPreviewScript;
                if (!selectedScript) {
                    throw new Error('No preview-like script found in package.json');
                }
                preview = await launchPreview(selectedScript, timeoutMs, context);
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            const finalUrl = targetUrl || preview?.url;
            if (!finalUrl)
                throw new Error('Could not resolve a preview URL for browser capture');
            const artifactPath = resolveArtifactPath(context, outputPath);
            await fs.mkdir(path.dirname(artifactPath), { recursive: true });
            const screenshot = await runPlaywrightScreenshot({
                url: finalUrl,
                outputPath: artifactPath,
                browser,
                fullPage,
                waitForSelector,
                waitForTimeoutMs,
                timeoutMs,
                viewportSize,
            }, context);
            if (screenshot.exitCode !== 0) {
                return {
                    success: false,
                    output: {
                        url: finalUrl,
                        script: script || getFrontendCommandCatalog(context.cwd).defaultPreviewScript,
                        previewCommand: preview?.command,
                        artifactPath,
                        stdout: screenshot.stdout,
                        stderr: screenshot.stderr,
                        previewStdout: preview?.stdoutRef.value ?? '',
                        previewStderr: preview?.stderrRef.value ?? '',
                    },
                    error: describePlaywrightFailure(screenshot.stderr, screenshot.exitCode),
                    durationMs: Date.now() - start,
                };
            }
            const stat = await fs.stat(artifactPath);
            return {
                success: true,
                output: {
                    url: finalUrl,
                    script: script || getFrontendCommandCatalog(context.cwd).defaultPreviewScript,
                    previewCommand: preview?.command,
                    browser,
                    artifactPath,
                    bytes: stat.size,
                    fullPage: Boolean(fullPage),
                    waitForSelector,
                    waitForTimeoutMs,
                    viewportSize,
                    command: screenshot.command,
                    stdout: screenshot.stdout,
                    stderr: screenshot.stderr,
                    previewStdout: preview?.stdoutRef.value ?? '',
                    previewStderr: preview?.stderrRef.value ?? '',
                },
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
            };
        }
        finally {
            if (preview) {
                await terminateProcess(preview.child);
            }
        }
    },
};
export const frontendTools = [
    frontendProjectInfoTool,
    frontendCommandCatalogTool,
    frontendRunScriptTool,
    frontendPreviewProbeTool,
    frontendHtmlSnapshotTool,
    frontendDomQueryTool,
    frontendAccessibilityAuditTool,
    frontendBrowserScreenshotTool,
];
//# sourceMappingURL=tools-frontend.js.map