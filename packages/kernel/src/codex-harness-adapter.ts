import type { ProviderRuntimeEvent } from '@tik/shared';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { CodexAppServerProcess } from './codex-app-server-process.js';

export interface CodexHarnessTurnOptions {
  prompt: string;
  cwd: string;
  model?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  allowWrites?: boolean;
  signal?: AbortSignal;
  onProviderEvent?: (event: ProviderRuntimeEvent) => void;
  onTextDelta?: (text: string) => void;
  onTurnVisible?: (source: 'turn.started' | 'item.started' | 'item.completed' | 'message.delta') => void;
}

export interface CodexHarnessThreadOptions {
  cwd: string;
  model?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  allowWrites?: boolean;
  signal?: AbortSignal;
}

export interface CodexHarnessTurnResult {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  turnId: string;
  threadId: string;
}

function mapCommandExecutionTool(command: string): { toolName: string; input: Record<string, unknown> } {
  return {
    toolName: 'bash',
    input: { command },
  };
}

interface HarnessObservedItemState {
  started: boolean;
  completed: boolean;
}

export class CodexHarnessAdapter {
  private readonly process: CodexAppServerProcess;
  private readonly client: CodexAppServerClient;
  private started = false;

  constructor(
    cwd: string,
    private readonly appVersion = '0.1.0',
  ) {
    this.process = new CodexAppServerProcess({ cwd });
    this.client = new CodexAppServerClient(this.process);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.client.start();
    await this.client.initialize({
      clientInfo: {
        name: 'tik',
        version: this.appVersion,
      },
      capabilities: null,
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.client.stop();
  }

  async startThread(options: CodexHarnessThreadOptions): Promise<string> {
    await this.start();
    const threadResponse = await this.client.request<any>('thread/start', {
      cwd: options.cwd,
      model: options.model ?? null,
      approvalPolicy: 'never',
      sandbox: options.allowWrites ? 'workspace-write' : 'read-only',
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    }, {
      timeoutMs: 90_000,
      signal: options.signal,
    });

    return threadResponse.thread.id as string;
  }

  async runTurn(options: CodexHarnessTurnOptions): Promise<CodexHarnessTurnResult> {
    const threadId = await this.startThread(options);
    return this.runTurnOnThread(threadId, options);
  }

  async runTurnOnThread(threadId: string, options: CodexHarnessTurnOptions): Promise<CodexHarnessTurnResult> {
    await this.start();
    let turnId = '';
    let content = '';
    let usage: CodexHarnessTurnResult['usage'];
    let threadSystemError = false;
    const observedItems = new Map<string, HarnessObservedItemState>();
    let turnVisible = false;
    let resolveTurnCompleted: ((status: 'completed' | 'failed' | 'interrupted') => void) | undefined;
    let rejectTurnCompleted: ((error: Error) => void) | undefined;
    const turnCompleted = new Promise<'completed' | 'failed' | 'interrupted'>((resolve, reject) => {
      resolveTurnCompleted = resolve;
      rejectTurnCompleted = reject;
    });
    const markTurnVisible = (source: 'turn.started' | 'item.started' | 'item.completed' | 'message.delta') => {
      if (turnVisible) return;
      turnVisible = true;
      options.onTurnVisible?.(source);
    };

    const unsubscribers = [
      this.client.onNotification<any>('turn/started', (params) => {
        if (params.threadId !== threadId) return;
        if (turnId && params.turn?.id !== turnId) return;
        markTurnVisible('turn.started');
      }),
      this.client.onNotification<any>('turn/completed', (params) => {
        if (params.threadId !== threadId) return;
        if (turnId && params.turn?.id !== turnId) return;
        const status = params.turn?.status;
        if (status === 'completed' || status === 'failed' || status === 'interrupted') {
          resolveTurnCompleted?.(status);
        } else {
          resolveTurnCompleted?.('completed');
        }
      }),
      this.client.onNotification<any>('item/agentMessage/delta', (params) => {
        if (params.threadId !== threadId) return;
        if (turnId && params.turnId !== turnId) return;
        const delta = String(params.delta || '');
        content += delta;
        if (delta) {
          markTurnVisible('message.delta');
        }
        options.onTextDelta?.(delta);
      }),
      this.client.onNotification<any>('item/started', (params) => {
        if (params.threadId !== threadId) return;
        if (turnId && params.turnId !== turnId) return;
        const item = params.item;
        if (item?.type !== 'commandExecution') return;
        markTurnVisible('item.started');
        const state = observedItems.get(item.id) || { started: false, completed: false };
        if (state.started) return;
        state.started = true;
        observedItems.set(item.id, state);
        const mapped = mapCommandExecutionTool(item.command || '');
        options.onProviderEvent?.({
          type: 'tool.called',
          toolName: mapped.toolName,
          input: mapped.input,
        });
      }),
      this.client.onNotification<any>('item/completed', (params) => {
        if (params.threadId !== threadId) return;
        if (turnId && params.turnId !== turnId) return;
        const item = params.item;
        if (item?.type === 'commandExecution') {
          markTurnVisible('item.completed');
          const state = observedItems.get(item.id) || { started: false, completed: false };
          if (!state.started) {
            state.started = true;
            observedItems.set(item.id, state);
            const mapped = mapCommandExecutionTool(item.command || '');
            options.onProviderEvent?.({
              type: 'tool.called',
              toolName: mapped.toolName,
              input: mapped.input,
            });
          }
          if (state.completed) return;
          state.completed = true;
          observedItems.set(item.id, state);
          const mapped = mapCommandExecutionTool(item.command || '');
          const success = item.status === 'completed' || item.exitCode === 0;
          options.onProviderEvent?.({
            type: 'tool.result',
            toolName: mapped.toolName,
            output: {
              command: item.command,
              stdout: item.aggregatedOutput,
              exitCode: item.exitCode,
            },
            success,
            error: success ? undefined : `Codex command exited with code ${item.exitCode ?? 'unknown'}`,
            durationMs: item.durationMs ?? undefined,
          });
          return;
        }
        if (item?.type === 'agentMessage' && !content && item.text) {
          content = String(item.text);
        }
      }),
      this.client.onNotification<any>('thread/tokenUsage/updated', (params) => {
        if (params.threadId !== threadId) return;
        if (turnId && params.turnId !== turnId) return;
        usage = {
          promptTokens: Number(params.tokenUsage?.last?.inputTokens || 0) + Number(params.tokenUsage?.last?.cachedInputTokens || 0),
          completionTokens: Number(params.tokenUsage?.last?.outputTokens || 0),
          totalTokens: Number(params.tokenUsage?.last?.totalTokens || 0),
        };
      }),
      this.client.onNotification<any>('thread/status/changed', (params) => {
        if (params.threadId !== threadId) return;
        if (params.status?.type === 'systemError') {
          threadSystemError = true;
          rejectTurnCompleted?.(new Error('Codex App Server reported thread systemError.'));
        }
      }),
    ];

    try {
      const turnResponse = await this.client.request<any>('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: options.prompt,
            text_elements: [],
          },
        ],
      }, {
        timeoutMs: 90_000,
        signal: options.signal,
      });

      turnId = turnResponse.turn.id as string;
      let turnTimeout: ReturnType<typeof setTimeout> | undefined;
      const status = await Promise.race([
        turnCompleted,
        new Promise<'completed'>((_, reject) => {
          turnTimeout = setTimeout(() => reject(new Error('Codex App Server turn timed out.')), 15 * 60_000);
          turnTimeout.unref?.();
        }),
      ]);
      if (turnTimeout) clearTimeout(turnTimeout);
      if (threadSystemError) {
        throw new Error('Codex App Server reported thread systemError.');
      }
      if (status === 'failed') {
        throw new Error('Codex App Server turn failed.');
      }
      if (status === 'interrupted') {
        throw new Error('Codex App Server turn was interrupted.');
      }
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }

    return {
      content,
      usage,
      turnId,
      threadId,
    };
  }
}
