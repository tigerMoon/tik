import { type CodexHarnessTurnOptions, type CodexHarnessTurnResult } from './codex-harness-adapter.js';
export interface CodexHarnessSessionRunOptions extends CodexHarnessTurnOptions {
    sessionKey: string;
}
export declare class CodexHarnessSessionManager {
    private readonly defaultCwd;
    private readonly appVersion;
    private readonly sessions;
    constructor(defaultCwd: string, appVersion?: string);
    runTurn(options: CodexHarnessSessionRunOptions): Promise<CodexHarnessTurnResult>;
    closeSession(sessionKey: string): Promise<void>;
    closeAll(): Promise<void>;
    private getOrCreateSession;
}
//# sourceMappingURL=codex-harness-session-manager.d.ts.map