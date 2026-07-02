import type { WorkspaceResolution, ConvergenceStrategy } from '@tik/shared';
import type { ExecutionKernel } from '@tik/kernel';
import type { ProviderOption } from './types.js';
export interface ShellConfig {
    projectPath: string;
    provider: ProviderOption;
    model?: string;
    mode: 'single' | 'multi';
    strategy: ConvergenceStrategy;
    maxIterations: number;
    resolution: WorkspaceResolution;
    resume?: string;
}
export interface ShellRuntime {
    kernel: ExecutionKernel;
    llmName: string;
    provider: ProviderOption;
}
export interface ShellContext {
    config: ShellConfig;
    createRuntime: (input: {
        projectPath: string;
        provider: ProviderOption;
        model?: string;
    }) => ShellRuntime;
}
export declare function runShell({ config, createRuntime }: ShellContext): Promise<void>;
//# sourceMappingURL=shell.d.ts.map