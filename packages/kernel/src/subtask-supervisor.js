export class WorkflowSubtaskSupervisor {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    prepare(specs) {
        const handles = specs.map((spec) => this.runtime.create(spec));
        const records = handles.map((handle) => ({
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
    async executePrepared(prepared, onTransition) {
        const runOne = async (handle, index) => {
            const preparedRecord = prepared.records[index];
            const runningRecord = {
                ...preparedRecord,
                state: 'running',
                startedAt: new Date().toISOString(),
            };
            await onTransition?.(runningRecord);
            const result = await handle.execute();
            const completedRecord = {
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
    async execute(specs, onTransition) {
        const prepared = this.prepare(specs);
        const results = await this.executePrepared(prepared, onTransition);
        return { prepared, results };
    }
    async cancelPrepared(prepared) {
        await Promise.all(prepared.handles.map(async (handle) => {
            try {
                await handle.cancel?.();
            }
            catch {
                // best-effort cancellation
            }
        }));
    }
    mapResultState(result) {
        if (result.status === 'failed')
            return 'failed';
        if (result.status === 'cancelled' || result.status === 'paused')
            return 'blocked';
        return 'completed';
    }
}
//# sourceMappingURL=subtask-supervisor.js.map