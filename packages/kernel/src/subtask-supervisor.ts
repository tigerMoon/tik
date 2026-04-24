import type {
  WorkflowSubtaskHandle,
  WorkflowSubtaskResult,
  WorkflowSubtaskSpec,
} from '@tik/shared';
import { WorkflowSubtaskRuntime } from './subtask-runtime.js';

export interface PreparedSubtaskExecutionRecord {
  taskId: string;
  projectName: string;
  projectPath: string;
  phase: WorkflowSubtaskSpec['phase'];
  contract: WorkflowSubtaskSpec['contract'];
  role: WorkflowSubtaskSpec['role'];
  skillName: WorkflowSubtaskSpec['skillName'];
  state: 'prepared' | 'running' | 'completed' | 'blocked' | 'failed';
  attempt: number;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PreparedWorkflowSubtasks {
  handles: WorkflowSubtaskHandle[];
  records: PreparedSubtaskExecutionRecord[];
}

export type SubtaskTransitionHandler = (record: PreparedSubtaskExecutionRecord) => void | Promise<void>;

export class WorkflowSubtaskSupervisor {
  constructor(private readonly runtime: WorkflowSubtaskRuntime) {}

  prepare(specs: WorkflowSubtaskSpec[]): PreparedWorkflowSubtasks {
    const handles = specs.map((spec) => this.runtime.create(spec));
    const records = handles.map<PreparedSubtaskExecutionRecord>((handle) => ({
      taskId: handle.taskId,
      projectName: handle.spec.projectName,
      projectPath: handle.spec.projectPath,
      phase: handle.spec.phase,
      contract: handle.spec.contract,
      role: handle.spec.role,
      skillName: handle.spec.skillName,
      state: 'prepared',
      attempt: 1,
    }));
    return { handles, records };
  }

  async executePrepared(
    prepared: PreparedWorkflowSubtasks,
    onTransition?: SubtaskTransitionHandler,
  ): Promise<WorkflowSubtaskResult[]> {
    const runOne = async (handle: WorkflowSubtaskHandle, index: number): Promise<WorkflowSubtaskResult> => {
      const preparedRecord = prepared.records[index]!;
      const runningRecord: PreparedSubtaskExecutionRecord = {
        ...preparedRecord,
        state: 'running',
        startedAt: new Date().toISOString(),
      };
      await onTransition?.(runningRecord);

      const result = await handle.execute();
      const completedRecord: PreparedSubtaskExecutionRecord = {
        ...runningRecord,
        state: this.mapResultState(result),
        summary: result.summary,
        completedAt: result.completedAt,
      };
      await onTransition?.(completedRecord);
      return result;
    };

    return Promise.all(prepared.handles.map((handle, index) => runOne(handle, index)));
  }

  async execute(
    specs: WorkflowSubtaskSpec[],
    onTransition?: SubtaskTransitionHandler,
  ): Promise<{ prepared: PreparedWorkflowSubtasks; results: WorkflowSubtaskResult[] }> {
    const prepared = this.prepare(specs);
    const results = await this.executePrepared(prepared, onTransition);
    return { prepared, results };
  }

  async cancelPrepared(prepared: PreparedWorkflowSubtasks): Promise<void> {
    await Promise.all(prepared.handles.map(async (handle) => {
      try {
        await handle.cancel?.();
      } catch {
        // best-effort cancellation
      }
    }));
  }

  private mapResultState(result: WorkflowSubtaskResult): PreparedSubtaskExecutionRecord['state'] {
    if (result.status === 'failed') return 'failed';
    if (result.status === 'cancelled' || result.status === 'paused') return 'blocked';
    return 'completed';
  }
}
