import { CodexHarnessAdapter, } from './codex-harness-adapter.js';
export class CodexHarnessSessionManager {
    defaultCwd;
    appVersion;
    sessions = new Map();
    constructor(defaultCwd, appVersion = '0.1.0') {
        this.defaultCwd = defaultCwd;
        this.appVersion = appVersion;
    }
    async runTurn(options) {
        const session = await this.getOrCreateSession(options);
        return session.adapter.runTurnOnThread(session.threadId, options);
    }
    async closeSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (!session)
            return;
        this.sessions.delete(sessionKey);
        await session.adapter.stop();
    }
    async closeAll() {
        const sessions = Array.from(this.sessions.entries());
        this.sessions.clear();
        await Promise.allSettled(sessions.map(([, session]) => session.adapter.stop()));
    }
    async getOrCreateSession(options) {
        const existing = this.sessions.get(options.sessionKey);
        if (existing)
            return existing;
        const adapter = new CodexHarnessAdapter(options.cwd || this.defaultCwd, this.appVersion);
        const threadOptions = {
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
//# sourceMappingURL=codex-harness-session-manager.js.map