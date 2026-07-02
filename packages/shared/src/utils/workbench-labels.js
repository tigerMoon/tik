export const WORKBENCH_LABEL_ACTIONS = [
    {
        action: 'codex_dispatch',
        label: 'Codex coding',
        description: 'Tracker can dispatch this task to the Codex execution lane.',
        tone: 'blue',
    },
    {
        action: 'codex_fix',
        label: 'Codex fix',
        description: 'Tracker can dispatch a fix pass for review blocking issues.',
        tone: 'blue',
    },
    {
        action: 'claude_code_review',
        label: 'Claude Code review',
        description: 'Claude Code plugin owns the review pass; Codex auto-dispatch is paused.',
        tone: 'yellow',
    },
    {
        action: 'human_review',
        label: 'Human review',
        description: 'A person owns the next decision; agents should wait for explicit progress.',
        tone: 'yellow',
    },
    {
        action: 'maintenance_manual',
        label: 'Manual maintenance',
        description: 'Workspace or operations work; it is hidden from Codex coding dispatch.',
        tone: 'neutral',
    },
    {
        action: 'loop_complete',
        label: 'Loop complete',
        description: 'Review loop is complete; no next automatic agent action is implied.',
        tone: 'green',
    },
    {
        action: 'metadata',
        label: 'Metadata only',
        description: 'Search and grouping label; it does not change agent routing.',
        tone: 'neutral',
    },
];
const ACTION_BY_VALUE = new Map(WORKBENCH_LABEL_ACTIONS.map((definition) => [definition.action, definition]));
export function normalizeWorkbenchLabel(label) {
    return label.trim().toLowerCase().replace(/[_\s]+/g, '-');
}
export function getWorkbenchLabelDefinitions(environment) {
    return (environment?.taskLabels || []).map((definition) => ({
        ...definition,
        value: normalizeWorkbenchLabel(definition.value),
        aliases: (definition.aliases || []).map(normalizeWorkbenchLabel),
    }));
}
export function getWorkbenchLabelDefinition(environment, label) {
    const normalized = normalizeWorkbenchLabel(label);
    return getWorkbenchLabelDefinitions(environment).find((definition) => (definition.value === normalized || (definition.aliases || []).includes(normalized))) || null;
}
export function getWorkbenchLabelActionDefinition(action) {
    return ACTION_BY_VALUE.get(action) || ACTION_BY_VALUE.get('metadata');
}
export function getWorkbenchLabelAction(environment, label) {
    return getWorkbenchLabelDefinition(environment, label)?.action || 'metadata';
}
export function getWorkbenchLabelActionTone(environment, label) {
    return getWorkbenchLabelActionDefinition(getWorkbenchLabelAction(environment, label)).tone;
}
//# sourceMappingURL=workbench-labels.js.map