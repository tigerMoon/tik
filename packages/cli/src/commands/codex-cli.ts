/**
 * Codex CLI Provider
 *
 * Delegates execution to the local `codex exec` command so Tik can reuse
 * official Codex login/session/tooling instead of maintaining a bridge layer.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CodexHarnessAdapter } from '@tik/kernel';
import type {
  ChatMessage,
  ChatResponse,
  ILLMProvider,
  LLMCallOptions,
  LLMPlanResponse,
  LLMToolDef,
} from '@tik/shared';

export function hasCodexCli(): boolean {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf-8' });
  return result.status === 0;
}

export function hasCodexLogin(): boolean {
  const result = spawnSync('codex', ['login', 'status'], { encoding: 'utf-8' });
  if (result.status !== 0) return false;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /logged in/i.test(output);
}

interface CodexRunResult {
  content: string;
  executedActions: Array<{
    tool: string;
    input: unknown;
    output?: unknown;
    success: boolean;
  }>;
  stdout: string;
  stderr: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  policyViolation?: boolean;
  gracefulStop?: boolean;
}

interface CodexCommandExecutionItem {
  id: string;
  type: 'command_execution';
  command: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexJsonEvent {
  type: string;
  item?: CodexCommandExecutionItem & { type?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface MappedCodexCommandExecution {
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
}

export function buildDelegateImplementationContract(
  taskDescription: string,
  context: string | undefined,
  runtimeSystemMessages: string,
  writeToolsAvailable: boolean,
): string {
  const keyFiles = extractDelegateHints(context, ['Key files:', '- Key files:', 'Likely Target Paths:', '- Likely Target Paths:']);
  const pendingWork = extractDelegateHints(context, ['Pending work:', '- Pending work:']);
  const currentFocus = extractDelegateHints(context, ['Current focus:', '- Current focus:']);

  const sections = [
    '# Delegate Implementation Contract',
    'You are executing a delegated subtask for Tik.',
    `Task: ${taskDescription}`,
    '',
    '## Primary Objective',
    '- Complete this delegated subtask end-to-end inside Codex without depending on Tik to micro-manage intermediate steps.',
    '- Prefer a concrete implementation result when the patch point is already clear and safe.',
    '- If a code change is not justified, finish with an evidence-based conclusion instead of forcing a patch.',
    '',
    '## Delegate Working Contract',
    '- You own the full execution of this subtask inside this run: investigation, implementation when appropriate, minimal validation, and final summary.',
    '- Use Tik context and hinted files to avoid broad rediscovery, but choose your own internal step order.',
    '- Keep exploration proportional to the task; do not keep collecting adjacent evidence once you can already finish the subtask.',
    '',
    '## Acceptable Completion Conditions',
    '- You made a real patch and can summarize the affected files, rationale, and any validation attempted.',
    '- Or you can explicitly conclude that no code changes are needed, with file-based evidence and a clear reason.',
    '- Or you can report a concrete blocker that prevents safe completion in this run.',
    '',
    '## Disallowed Failure Modes',
    '- Do not oscillate between broad repository search and local file inspection once the likely target module is already known.',
    '- Do not hand control back just because a patch would require one more implementation step that you can perform yourself.',
    '- Do not keep validating repeatedly after the subtask outcome is already clear.',
    '',
    '## Output Expectation',
    '- End with a concise delegated-result summary: what you changed or concluded, which files matter, and any remaining blocker or follow-up.',
  ];

  if (keyFiles.length > 0) {
    sections.push('', '## Key Files / Target Paths');
    for (const line of keyFiles) sections.push(`- ${line}`);
  }

  if (pendingWork.length > 0) {
    sections.push('', '## Pending Work');
    for (const line of pendingWork) sections.push(`- ${line}`);
  }

  if (currentFocus.length > 0) {
    sections.push('', '## Current Focus');
    for (const line of currentFocus) sections.push(`- ${line}`);
  }

  if (/Implementation strict:\s*yes/i.test(context || '') || /implementation mode is active/i.test(runtimeSystemMessages)) {
    sections.push('', '## Tik Runtime State', '- Tik has already identified this as an implementation-oriented subtask. Prefer finishing the subtask over reopening broad discovery.');
  }

  if (writeToolsAvailable) {
    sections.push('', '## Tik Write Capability', '- Tik has granted write-capable tools for this delegated run. Use them when the patch is clear; do not wait for Tik to explicitly switch you into a write phase.');
  }

  return sections.join('\n');
}

export function buildDelegateDocumentationContract(
  taskDescription: string,
  context: string | undefined,
  writeToolsAvailable: boolean,
): string {
  const keyFiles = extractDelegateHints(context, ['Key files:', '- Key files:', 'Likely Target Paths:', '- Likely Target Paths:']);
  const explicitTargets = extractArtifactTargets(taskDescription, context);

  const sections = [
    '# Delegate Documentation Contract',
    'You are executing a delegated documentation/planning subtask for Tik.',
    `Task: ${taskDescription}`,
    '',
    '## Primary Objective',
    '- Complete this subtask by producing or repairing the requested markdown artifact at the target path.',
    '- Focus on the target document and the minimum supporting evidence needed from the repository.',
    '- Do not drift into implementation, environment validation, or unrelated repository work.',
    '',
    '## Delegate Working Contract',
    '- Read only the files needed to understand the requested spec/plan output.',
    '- Prefer updating the target markdown file directly once the structure and content are clear.',
    '- If Tik provided an explicit target path, create parent directories if needed and write exactly that file.',
    '- Stop after the document is concrete, executable, and free of template placeholders.',
    '',
    '## Acceptable Completion Conditions',
    '- You created or repaired the target markdown artifact and can summarize what changed.',
    '- Or you can explicitly conclude that the existing document is already complete and reusable, with file-based evidence.',
    '- Or you can report a concrete blocker that prevents safe completion in this run.',
    '',
    '## Disallowed Failure Modes',
    '- Do not treat this as a business-code implementation task unless the subtask explicitly asks for code changes.',
    '- Do not loop on repeated repository inspection after the target document is already clearly determined.',
    '- Do not run validation/build/test commands for a documentation-only subtask.',
    '- Do not write to a generic `.specify/specs/spec.md` or `.specify/specs/plan.md` when Tik provided a feature-local target path.',
    '- Do not redirect output into historical feature directories unless Tik explicitly pointed you there.',
    '',
    '## Output Expectation',
    '- End with a concise delegated-result summary: target file, what changed or was confirmed, and any blocker.',
  ];

  if (explicitTargets.length > 0) {
    sections.push('', '## Explicit Artifact Targets');
    for (const target of explicitTargets) sections.push(`- ${target}`);
  }

  if (keyFiles.length > 0) {
    sections.push('', '## Key Files / Target Paths');
    for (const line of keyFiles) sections.push(`- ${line}`);
  }

  if (writeToolsAvailable) {
    sections.push('', '## Tik Write Capability', '- Tik has granted write-capable tools for this delegated run. Use them to update the target markdown artifact directly when ready.');
  }

  return sections.join('\n');
}

function extractArtifactTargets(taskDescription: string, context?: string): string[] {
  const source = [taskDescription, context || ''].filter(Boolean).join('\n');
  const targets = [
    ...extractDelegateHints(source, ['Target spec path:', '- Target spec path:']),
    ...extractDelegateHints(source, ['Resolved spec path:', '- Resolved spec path:']),
    ...extractDelegateHints(source, ['Target plan path:', '- Target plan path:']),
  ];
  return Array.from(new Set(targets));
}

export function shouldStopForPostPatchValidation(
  normalizedCommand: string,
  patchFirstRequired: boolean,
  hasWorkspaceChanges: boolean,
  validationAttemptsAfterPatch: number,
  exitCode: number | null,
): { stop: boolean; reason?: string } {
  if (!patchFirstRequired || !hasWorkspaceChanges) {
    return { stop: false };
  }

  if (!isValidationLikeCommandValue(normalizedCommand)) {
    return { stop: false };
  }

  if (validationAttemptsAfterPatch > 1) {
    return {
      stop: true,
      reason: [
        'Patch-first completion gate: stopping after repeated post-patch validation attempts.',
        `Blocked command: ${normalizedCommand}`,
        'Tik requires native Codex to summarize the current patch instead of looping on more validation commands.',
      ].join('\n'),
    };
  }

  if (exitCode !== null && exitCode !== 0) {
    return {
      stop: true,
      reason: [
        'Patch-first completion gate: stopping after the first failed post-patch validation attempt.',
        `Blocked command: ${normalizedCommand}`,
        'Tik requires native Codex to summarize the current patch and validation status instead of continuing to loop on failing validation.',
      ].join('\n'),
    };
  }

  return { stop: false };
}

export function shouldStopForPostPatchReadLoop(
  toolName: string,
  hasWorkspaceChanges: boolean,
  currentChangedFileCount: number,
  lastChangedFileCount: number,
  postPatchReadOnlySteps: number,
): { stop: boolean; reason?: string } {
  if (!hasWorkspaceChanges) return { stop: false };
  if (!isReadLikeNativeToolName(toolName)) return { stop: false };
  if (currentChangedFileCount > lastChangedFileCount) return { stop: false };
  if (postPatchReadOnlySteps < 12) return { stop: false };

  return {
    stop: true,
    reason: [
      'Patch-first completion gate: stopping after excessive post-patch read-only exploration.',
      `Observed ${postPatchReadOnlySteps} consecutive read-only native tool calls without additional code changes.`,
      'Tik requires native Codex to summarize the current patch instead of continuing to gather more implementation evidence.',
    ].join('\n'),
  };
}

export function normalizeCodexShellCommand(command: string): string {
  const trimmed = command.trim();
  const zshMatch = trimmed.match(/^-?\/?bin\/zsh\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (zshMatch) return zshMatch[2].trim();

  const shMatch = trimmed.match(/^-?\/?bin\/sh\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (shMatch) return shMatch[2].trim();

  return trimmed;
}

export function mapCodexCommandExecution(command: string, aggregatedOutput = ''): MappedCodexCommandExecution {
  const normalized = normalizeCodexShellCommand(command);
  const trimmedOutput = aggregatedOutput || '';

  const rgFilesMatch = normalized.match(/^rg\s+--files(?:\s+(.+))?$/);
  if (rgFilesMatch) {
    const root = rgFilesMatch[1]?.trim();
    return {
      toolName: 'glob',
      input: {
        pattern: root ? `${root}/**/*` : '**/*',
        command: normalized,
      },
      output: trimmedOutput.split('\n').map((line) => line.trim()).filter(Boolean),
    };
  }

  const catMatch = normalized.match(/^cat\s+(.+)$/);
  if (catMatch) {
    const path = catMatch[1].trim().replace(/^["']|["']$/g, '');
    return {
      toolName: 'read_file',
      input: {
        path,
        command: normalized,
      },
      output: trimmedOutput,
    };
  }

  const sedMatch = normalized.match(/^sed\s+-n\s+['"][^'"]+['"]\s+(.+)$/);
  if (sedMatch) {
    const path = sedMatch[1].trim().replace(/^["']|["']$/g, '');
    return {
      toolName: 'read_file',
      input: {
        path,
        command: normalized,
      },
      output: trimmedOutput,
    };
  }

  const rgMatch = normalized.match(/^(rg|grep)\b[\s\S]*?["']([^"']+)["'](?:\s+(.+))?$/);
  if (rgMatch) {
    return {
      toolName: 'grep',
      input: {
        pattern: rgMatch[2],
        path: rgMatch[3]?.trim(),
        command: normalized,
      },
      output: trimmedOutput,
    };
  }

  if (normalized.startsWith('find ')) {
    const rootMatch = normalized.match(/^find\s+(\S+)/);
    const nameMatch = normalized.match(/-name\s+["']?([^"']+)["']?/);
    const root = rootMatch?.[1] || '.';
    const pattern = nameMatch?.[1] || '**/*';
    return {
      toolName: 'glob',
      input: {
        pattern,
        cwd: root,
        command: normalized,
      },
      output: trimmedOutput.split('\n').map((line) => line.trim()).filter(Boolean),
    };
  }

  if (normalized === 'git status --short' || normalized === 'git status --short --branch' || normalized === 'git status --porcelain' || normalized === 'git status --porcelain --branch') {
    return {
      toolName: 'git_status',
      input: {
        command: normalized,
      },
      output: trimmedOutput,
    };
  }

  if (normalized.startsWith('git diff')) {
    return {
      toolName: 'git_diff',
      input: {
        command: normalized,
      },
      output: trimmedOutput,
    };
  }

  if (normalized.startsWith('git log')) {
    return {
      toolName: 'git_log',
      input: {
        command: normalized,
      },
      output: trimmedOutput,
    };
  }

  return {
    toolName: 'bash',
    input: {
      command,
    },
    output: {
      command,
      stdout: trimmedOutput,
    },
  };
}

export class CodexCliProvider implements ILLMProvider {
  name: 'codex' | 'codex-delegate';
  private readonly projectPath: string;
  private readonly model?: string;
  private readonly mode: 'governed' | 'delegate';

  constructor(projectPath: string, model?: string, mode: 'governed' | 'delegate' = 'governed') {
    this.projectPath = projectPath;
    this.model = process.env.TIK_MODEL || model;
    this.mode = mode;
    this.name = mode === 'delegate' ? 'codex-delegate' : 'codex';
  }

  async plan(prompt: string, context: string): Promise<LLMPlanResponse> {
    const result = await this.runCodex(
      [
        'You are generating a plan only for Tik.',
        'Do not modify any files.',
        'Return only valid JSON with keys: goals, actions, reasoning.',
        'Each action must contain: tool, input, reason.',
        '',
        `Task: ${prompt}`,
        '',
        'Project Context:',
        context.slice(0, 30000),
      ].join('\n'),
      false,
    );

    const parsed = this.parseJsonResponse(result.content);
    return {
      goals: Array.isArray(parsed.goals) ? parsed.goals.map(String) : ['Execute the task'],
      actions: Array.isArray(parsed.actions)
        ? parsed.actions.map((action: any) => ({
            tool: String(action.tool || 'read_file'),
            input: typeof action.input === 'object' && action.input ? action.input : {},
            reason: String(action.reason || ''),
          }))
        : [],
      reasoning: String(parsed.reasoning || result.content || 'Generated by Codex CLI provider'),
    };
  }

  async complete(prompt: string, options?: LLMCallOptions): Promise<string> {
    const result = await this.runCodex(prompt, options?.allowWrites ?? false, options);
    return result.content;
  }

  async chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse> {
    const prompt = this.buildPrompt(messages, undefined, undefined, tools);
    const result = await this.runCodex(prompt, this.shouldAllowWrites(tools));
    return this.toChatResponse(result);
  }

  async chatWithContext(
    messages: ChatMessage[],
    systemPrompt: string,
    context: string,
    tools?: LLMToolDef[],
    options?: LLMCallOptions,
  ): Promise<ChatResponse> {
    const prompt = this.buildPrompt(messages, systemPrompt, context, tools);
    const result = await this.runCodex(prompt, this.shouldAllowWrites(tools), options);
    return this.toChatResponse(result);
  }

  private shouldAllowWrites(tools?: LLMToolDef[]): boolean {
    if (!tools?.length) return true;
    return tools.some((tool) => tool.name === 'write_file' || tool.name === 'edit_file');
  }

  private buildPrompt(
    messages: ChatMessage[],
    systemPrompt?: string,
    context?: string,
    tools?: LLMToolDef[],
  ): string {
    const visibleMessages = messages
      .filter((message) => message.role !== 'system')
      .slice(-12)
      .map((message) => {
        const label = message.name ? `${message.role}(${message.name})` : message.role;
        return `## ${label}\n${message.content}`;
      })
      .join('\n\n');

    const runtimeSystemMessages = messages
      .filter((message) => message.role === 'system')
      .slice(-4)
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n\n');

    const toolList = tools?.length
      ? tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')
      : '- No Tik tools were provided for this turn.';

    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
    const documentationWorkflowTask = this.isDocumentationWorkflowTask(latestUserMessage);
    const effectiveSystemPrompt = documentationWorkflowTask
      ? [
          'You are a documentation and planning agent working for Tik.',
          'Your job is to generate or repair the requested markdown artifact for the current workspace phase.',
          'Read only the minimum relevant files, update the target artifact directly with native tools, and stop when it is concrete and free of template placeholders.',
        ].join('\n')
      : systemPrompt;
    const implementationIntent = !documentationWorkflowTask && this.isImplementationTask(latestUserMessage);
    const implementationStrict = /Implementation strict:\s*yes/i.test(context || '')
      || /implementation mode is active/i.test(runtimeSystemMessages);
    const currentFocusImplementation = /Current focus:\s*implementation/i.test(context || '');
    const pendingWorkRequiresCode = /Pending work:\s*(?!$)/i.test(context || '')
      && !/no code changes are needed|无需改代码|不需要改代码/i.test(runtimeSystemMessages);
    const writeToolsAvailable = !!tools?.some((tool) => tool.name === 'edit_file' || tool.name === 'write_file');
    const writeOnlyTurn = !!tools?.length && tools.every((tool) => tool.name === 'edit_file' || tool.name === 'write_file');

    if (this.mode === 'delegate') {
      const delegateContract = documentationWorkflowTask
        ? buildDelegateDocumentationContract(latestUserMessage, context, writeToolsAvailable)
        : implementationIntent
          ? buildDelegateImplementationContract(latestUserMessage, context, runtimeSystemMessages, writeToolsAvailable)
          : '';

      return [
        'You are Codex running as Tik\'s delegated execution engine.',
        documentationWorkflowTask
          ? 'Complete this delegated workspace/documentation task end-to-end inside this single run.'
          : 'Complete this coding task end-to-end inside this single delegated run.',
        documentationWorkflowTask
          ? 'Use your native tools directly to read the minimum relevant files and write the target markdown artifact yourself at the explicit target path.'
          : 'Use your native tools directly. Read files, edit code, and run only the most relevant validation that is necessary after a concrete patch.',
        'Do not optimize for handing control back to Tik mid-task.',
        documentationWorkflowTask
          ? 'When the target document is complete or can be explicitly confirmed as already complete, stop and provide a concise final summary.'
          : 'When you have either produced the needed patch or can clearly conclude that no code changes are needed, stop and provide a concise final summary.',
        '',
        delegateContract,
        effectiveSystemPrompt ? `# Tik System Prompt\n${effectiveSystemPrompt}` : '',
        runtimeSystemMessages ? `# Tik Runtime Control\n${runtimeSystemMessages}` : '',
        context ? `# Tik Context\n${context.slice(0, 40000)}` : '',
        '# Recent Tik Conversation',
        visibleMessages || '(none)',
      ].filter(Boolean).join('\n\n');
    }

    const executionDirectives = [
      implementationIntent
        ? 'This is an implementation task. Do not stop at analysis when code changes are still needed.'
        : '',
      implementationStrict || currentFocusImplementation
        ? 'Implementation mode is active. Prefer editing the identified files over doing more read-only exploration.'
        : '',
      implementationStrict && pendingWorkRequiresCode
        ? 'Pending work still requires code changes. Your next useful action should be to modify code directly, unless you can clearly conclude with evidence that no code changes are needed.'
        : '',
      implementationStrict && pendingWorkRequiresCode && writeToolsAvailable
        ? 'Your next tool use should modify a concrete target file with edit_file or write_file. Do not spend another turn on only read-only probes.'
        : '',
      writeOnlyTurn
        ? 'Tik has restricted this turn to code modification only. Produce the smallest relevant patch now, or stop calling tools and clearly explain why no code changes are needed.'
        : '',
      writeOnlyTurn
        ? 'Do not spend this turn on more file reads, grep, search, or test commands. Use the evidence you already have and make the smallest safe code change now.'
        : '',
      implementationStrict && pendingWorkRequiresCode
        ? 'Do not run environment checks, build commands, or tests before the first relevant code change. Validation comes after a concrete patch.'
        : '',
      implementationStrict
        ? 'Do not keep looping on read-only inspection of the same area. Move to a concrete patch or an explicit no-change conclusion.'
        : '',
    ].filter(Boolean).join('\n');

    return [
      'You are Codex running on behalf of Tik.',
      'Execute the task directly in the workspace using native Codex capabilities.',
      'If code changes are needed, make them directly.',
      'When finished, provide a concise final summary that states whether code changes were made and which files matter.',
      'Do not ask the user to manually run commands that you can run yourself.',
      '',
      effectiveSystemPrompt ? `# Tik System Prompt\n${effectiveSystemPrompt}` : '',
      executionDirectives ? `# Tik Execution Directives\n${executionDirectives}` : '',
      runtimeSystemMessages ? `# Tik Runtime Control\n${runtimeSystemMessages}` : '',
      context ? `# Tik Context\n${context.slice(0, 40000)}` : '',
      '# Recent Tik Conversation',
      visibleMessages || '(none)',
      '',
      '# Tik Tool Capability Hint',
      toolList,
    ].filter(Boolean).join('\n\n');
  }

  private isImplementationTask(taskDescription: string): boolean {
    const lowered = taskDescription.toLowerCase();
    return (
      lowered.includes('实现')
      || lowered.includes('修改')
      || lowered.includes('新增')
      || lowered.includes('加缓存')
      || lowered.includes('做缓存')
      || lowered.includes('修复')
      || lowered.includes('优化')
      || lowered.includes('implement')
      || lowered.includes('fix ')
      || lowered.includes('add ')
      || lowered.includes('cache')
    );
  }

  private isDocumentationWorkflowTask(taskDescription: string): boolean {
    if (/workspace parallel_ace subtask/i.test(taskDescription)) return false;
    return /workspace parallel_(specify|plan) subtask/i.test(taskDescription)
      || /expected output:\s*\.specify\/specs\/(spec|plan)\.md/i.test(taskDescription);
  }

  private async runCodex(
    prompt: string,
    allowWrites: boolean,
    options?: LLMCallOptions,
  ): Promise<CodexRunResult> {
    if (!hasCodexCli()) {
      throw new Error('Codex CLI not found. Install `codex` and try again.');
    }
    if (!hasCodexLogin()) {
      throw new Error('Codex CLI is not logged in. Run `codex login` first.');
    }

    const beforeFiles = await this.captureChangedFiles();
    const harness = new CodexHarnessAdapter(this.projectPath);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new Error(typeof signal.reason === 'string' ? signal.reason : 'Codex execution aborted by Tik.');
    }
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void harness.stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let harnessResult: Awaited<ReturnType<CodexHarnessAdapter['runTurn']>>;
    try {
      harnessResult = await harness.runTurn({
        prompt,
        cwd: this.projectPath,
        model: this.model,
        allowWrites,
        onProviderEvent: options?.onProviderEvent,
        onTextDelta: options?.onTextChunk,
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await harness.stop();
    }
    if (aborted) {
      throw new Error(typeof signal?.reason === 'string' ? signal.reason : 'Codex execution aborted by Tik.');
    }
    const afterFiles = await this.captureChangedFiles();
    const changedFiles = [...afterFiles].filter((file) => !beforeFiles.has(file));

    return {
      content: harnessResult.content,
      executedActions: changedFiles.map((path) => ({
        tool: 'write_file',
        input: { path },
        output: 'Modified by Codex CLI',
        success: true,
      })),
      stdout: '',
      stderr: '',
      usage: harnessResult.usage,
    };
  }

  private async spawnCodex(
    args: string[],
    beforeFiles: Set<string>,
    patchFirstRequired: boolean,
    options?: LLMCallOptions,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    policyViolation?: boolean;
    gracefulStop?: boolean;
    abortedReason?: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd: this.projectPath,
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      let policyViolation: string | undefined;
      let gracefulStop: string | undefined;
      let abortedReason: string | undefined;
      const signal = (options as (LLMCallOptions & { signal?: AbortSignal }) | undefined)?.signal;
      let validationAttemptsAfterPatch = 0;
      let postPatchReadOnlySteps = 0;
      let lastChangedFileCount = beforeFiles.size;

      const abortHandler = () => {
        abortedReason = typeof signal?.reason === 'string'
          ? signal.reason
          : 'Codex execution aborted by Tik.';
        child.kill('SIGTERM');
      };
      if (signal) {
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdout += text;
        stdoutBuffer += text;

        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

          if (line) {
            const parsed = this.parseCodexJsonLine(line);
            if (parsed) {
              const eventUsage = this.extractUsage(parsed);
              if (eventUsage) usage = eventUsage;
              this.emitProviderRuntimeEvent(parsed, options);

              if (
                !policyViolation
                && !gracefulStop
                && patchFirstRequired
                && parsed.type === 'item.started'
                && parsed.item?.type === 'command_execution'
              ) {
                const normalized = normalizeCodexShellCommand(parsed.item.command || '');
                const hasWorkspaceChanges = this.hasNewWorkspaceChanges(beforeFiles);
                if (this.isValidationLikeCommand(normalized) && !hasWorkspaceChanges) {
                  policyViolation = [
                    'Patch-first policy violation: validation/build command attempted before the first relevant code change.',
                    `Blocked command: ${normalized}`,
                    'Tik requires implementation tasks to produce a concrete patch before running tests or build validation.',
                  ].join('\n');
                  child.kill('SIGTERM');
                  continue;
                }

                if (this.isValidationLikeCommand(normalized) && hasWorkspaceChanges) {
                  validationAttemptsAfterPatch += 1;
                  const stopDecision = shouldStopForPostPatchValidation(
                    normalized,
                    patchFirstRequired,
                    hasWorkspaceChanges,
                    validationAttemptsAfterPatch,
                    null,
                  );
                  if (stopDecision.stop) {
                    gracefulStop = stopDecision.reason;
                    child.kill('SIGTERM');
                    continue;
                  }
                }
              }

              if (
                !policyViolation
                && !gracefulStop
                && patchFirstRequired
                && parsed.type === 'item.completed'
                && parsed.item?.type === 'command_execution'
              ) {
                const normalized = normalizeCodexShellCommand(parsed.item.command || '');
                const currentChangedFiles = this.captureChangedFilesSync();
                const currentChangedFileCount = currentChangedFiles.size;
                const hasWorkspaceChanges = currentChangedFileCount > beforeFiles.size;
                const stopDecision = shouldStopForPostPatchValidation(
                  normalized,
                  patchFirstRequired,
                  hasWorkspaceChanges,
                  validationAttemptsAfterPatch,
                  typeof parsed.item.exit_code === 'number' ? parsed.item.exit_code : null,
                );
                if (stopDecision.stop) {
                  gracefulStop = stopDecision.reason;
                  child.kill('SIGTERM');
                  continue;
                }

                const mapped = mapCodexCommandExecution(parsed.item.command || '', parsed.item.aggregated_output || '');
                if (currentChangedFileCount > lastChangedFileCount) {
                  lastChangedFileCount = currentChangedFileCount;
                  postPatchReadOnlySteps = 0;
                } else if (
                  hasWorkspaceChanges
                  && isReadLikeNativeToolName(mapped.toolName)
                  && (typeof parsed.item.exit_code !== 'number' || parsed.item.exit_code === 0)
                ) {
                  postPatchReadOnlySteps += 1;
                  const readLoopDecision = shouldStopForPostPatchReadLoop(
                    mapped.toolName,
                    hasWorkspaceChanges,
                    currentChangedFileCount,
                    lastChangedFileCount,
                    postPatchReadOnlySteps,
                  );
                  if (readLoopDecision.stop) {
                    gracefulStop = readLoopDecision.reason;
                    child.kill('SIGTERM');
                    continue;
                  }
                }
              }
            } else {
              options?.onTextChunk?.(`${line}\n`);
            }
          }

          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      child.on('error', reject);
      child.on('close', (exitCode) => {
        if (signal) {
          signal.removeEventListener?.('abort', abortHandler);
        }
        const remainder = stdoutBuffer.trim();
        if (remainder) {
          const parsed = this.parseCodexJsonLine(remainder);
          if (parsed) {
            const eventUsage = this.extractUsage(parsed);
            if (eventUsage) usage = eventUsage;
            this.emitProviderRuntimeEvent(parsed, options);
          } else {
            options?.onTextChunk?.(`${remainder}\n`);
          }
        }

        resolve({
          stdout,
          stderr: [stderr, policyViolation, gracefulStop].filter(Boolean).join('\n').trim(),
          exitCode,
          usage,
          policyViolation: !!policyViolation,
          gracefulStop: !!gracefulStop,
          abortedReason,
        });
      });
    });
  }

  private requiresPatchFirst(prompt: string): boolean {
    return /# Tik Execution Directives[\s\S]*Pending work still requires code changes/i.test(prompt)
      || /Tik has restricted this turn to code modification only/i.test(prompt);
  }

  private isValidationLikeCommand(normalizedCommand: string): boolean {
    return isValidationLikeCommandValue(normalizedCommand);
  }

  private hasNewWorkspaceChanges(beforeFiles: Set<string>): boolean {
    return this.captureChangedFilesSync().size > beforeFiles.size;
  }

  private captureChangedFilesSync(): Set<string> {
    const result = spawnSync('git', ['-C', this.projectPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
    });
    if (result.status !== 0) return new Set<string>();
    return new Set(
      (result.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean),
    );
  }

  private async captureChangedFiles(): Promise<Set<string>> {
    const result = spawnSync('git', ['-C', this.projectPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
    });
    if (result.status !== 0) return new Set<string>();

    const files = (result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return new Set(files);
  }

  private async readLastMessage(lastMessagePath: string, stdout: string, stderr: string): Promise<string> {
    try {
      const content = await readFile(lastMessagePath, 'utf-8');
      if (content.trim()) return content.trim();
    } catch {
      // fall back to stdout/stderr
    }

    const fallback = stdout.trim() || stderr.trim();
    if (fallback) return fallback;
    return 'Codex completed without returning a final message.';
  }

  private toChatResponse(result: CodexRunResult): ChatResponse {
    const normalizedContent = this.mode === 'delegate'
      ? result.executedActions.length > 0
        ? `已完成委托执行，并产生代码修改。\n\n${result.content}`
        : `已完成委托执行。\n\n${result.content}`
      : result.policyViolation
        ? result.content
      : result.gracefulStop
        ? `已完成代码修改，并在验证阶段收束。\n\n${result.content}`
      : result.executedActions.length > 0
        ? `已完成代码修改。\n\n${result.content}`
        : `无需改代码。\n\n${result.content}`;
    const promptTokens = result.usage?.promptTokens ?? Math.ceil(result.content.length / 4);
    const completionTokens = result.usage?.completionTokens ?? 0;
    const totalTokens = result.usage?.totalTokens ?? (promptTokens + completionTokens);
    return {
      content: normalizedContent,
      executedActions: result.executedActions,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
    };
  }

  private parseJsonResponse(content: string): any {
    const trimmed = content.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const match = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```([\s\S]*?)```/);
      if (match) {
        return JSON.parse(match[1].trim());
      }
      throw new Error('Failed to parse JSON plan from Codex CLI response');
    }
  }

  private parseCodexJsonLine(line: string): CodexJsonEvent | null {
    try {
      return JSON.parse(line) as CodexJsonEvent;
    } catch {
      return null;
    }
  }

  private extractUsage(event: CodexJsonEvent): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    if (event.type !== 'turn.completed' || !event.usage) return undefined;

    const promptTokens = Number(event.usage.input_tokens || 0) + Number(event.usage.cached_input_tokens || 0);
    const completionTokens = Number(event.usage.output_tokens || 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private emitProviderRuntimeEvent(event: CodexJsonEvent, options?: LLMCallOptions): void {
    const item = event.item;
    if (!item || item.type !== 'command_execution' || !item.command) return;
    const mapped = mapCodexCommandExecution(item.command, item.aggregated_output || '');

    if (event.type === 'item.started') {
      options?.onProviderEvent?.({
        type: 'tool.called',
        toolName: mapped.toolName,
        input: mapped.input,
      });
      return;
    }

    if (event.type === 'item.completed') {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      const success = exitCode === 0;
      options?.onProviderEvent?.({
        type: 'tool.result',
        toolName: mapped.toolName,
        output: mapped.toolName === 'bash'
          ? {
              ...(mapped.output as Record<string, unknown>),
              exitCode,
            }
          : mapped.output,
        success,
        error: success ? undefined : `Codex command exited with code ${exitCode ?? 'unknown'}`,
      });
    }
  }
}

