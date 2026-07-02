/**
 * Event System Types
 *
 * All state changes in Tik are expressed through events.
 * Events are the single source of truth (SSOT) for system state.
 */
// ─── Event Types ─────────────────────────────────────────────
export var EventType;
(function (EventType) {
    // Task lifecycle
    EventType["TASK_CREATED"] = "task.created";
    EventType["TASK_STARTED"] = "task.started";
    EventType["TASK_COMPLETED"] = "task.completed";
    EventType["TASK_FAILED"] = "task.failed";
    EventType["TASK_CANCELLED"] = "task.cancelled";
    EventType["TASK_PAUSED"] = "task.paused";
    EventType["TASK_RESUMED"] = "task.resumed";
    // Planning
    EventType["PLAN_STARTED"] = "plan.started";
    EventType["PLAN_GENERATED"] = "plan.generated";
    EventType["PLAN_UPDATED"] = "plan.updated";
    // Tool execution
    EventType["EXECUTION_STARTED"] = "execution.started";
    EventType["TOOL_CALLED"] = "tool.called";
    EventType["TOOL_RESULT"] = "tool.result";
    EventType["TOOL_ERROR"] = "tool.error";
    // Context (SIGHT)
    EventType["CONTEXT_BUILT"] = "context.built";
    EventType["CONTEXT_UPDATED"] = "context.updated";
    EventType["MEMORY_RECORDED"] = "memory.recorded";
    // Evaluation (ACE)
    EventType["EVALUATION_STARTED"] = "evaluation.started";
    EventType["EVALUATED"] = "evaluation.completed";
    EventType["FITNESS_CALCULATED"] = "evaluation.fitness";
    EventType["DRIFT_DETECTED"] = "evaluation.drift";
    EventType["ENTROPY_CALCULATED"] = "evaluation.entropy";
    // Explanation
    EventType["EXPLANATION_CREATED"] = "explanation.created";
    // Convergence
    EventType["ITERATION_STARTED"] = "iteration.started";
    EventType["ITERATION_COMPLETED"] = "iteration.completed";
    EventType["CONVERGED"] = "convergence.achieved";
    EventType["DIVERGED"] = "convergence.failed";
    // Human-in-the-loop
    EventType["HUMAN_INTERVENTION"] = "human.intervention";
    EventType["CONTROL_RECEIVED"] = "human.control";
    EventType["CONSTRAINT_INJECTED"] = "human.constraint";
    EventType["STRATEGY_CHANGED"] = "human.strategy";
    // Session (Phase 2)
    EventType["SESSION_STARTED"] = "session.started";
    EventType["SESSION_MESSAGE"] = "session.message";
    EventType["SESSION_USAGE"] = "session.usage";
    EventType["AGENT_SWITCHED"] = "session.agent_switched";
    // System
    EventType["ERROR"] = "system.error";
    EventType["WARNING"] = "system.warning";
})(EventType || (EventType = {}));
//# sourceMappingURL=event.js.map