export class WorkflowSkillExecutorRegistry {
    executors = new Map();
    register(contract, executor) {
        this.executors.set(contract, executor);
    }
    has(contract) {
        return this.executors.has(contract);
    }
    get(contract) {
        const executor = this.executors.get(contract);
        if (!executor) {
            throw new Error(`No workflow skill executor registered for contract: ${contract}`);
        }
        return executor;
    }
    async execute(contract, request) {
        return this.get(contract)(request);
    }
}
//# sourceMappingURL=workflow-skill-executor.js.map