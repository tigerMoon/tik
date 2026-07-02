import { getWorkbenchLabelAction, getWorkbenchLabelDefinitions, } from '@tik/shared';
import { validateWorkbenchTaskLaunchDraftWithAttachments } from '../view-models/task-goal-attachments';
export const emptyLaunchValidation = {
    valid: true,
    titleError: null,
    goalError: null,
};
export function validateWorkbenchTaskLaunchDraft(input) {
    return validateWorkbenchTaskLaunchDraftWithAttachments(input);
}
export function shouldInitializeWorkbenchTaskLaunchDraft(input) {
    return input.launcherOpen && !input.wasLauncherOpen;
}
export function buildWorkbenchTaskLaunchInput(input) {
    if (input.status !== 'todo') {
        return {
            status: input.status,
            labels: input.labels,
        };
    }
    if (input.labels.some((label) => {
        const action = getWorkbenchLabelAction(input.selectedPack, label);
        return action === 'codex_dispatch' || action === 'codex_fix';
    })) {
        return {
            status: input.status,
            labels: input.labels,
        };
    }
    const defaultLabel = selectDefaultDispatchLabel(input.selectedPack, input.title);
    return {
        status: input.status,
        labels: defaultLabel ? [...input.labels, defaultLabel].sort() : input.labels,
    };
}
function selectDefaultDispatchLabel(environment, title) {
    const dispatchLabels = getWorkbenchLabelDefinitions(environment).filter((definition) => (definition.action === 'codex_dispatch' || definition.action === 'codex_fix'));
    if (dispatchLabels.length === 0)
        return null;
    const normalizedTitle = title.toLowerCase();
    if (/\b(readme|docs?|documentation|markdown|md)\b/.test(normalizedTitle)) {
        return dispatchLabels.find((definition) => definition.value === 'docs')?.value || dispatchLabels[0].value;
    }
    return dispatchLabels.find((definition) => definition.value === 'implementation')?.value
        || dispatchLabels[0].value;
}
//# sourceMappingURL=workbench-task-launch.js.map