import {
  CodexHarnessAdapter,
  type CodexHarnessThreadOptions,
  type CodexHarnessTurnOptions,
  type CodexHarnessTurnResult,
} from './codex-harness-adapter.js';

export interface CodexHarnessSessionRunOptions extends CodexHarnessTurnOptions {
  sessionKey: string;
}

interface CodexHarnessNativeSession {
  adapter: CodexHarnessAdapter;
  threadId: string;
  threadOptions: CodexHarnessThreadOptions;
}

export class CodexHarnessSessionManager {
  private readonly sessions = new Map<string, CodexHarnessNativeSession>();

  constructor(
    private readonly defaultCwd: string,
    private readonly appVersion = '0.1.0',
  ) {}

  async runTurn(options: CodexHarnessSessionRunOptions): Promise<CodexHarnessTurnResult> {
    const session = await this.getOrCreateSession(options);
    return session.adapter.runTurnOnThread(session.threadId, options);
  }

  async closeSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    this.sessions.delete(sessionKey);
    await session.adapter.stop();
  }

  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();
    await Promise.allSettled(sessions.map(([, session]) => session.adapter.stop()));
  }

  private async getOrCreateSession(options: CodexHarnessSessionRunOptions): Promise<CodexHarnessNativeSession> {
    const existing = this.sessions.get(options.sessionKey);
    if (existing) return existing;

    const adapter = new CodexHarnessAdapter(options.cwd || this.defaultCwd, this.appVersion);
    const threadOptions: CodexHarnessThreadOptions = {
      cwd: options.cwd || this.defaultCwd,
      model: options.model,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
      allowWrites: options.allowWrites,
      signal: options.signal,
    };
    const threadId = await adapter.startThread(threadOptions);
    const session = { adapter, threadId, threadOptions };
    this.sessions.set(options.sessionKey, session);
    return session;
  }
}
