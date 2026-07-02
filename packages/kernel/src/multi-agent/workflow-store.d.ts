import { type AgentInvocationRecord, type CodexEvaluationResult, type CreateMultiAgentWorkflowInput, type EvaluationRun, type GuardResult, type HumanOverrideRecord, type MultiAgentInvocationStatus, type MultiAgentWorkflowBundle, type MultiAgentWorkflowEvent, type MultiAgentWorkflowEvidence, type MultiAgentWorkflowRecord, type QuestionerOutput, type SprintContract, type SubtaskRunState, type TaskGraph, type WorkflowContextSnapshot, type WorkflowDecision, type WorkflowPolicy } from '@tik/shared';
export declare const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy;
export declare class MultiAgentCoordinationError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
interface CreateAgentInvocationInput {
    id?: string;
    workflowId?: string;
    subtaskId?: string;
    role: AgentInvocationRecord['role'];
    runner: AgentInvocationRecord['runner'];
    promptContract: string;
    input?: Record<string, unknown>;
    allowedPaths?: string[];
    validationCommands?: string[];
    threadId?: string;
    actualSubagentThreadId?: string;
    parentThreadId?: string;
    headSha?: string;
    evidenceRefs?: string[];
    evaluationRunId?: string;
    readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
}
interface HookStartInvocationInput {
    attestationToken: string;
    parentThreadId: string;
    actualSubagentThreadId: string;
    role: AgentInvocationRecord['role'];
    startedAt?: string;
}
interface HookStopInvocationInput {
    attestationToken: string;
    stoppedAt?: string;
    headSha?: string;
    evidenceRefs?: string[];
    evaluationRunId?: string;
    readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
    result?: Record<string, unknown>;
    status?: Extract<MultiAgentInvocationStatus, 'completed' | 'failed' | 'cancelled'>;
    error?: string;
}
export declare class FileMultiAgentWorkflowStore {
    private readonly rootPath;
    constructor(rootPath: string);
    createWorkflow(input: CreateMultiAgentWorkflowInput): Promise<MultiAgentWorkflowRecord>;
    readWorkflow(workflowId: string): Promise<MultiAgentWorkflowRecord | null>;
    updateWorkflow(workflowId: string, patch: Partial<Pick<MultiAgentWorkflowRecord, 'status' | 'currentHeadSha' | 'metadata' | 'pauseReason'>> & {
        policy?: Partial<WorkflowPolicy>;
    }): Promise<MultiAgentWorkflowRecord>;
    readBundle(workflowId: string): Promise<MultiAgentWorkflowBundle | null>;
    putTaskGraph(workflowId: string, graph: TaskGraph): Promise<{
        graph: TaskGraph;
        subtasks: Record<string, SubtaskRunState>;
    }>;
    updateSubtask(workflowId: string, subtaskId: string, patch: Partial<SubtaskRunState>): Promise<SubtaskRunState>;
    recordDecision(workflowId: string, decision: WorkflowDecision): Promise<WorkflowDecision>;
    recordDecisionIfMatch(workflowId: string, decision: WorkflowDecision, expectedLastDecisionId?: string): Promise<{
        decision?: WorkflowDecision;
        workflow: MultiAgentWorkflowRecord;
        guard: GuardResult;
    }>;
    recordEvidence(workflowId: string, input: Omit<Partial<MultiAgentWorkflowEvidence>, 'workflowId' | 'createdAt'> & {
        kind: MultiAgentWorkflowEvidence['kind'];
        title: string;
    }): Promise<MultiAgentWorkflowEvidence>;
    createContract(workflowId: string, subtaskId: string, input: Omit<Partial<SprintContract>, 'workflowId' | 'subtaskId'> & {
        goal: string;
        scope: SprintContract['scope'];
        deliverables: SprintContract['deliverables'];
        acceptanceCriteria: SprintContract['acceptanceCriteria'];
        verificationPlan: SprintContract['verificationPlan'];
        headShaAtAcceptance?: string;
    }): Promise<SprintContract>;
    acceptContract(workflowId: string, subtaskId: string, contractId: string, input?: {
        acceptedBy?: SprintContract['acceptedBy'];
        headShaAtAcceptance?: string;
        questionerOutputRefs?: string[];
    }): Promise<SprintContract>;
    staleContract(workflowId: string, subtaskId: string, contractId: string): Promise<SprintContract>;
    readLatestContract(workflowId: string, subtaskId: string): Promise<SprintContract | null>;
    createEvaluationRun(workflowId: string, subtaskId: string, input: Omit<Partial<EvaluationRun>, 'workflowId' | 'subtaskId' | 'startedAt'> & {
        contractId: string;
        headSha: string;
        evaluator?: EvaluationRun['evaluator'];
    }): Promise<EvaluationRun>;
    updateEvaluationRun(workflowId: string, subtaskId: string, evaluationRunId: string, patch: Omit<Partial<EvaluationRun>, 'readonlyPolicy'> & {
        readonlyPolicy?: Partial<EvaluationRun['readonlyPolicy']>;
    }): Promise<EvaluationRun>;
    recordEvaluationResult(workflowId: string, subtaskId: string, evaluationRunId: string, result: CodexEvaluationResult): Promise<EvaluationRun>;
    private normalizeEvaluationResultEvidence;
    validateEvaluationReadonly(workflowId: string, subtaskId: string, evaluationRunId: string, input: {
        gitStatusBefore?: string;
        gitStatusAfter?: string;
        allowedWritePaths?: string[];
        forbiddenWritePaths?: string[];
    }): Promise<{
        evaluationRun: EvaluationRun;
        guard: GuardResult;
    }>;
    readLatestEvaluationRun(workflowId: string, subtaskId: string): Promise<EvaluationRun | null>;
    recordQuestionerOutput(workflowId: string, input: Omit<Partial<QuestionerOutput>, 'workflowId' | 'createdAt'> & {
        intent: QuestionerOutput['intent'];
        actor: QuestionerOutput['actor'];
        source: QuestionerOutput['source'];
        headSha: string;
        evaluationRunId?: string;
        finalEvaluationRunId?: string;
        contractId?: string;
        artifactRef?: string;
        verdict: QuestionerOutput['verdict'];
        questions?: QuestionerOutput['questions'];
        risks?: QuestionerOutput['risks'];
        missingTests?: QuestionerOutput['missingTests'];
        suggestedContractChanges?: QuestionerOutput['suggestedContractChanges'];
    }): Promise<QuestionerOutput>;
    readLatestQuestionerOutput(workflowId: string, input: {
        subtaskId?: string;
        intent?: QuestionerOutput['intent'];
    }): Promise<QuestionerOutput | null>;
    createInvocation(workflowId: string, input: CreateAgentInvocationInput): Promise<AgentInvocationRecord>;
    saveContextSnapshot(workflowId: string, snapshot: Omit<Partial<WorkflowContextSnapshot>, 'workflowId'> & {
        workflowId?: string;
        headSha: string;
        target: WorkflowContextSnapshot['target'];
        objectiveSummary: string;
        completedSubtasks?: string[];
        unresolvedBlockers?: string[];
        artifactRefs?: string[];
        maxChars?: number;
    }, expectedEtag?: string): Promise<{
        snapshot: WorkflowContextSnapshot;
        guard: GuardResult;
    }>;
    readContextSnapshot(workflowId: string, target: WorkflowContextSnapshot['target']): Promise<WorkflowContextSnapshot | null>;
    reconcileStalledInvocations(workflowId: string, input?: {
        now?: string;
    }): Promise<{
        workflow: MultiAgentWorkflowRecord;
        subtasks: Record<string, SubtaskRunState>;
        stalled: AgentInvocationRecord[];
    }>;
    recordHumanOverride(workflowId: string, input: {
        reason: string;
        approver: string;
        unblockAction: HumanOverrideRecord['unblockAction'];
        subtaskId?: string;
        note?: string;
    }): Promise<{
        workflow: MultiAgentWorkflowRecord;
        override: HumanOverrideRecord;
    }>;
    readInvocation(workflowId: string, invocationId: string): Promise<AgentInvocationRecord | null>;
    updateInvocation(workflowId: string, invocationId: string, patch: {
        status: MultiAgentInvocationStatus;
        result?: Record<string, unknown>;
        error?: string;
        threadId?: string;
        actualSubagentThreadId?: string;
        parentThreadId?: string;
        headSha?: string;
        evidenceRefs?: string[];
        evaluationRunId?: string;
        readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
    }): Promise<AgentInvocationRecord>;
    attestInvocationStart(workflowId: string, invocationId: string, input: HookStartInvocationInput): Promise<AgentInvocationRecord>;
    attestInvocationStop(workflowId: string, invocationId: string, input: HookStopInvocationInput): Promise<AgentInvocationRecord>;
    readTimeline(workflowId: string): Promise<MultiAgentWorkflowEvent[]>;
    private requireWorkflow;
    private readTaskGraphForWorkflow;
    private readSubtasks;
    private requireSubtask;
    private readEvidence;
    private nextContractVersion;
    private requireContract;
    private readContracts;
    private requireEvaluationRun;
    private readEvaluationRuns;
    private readQuestionerOutputs;
    private upsertInvocation;
    private writeWorkflow;
    private appendEvent;
    private normalizeId;
    private rootDir;
    private workflowDir;
    private workflowFile;
    private taskGraphFile;
    private subtasksFile;
    private decisionsFile;
    private invocationsFile;
    private eventsFile;
    private evidenceDir;
    private evidenceFile;
    private contractsRootDir;
    private contractsDir;
    private contractFile;
    private evaluationsRootDir;
    private evaluationsDir;
    private evaluationRunFile;
    private questionerOutputsDir;
    private questionerOutputFile;
    private contextDir;
    private contextSnapshotFile;
    private localContextSnapshotMarkdownFile;
    private writeLocalContextSnapshotMarkdown;
    private humanOverridesDir;
    private humanOverrideFile;
    private readJsonFile;
    private readJsonLines;
    private writeJsonFileAtomic;
}
export {};
//# sourceMappingURL=workflow-store.d.ts.map