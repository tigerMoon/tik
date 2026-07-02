import type { AgentEvent, WorkspaceProjectWorktreeState, WorkflowSubtaskSpec } from '@tik/shared';
import { WorkspaceContextAssembler } from './workspace-context-assembler.js';
import { WorkspacePolicyEngine } from './workspace-policy-engine.js';
import { WorkspaceSuperpowersClarifier } from './workspace-superpowers-clarifier.js';
export interface WorkspaceEngineProjectItem {
    projectName: string;
    projectPath: string;
    demand: string;
    reason?: string;
}
export interface WorkspaceEngineSnapshot {
    settings?: {
        workflowPolicy?: {
            profile?: import('@tik/shared').WorkspaceWorkflowPolicyProfile;
        } | null;
    } | null;
    state?: {
        createdAt?: string;
        currentPhase?: string;
        workspaceFeedback?: {
            required?: boolean;
            affectedProjects?: string[];
            nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
        };
        projects?: any[];
    } | null;
    splitDemands?: {
        items?: WorkspaceEngineProjectItem[];
    } | null;
}
export interface WorkspacePhaseProjectResult {
    projectName: string;
    status: 'completed' | 'blocked';
    summary: string;
    outputPath?: string;
    taskId?: string;
    executionMode?: 'native' | 'fallback';
    reused?: boolean;
    reasonLabel?: string;
}
export interface WorkspacePhaseOutcome {
    nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
    requiresFeedback?: boolean;
    completed?: boolean;
    projectResults: WorkspacePhaseProjectResult[];
}
export interface WorkspaceEventMonitorPort {
    onEvent(event: AgentEvent, context: WorkspaceSubtaskEventContext): void;
    onSubtaskRunning(record: {
        projectName: string;
        taskId: string;
    }): void;
    onSubtaskFinished(record: {
        taskId: string;
    }): void;
}
export interface WorkspaceSubtaskEventContext {
    taskId: string;
    projectName: string;
    projectPath: string;
    phase: WorkflowSubtaskSpec['phase'];
    contract: WorkflowSubtaskSpec['contract'];
    role: WorkflowSubtaskSpec['role'];
    skillName: WorkflowSubtaskSpec['skillName'];
}
export interface WorkspacePhaseReporter {
    onKickoff(title: string): void;
    onRunning(record: {
        projectName: string;
        skillName?: string;
        taskId: string;
        state: 'running';
        summary?: string;
    }): void;
    onTerminal(record: {
        projectName: string;
        skillName?: string;
        taskId: string;
        state: 'completed' | 'blocked' | 'failed';
        summary?: string;
    }): void;
    onProjectResult(result: WorkspacePhaseProjectResult): void;
    onInfo(message: string): void;
}
export interface WorkspacePhaseExecutorServices {
    orchestrator: any;
    contextAssembler: WorkspaceContextAssembler;
    policyEngine: WorkspacePolicyEngine;
    clarifier?: WorkspaceSuperpowersClarifier;
    eventStore?: {
        record(event: {
            level: 'workspace' | 'project';
            kind: any;
            phase: any;
            projectName?: string;
            taskId?: string;
            message: string;
            metadata?: Record<string, unknown>;
        }): void;
        count?(filter?: {
            phase?: WorkflowSubtaskSpec['phase'];
            projectName?: string;
            kind?: any;
        }): number;
    };
    resolveWorkspaceSpecArtifact(projectPath: string, preferredPath: string): Promise<{
        path?: string;
        ambiguous?: boolean;
        candidates: string[];
    }>;
    resolveWorkspacePlanArtifact(projectPath: string, options: {
        preferredPlanPath: string;
        preferredFeatureDir?: string | null;
    }): Promise<{
        path?: string;
        ambiguous?: boolean;
        candidates: string[];
    }>;
    buildWorkspaceSpecTargetPath(projectPath: string, projectName: string, demand: string): string;
    buildWorkspacePlanTargetPath(projectPath: string, projectName: string, demand: string): string;
    buildWorkspaceFeatureDir(projectPath: string, projectName: string, demand: string): string;
    workspaceFeatureDirForArtifact(artifactPath?: string | null): string | null;
    skillRuntimeFactory(): any;
    materializeWorkflowSkillDelegatedSpec(spec: WorkflowSubtaskSpec, runtime: any): Promise<WorkflowSubtaskSpec>;
    createSubtaskRuntime(provider: string, model: string | undefined, executionMode: 'single' | 'multi', onEvent?: (event: AgentEvent, context: WorkspaceSubtaskEventContext) => void | Promise<void>): any;
    createEventMonitor(provider: string): WorkspaceEventMonitorPort;
    createEventForwarder(monitor: WorkspaceEventMonitorPort): (event: AgentEvent, context: WorkspaceSubtaskEventContext) => void | Promise<void>;
    ensureWorkspaceExecutionTarget(input: {
        workspaceName: string;
        workspaceRoot: string;
        projectName: string;
        sourceProjectPath: string;
        existingEffectiveProjectPath?: string;
        existingWorktree?: WorkspaceProjectWorktreeState;
        existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
    }): Promise<{
        sourceProjectPath: string;
        effectiveProjectPath: string;
        worktree?: WorkspaceProjectWorktreeState;
    }>;
    resolvePhaseProvider(provider: string, phase: 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'): string;
    resolveNativeRescueProvider(provider: string): string;
    runNativeWorkspaceArtifactRescue(spec: WorkflowSubtaskSpec, provider: string, model: string | undefined, summary: string): Promise<{
        summary: string;
        outputPath?: string;
        executionMode?: 'native';
    }>;
    safeReadFile(filePath: string): Promise<string>;
    artifactWasMaterializedDuringWorkspaceRun(artifactPath: string, createdAt?: string): Promise<boolean>;
    isWorkspacePlanValid(planPath: string): Promise<boolean>;
    killWorkspaceTaskProcesses(taskIds: string[]): Promise<void>;
    captureGitChangedFiles(projectPath: string): Promise<Set<string>>;
}
export declare class WorkspaceClarifyPhaseExecutor {
    private readonly services;
    constructor(services: WorkspacePhaseExecutorServices);
    run(args: {
        resolution: {
            workspace: {
                rootPath: string;
                workspaceFile: string;
            };
        };
        snapshot: WorkspaceEngineSnapshot;
        items: WorkspaceEngineProjectItem[];
        provider: string;
        model?: string;
        autoAdvance: boolean;
        reporter: WorkspacePhaseReporter;
    }): Promise<WorkspacePhaseOutcome>;
}
export declare class WorkspaceSpecifyPhaseExecutor {
    private readonly services;
    constructor(services: WorkspacePhaseExecutorServices);
    run(args: {
        resolution: {
            workspace: {
                rootPath: string;
                workspaceFile: string;
            };
        };
        snapshot: WorkspaceEngineSnapshot;
        items: WorkspaceEngineProjectItem[];
        provider: string;
        model?: string;
        autoAdvance: boolean;
        reporter: WorkspacePhaseReporter;
    }): Promise<WorkspacePhaseOutcome>;
}
export declare class WorkspacePlanPhaseExecutor {
    private readonly services;
    constructor(services: WorkspacePhaseExecutorServices);
    run(args: {
        resolution: {
            workspace: {
                rootPath: string;
                workspaceFile: string;
            };
        };
        snapshot: WorkspaceEngineSnapshot;
        items: WorkspaceEngineProjectItem[];
        provider: string;
        model?: string;
        autoAdvance: boolean;
        reporter: WorkspacePhaseReporter;
    }): Promise<WorkspacePhaseOutcome>;
}
export declare class WorkspaceAcePhaseExecutor {
    private readonly services;
    constructor(services: WorkspacePhaseExecutorServices);
    run(args: {
        resolution: {
            workspace: {
                rootPath: string;
                workspaceFile: string;
            };
        };
        snapshot: WorkspaceEngineSnapshot;
        items: WorkspaceEngineProjectItem[];
        provider: string;
        model?: string;
        autoAdvance: boolean;
        reporter: WorkspacePhaseReporter;
    }): Promise<WorkspacePhaseOutcome>;
}
//# sourceMappingURL=workspace-phase-executors.d.ts.map