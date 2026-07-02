import { getWorkbenchLabelAction, } from './workbench-labels.js';
const CODEX_AGENT_LOOP_KINDS = new Set(['codex_implement', 'codex_fix']);
const CODEX_BLOCKING_LABEL_ACTIONS = new Set([
    'claude_code_review',
    'human_review',
    'loop_complete',
    'maintenance_manual',
]);
const CODEX_DISPATCH_LABEL_ACTIONS = new Set([
    'codex_dispatch',
    'codex_fix',
]);
const WORKFLOW_DISPATCH_LABEL_ACTIONS = new Set([
    'codex_dispatch',
    'codex_fix',
    'claude_code_review',
]);
const EXTERNAL_CLAUDE_REVIEW_LABEL = 'external-claude-review';
export function isWorkbenchTaskExternallyOwnedClaudeReview(task) {
    const labels = new Set((task.labels || []).map((label) => label.trim().toLowerCase()));
    return labels.has(EXTERNAL_CLAUDE_REVIEW_LABEL) && Boolean(task.agentLoop);
}
export function isWorkbenchTaskMaintenance(task) {
    if (task.agentLoop && CODEX_AGENT_LOOP_KINDS.has(task.agentLoop.kind)) {
        return false;
    }
    return (task.labels || []).some((label) => getWorkbenchLabelAction(task.environmentPackSnapshot, label) === 'maintenance_manual');
}
export function isWorkbenchTaskCodexDispatchable(task) {
    if (!isWorkbenchDispatchCandidateStatus(task.status)) {
        return false;
    }
    if (isWorkbenchTaskMaintenance(task)) {
        return false;
    }
    const labelActions = (task.labels || []).map((label) => getWorkbenchLabelAction(task.environmentPackSnapshot, label));
    if (labelActions.some((action) => CODEX_BLOCKING_LABEL_ACTIONS.has(action))) {
        return false;
    }
    if (!labelActions.some((action) => CODEX_DISPATCH_LABEL_ACTIONS.has(action))) {
        return false;
    }
    const phase = task.agentLoop?.phase;
    return task.agentLoop?.kind !== 'claude_review'
        && task.agentLoop?.kind !== 'human_review'
        && phase !== 'needs_claude_review'
        && phase !== 'claude_reviewing'
        && phase !== 'needs_human_review'
        && phase !== 'stale'
        && phase !== 'complete';
}
export function isWorkbenchTaskWorkflowDispatchable(task) {
    if (!isWorkbenchDispatchCandidateStatus(task.status)) {
        return false;
    }
    if (isWorkbenchTaskExternallyOwnedClaudeReview(task)) {
        return false;
    }
    if (isWorkbenchTaskMaintenance(task)) {
        return false;
    }
    const labelActions = (task.labels || []).map((label) => getWorkbenchLabelAction(task.environmentPackSnapshot, label));
    if (labelActions.some((action) => action === 'human_review' || action === 'loop_complete')) {
        return false;
    }
    return labelActions.some((action) => WORKFLOW_DISPATCH_LABEL_ACTIONS.has(action));
}
function isWorkbenchDispatchCandidateStatus(status) {
    return status === 'todo'
        || status === 'in_progress'
        || status === 'running'
        || status === 'retry'
        || status === 'failed';
}
//# sourceMappingURL=workbench-dispatch.js.map