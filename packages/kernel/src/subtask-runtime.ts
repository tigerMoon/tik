import { now } from '@tik/shared';
import type {
  AgentEvent,
  ExecutionMode,
  Task,
  TaskStatus,
  WorkflowSubtaskHandle,
  WorkflowSubtaskResult,
  WorkflowSubtaskSpec,
} from '@tik/shared';
import type { ExecutionKernel } from './execution-kernel.js';

export interface SubtaskKernelInstance {
  kernel: ExecutionKernel;
  dispose?: () => void;
}

export type SubtaskKernelFactory = (projectPath: string) => SubtaskKernelInstance;
export interface SubtaskRuntimeEventContext {
  taskId: string;
  projectName: string;
  projectPath: string;
  phase: WorkflowSubtaskSpec['phase'];
  contract: WorkflowSubtaskSpec['contract'];
  role: WorkflowSubtaskSpec['role'];
  skillName: WorkflowSubtaskSpec['skillName'];
}
export type SubtaskRuntimeEventHandler = (
  event: AgentEvent,
  context: SubtaskRuntimeEventContext,
) => void | Promise<void>;

export class WorkflowSubtaskRuntime {
  constructor(
    private readonly kernelFactory: SubtaskKernelFactory,
    private readonly executionMode: ExecutionMode = 'single',
    private readonly onEvent?: SubtaskRuntimeEventHandler,
  ) {}

  create(spec: WorkflowSubtaskSpec): WorkflowSubtaskHandle {
    const instance = this.kernelFactory(spec.projectPath);
    const task = instance.kernel.taskManager.create({
      description: spec.description,
      projectPath: spec.projectPath,
      strategy: spec.strategy || 'incremental',
      maxIterations: spec.maxIterations || 1,
    });

    return {
      taskId: task.id,
      spec,
      execute: async () => this.executeHandle(task, spec, instance),
      cancel: async () => {
        try {
          instance.kernel.control(task.id, { type: 'stop' });
        } catch {
          // best-effort cancellation
        }
      },
    };
  }

  async executeBatch(specs: WorkflowSubtaskSpec[]): Promise<WorkflowSubtaskResult[]> {
    return Promise.all(specs.map((spec) => this.create(spec).execute()));
  }

  private async executeHandle(
    task: Task,
    spec: WorkflowSubtaskSpec,
    instance: SubtaskKernelInstance,
  ): Promise<WorkflowSubtaskResult> {
    const startedAt = new Date(now()).toISOString();
    const unsubscribe = instance.kernel.eventBus.onAny(async (event) => {
      if (event.taskId !== task.id) return;
      await this.onEvent?.(event, {
        taskId: task.id,
        projectName: spec.projectName,
        projectPath: spec.projectPath,
        phase: spec.phase,
        contract: spec.contract,
        role: spec.role,
        skillName: spec.skillName,
      });
    });
    try {
      const result = await instance.kernel.runTask(task, this.executionMode);
      return {
        taskId: task.id,
        projectName: spec.projectName,
        projectPath: spec.projectPath,
        phase: spec.phase,
        contract: spec.contract,
        role: spec.role,
        skillName: spec.skillName,
        status: this.normalizeStatus(spec, result.status, result.summary),
        summary: result.summary,
        startedAt,
        completedAt: new Date(now()).toISOString(),
        metadata: spec.metadata,
      };
    } finally {
      try {
        unsubscribe();
      } finally {
        try {
          instance.dispose?.();
        } finally {
          instance.kernel.dispose();
        }
      }
    }
  }

  private normalizeStatus(
    spec: WorkflowSubtaskSpec,
    status: WorkflowSubtaskResult['status'],
    summary?: string,
  ): TaskStatus {
    if (status === 'converged') return 'completed';
    if (
      status === 'failed'
      && (spec.contract === 'SPECIFY_SUBTASK' || spec.contract === 'PLAN_SUBTASK')
      && typeof summary === 'string'
      && /^Completed \d+ steps? in .+ mode/.test(summary)
    ) {
      return 'completed';
    }
    return status;
  }
}
