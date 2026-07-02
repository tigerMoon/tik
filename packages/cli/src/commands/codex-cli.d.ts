/**
 * Codex Provider
 *
 * Uses Codex App Server as Tik's provider-native execution backend. Tik owns
 * Task/Event/Session semantics; Codex supplies the native agent brain, tools,
 * thread/turn runtime, and login state.
 */
import type { ChatMessage, ChatResponse, ILLMProvider, LLMCallOptions, LLMPlanResponse, LLMToolDef } from '@tik/shared';
export declare function hasCodexCli(): boolean;
export declare function hasCodexLogin(): boolean;
interface MappedCodexCommandExecution {
    toolName: string;
    input: Record<string, unknown>;
    output: unknown;
}
export declare function buildDelegateImplementationContract(taskDescription: string, context: string | undefined, runtimeSystemMessages: string, writeToolsAvailable: boolean): string;
export declare function buildDelegateDocumentationContract(taskDescription: string, context: string | undefined, writeToolsAvailable: boolean): string;
export declare function shouldStopForPostPatchValidation(normalizedCommand: string, patchFirstRequired: boolean, hasWorkspaceChanges: boolean, validationAttemptsAfterPatch: number, exitCode: number | null): {
    stop: boolean;
    reason?: string;
};
export declare function shouldStopForPostPatchReadLoop(toolName: string, hasWorkspaceChanges: boolean, currentChangedFileCount: number, lastChangedFileCount: number, postPatchReadOnlySteps: number): {
    stop: boolean;
    reason?: string;
};
export declare function normalizeCodexShellCommand(command: string): string;
export declare function mapCodexCommandExecution(command: string, aggregatedOutput?: string): MappedCodexCommandExecution;
export declare class CodexCliProvider implements ILLMProvider {
    name: 'codex' | 'codex-delegate';
    private readonly projectPath;
    private readonly model?;
    private readonly mode;
    private readonly harnessSessionManager;
    constructor(projectPath: string, model?: string, mode?: 'governed' | 'delegate');
    plan(prompt: string, context: string, options?: LLMCallOptions): Promise<LLMPlanResponse>;
    complete(prompt: string, options?: LLMCallOptions): Promise<string>;
    chat(messages: ChatMessage[], tools?: LLMToolDef[]): Promise<ChatResponse>;
    chatWithContext(messages: ChatMessage[], systemPrompt: string, context: string, tools?: LLMToolDef[], options?: LLMCallOptions): Promise<ChatResponse>;
    private shouldAllowWrites;
    private buildPrompt;
    private isImplementationTask;
    private isDocumentationWorkflowTask;
    private runCodex;
    private buildHarnessSessionKey;
    private promptFingerprint;
    private spawnCodex;
    private requiresPatchFirst;
    private isValidationLikeCommand;
    private hasNewWorkspaceChanges;
    private captureChangedFilesSync;
    private captureChangedFiles;
    private readLastMessage;
    private toChatResponse;
    private parseJsonResponse;
    private parseCodexJsonLine;
    private extractUsage;
    private emitProviderRuntimeEvent;
}
export {};
//# sourceMappingURL=codex-cli.d.ts.map