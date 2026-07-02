import { now } from '@tik/shared';
export class WorkflowSubtaskRuntime {
    kernelFactory;
    executionMode;
    onEvent;
    constructor(kernelFactory, executionMode = 'single', onEvent) {
        this.kernelFactory = kernelFactory;
        this.executionMode = executionMode;
        this.onEvent = onEvent;
    }
    create(spec) {
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
                }
                catch {
                    // best-effort cancellation
                }
            },
        };
    }
    async executeBatch(specs) {
        return Promise.all(specs.map((spec) => this.create(spec).execute()));
    }
    async executeHandle(task, spec, instance) {
        const startedAt = new Date(now()).toISOString();
        const unsubscribe = instance.kernel.eventBus.onAny(async (event) => {
            if (event.taskId !== task.id)
                return;
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
        }
        finally {
            try {
                unsubscribe();
            }
            finally {
                try {
                    instance.dispose?.();
                }
                finally {
                    instance.kernel.dispose();
                }
            }
        }
    }
    normalizeStatus(spec, status, summary) {
        if (status === 'converged')
            return 'completed';
        if (status === 'failed'
            && (spec.contract === 'SPECIFY_SUBTASK' || spec.contract === 'PLAN_SUBTASK')
            && typeof summary === 'string'
            && /^Completed \d+ steps? in .+ mode/.test(summary)) {
            return 'completed';
        }
        return status;
    }
}
//# sourceMappingURL=subtask-runtime.js.map