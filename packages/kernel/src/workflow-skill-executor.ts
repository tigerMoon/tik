import type { ProviderRuntimeEvent, WorkflowSubtaskContract, WorkflowSubtaskResult, WorkflowSubtaskSpec } from '@tik/shared';

export interface WorkflowSkillExecutionRequest {
  spec: WorkflowSubtaskSpec;
  subtask: WorkflowSubtaskResult;
  onProviderEvent?: (event: ProviderRuntimeEvent) => void;
}

export interface WorkflowSkillExecutionOutcome {
  summary: string;
  outputPath?: string;
  valid?: boolean;
  status?: 'completed' | 'blocked' | 'failed';
  metadata?: Record<string, unknown>;
  executionMode?: 'native';
}

export type WorkflowSkillExecutor = (
  request: WorkflowSkillExecutionRequest,
) => Promise<WorkflowSkillExecutionOutcome>;

export class WorkflowSkillExecutorRegistry {
  private readonly executors = new Map<WorkflowSubtaskContract, WorkflowSkillExecutor>();

  register(contract: WorkflowSubtaskContract, executor: WorkflowSkillExecutor): void {
    this.executors.set(contract, executor);
  }

  has(contract: WorkflowSubtaskContract): boolean {
    return this.executors.has(contract);
  }

  get(contract: WorkflowSubtaskContract): WorkflowSkillExecutor {
    const executor = this.executors.get(contract);
    if (!executor) {
      throw new Error(`No workflow skill executor registered for contract: ${contract}`);
    }
    return executor;
  }

  async execute(
    contract: WorkflowSubtaskContract,
    request: WorkflowSkillExecutionRequest,
  ): Promise<WorkflowSkillExecutionOutcome> {
    return this.get(contract)(request);
  }
}
