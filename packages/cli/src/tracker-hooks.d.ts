export interface TrackerHookInput {
    task: {
        id: string;
        shortIdentifier: string;
    };
    workspaceRoot: string;
    projectPath: string;
    envWhitelist?: string[];
}
export declare function runTrackerHook(name: string, input: TrackerHookInput): Promise<void>;
export declare function buildWhitelistedHookEnv(whitelist: string[], tikEnv: Record<string, string>): NodeJS.ProcessEnv;
export declare function redactHookError(error: unknown, env: NodeJS.ProcessEnv): Error;
//# sourceMappingURL=tracker-hooks.d.ts.map