function isValidationLikeCommandValue(normalizedCommand: string): boolean {
  return (
    /^mvn\b/.test(normalizedCommand)
    || /^\.\/mvnw\b/.test(normalizedCommand)
    || /^gradle\b/.test(normalizedCommand)
    || /^\.\/gradlew\b/.test(normalizedCommand)
    || /^java\s+-version\b/.test(normalizedCommand)
    || /^mvn\s+-version\b/.test(normalizedCommand)
    || /^npm\s+test\b/.test(normalizedCommand)
    || /^pnpm\s+test\b/.test(normalizedCommand)
    || /^yarn\s+test\b/.test(normalizedCommand)
    || /\btest\b/.test(normalizedCommand)
  );
}

function isReadLikeNativeToolName(toolName: string): boolean {
  return toolName === 'read_file'
    || toolName === 'grep'
    || toolName === 'glob'
    || toolName === 'git_diff'
    || toolName === 'git_status'
    || toolName === 'git_log';
}

function extractDelegateHints(context: string | undefined, prefixes: string[]): string[] {
  if (!context) return [];
  const loweredPrefixes = prefixes.map((prefix) => prefix.toLowerCase());
  return context
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => loweredPrefixes.some((prefix) => line.toLowerCase().startsWith(prefix.toLowerCase())))
    .map((line) => line.replace(/^-+\s*/, ''));
}
