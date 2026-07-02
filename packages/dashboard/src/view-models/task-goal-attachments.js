export function validateWorkbenchTaskLaunchDraftWithAttachments(input) {
    const titleError = input.title.trim() ? null : 'Task title is required.';
    const goalError = input.goal.trim() || (input.attachmentCount || 0) > 0
        ? null
        : 'Task goal is required.';
    return {
        valid: !titleError && !goalError,
        titleError,
        goalError,
    };
}
export function buildWorkbenchTaskGoalImageMarkdown(input) {
    return `![${sanitizeMarkdownAltText(input.name) || 'pasted image'}](${input.dataUrl})`;
}
export function buildWorkbenchTaskGoalMarkdownFileSection(input) {
    const filename = input.name.trim() || 'pasted markdown';
    return [`### ${filename}`, '', input.text.trim()].join('\n');
}
export function appendWorkbenchTaskGoalAttachments(goal, attachments) {
    const attachmentMarkdown = attachments
        .map((attachment) => attachment.markdown.trim())
        .filter(Boolean)
        .join('\n\n');
    if (!attachmentMarkdown) {
        return goal.trim();
    }
    return [
        goal.trim(),
        '### Attached context',
        attachmentMarkdown,
    ]
        .filter(Boolean)
        .join('\n\n');
}
export function isSupportedWorkbenchTaskGoalFile(file) {
    return isWorkbenchTaskGoalImage(file) || isWorkbenchTaskGoalMarkdown(file);
}
export function isWorkbenchTaskGoalImage(file) {
    return /^image\//i.test(file.type);
}
export function isWorkbenchTaskGoalMarkdown(file) {
    return /^text\/markdown\b/i.test(file.type)
        || /\bmarkdown\b/i.test(file.type)
        || /\.md(?:own|arkdown)?$/i.test(file.name);
}
function sanitizeMarkdownAltText(value) {
    return value.replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
//# sourceMappingURL=task-goal-attachments.js.map