const MAX_OPERATOR_COMMENTS = 5;
const PER_COMMENT_BODY_CHARS = 256;
const TOTAL_OPERATOR_COMMENT_CHARS = 1024;
const MAX_TIMELINE_ITEMS = 8;
const PER_TIMELINE_ITEM_CHARS = 320;
export function buildTaskContextSnapshot(task, timeline = []) {
    if (!task) {
        return undefined;
    }
    const recentComments = humanCommentsBudget(task.comments);
    return {
        taskId: task.id,
        identifier: task.identifier,
        shortIdentifier: task.shortIdentifier,
        status: task.status,
        title: task.title,
        goal: task.goal,
        description: task.description,
        latestSummary: truncateOptional(task.latestSummary, 600),
        lastAttempt: buildLastAttemptSnapshot(task),
        recentComments,
        timelineSummary: buildTimelineSummary(timeline),
        evidenceSummary: task.evidenceSummary,
    };
}
export function humanCommentsBudget(comments) {
    if (!comments || comments.length === 0) {
        return undefined;
    }
    const humanOnly = comments
        .filter((c) => c.authorKind === 'human')
        .slice(-MAX_OPERATOR_COMMENTS)
        .map((c) => ({
        authorKind: 'human',
        authorId: c.authorId,
        body: truncate(c.body, PER_COMMENT_BODY_CHARS),
        createdAt: c.createdAt,
    }));
    if (humanOnly.length === 0) {
        return undefined;
    }
    let totalChars = humanOnly.reduce((sum, c) => sum + c.body.length, 0);
    while (humanOnly.length > 1 && totalChars > TOTAL_OPERATOR_COMMENT_CHARS) {
        const dropped = humanOnly.shift();
        if (dropped) {
            totalChars -= dropped.body.length;
        }
    }
    return humanOnly;
}
function buildLastAttemptSnapshot(task) {
    const lastAttempt = [...(task.attempts || [])]
        .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
    if (!lastAttempt) {
        return undefined;
    }
    return {
        attemptNumber: lastAttempt.attemptNumber,
        startedAt: lastAttempt.startedAt,
        finishedAt: lastAttempt.finishedAt,
        outcome: lastAttempt.outcome,
        error: truncateOptional(lastAttempt.error, 600),
        kernelTaskId: lastAttempt.kernelTaskId,
        turnCount: lastAttempt.turnCount,
    };
}
function buildTimelineSummary(timeline) {
    const summary = [...timeline]
        .filter((item) => item.kind === 'summary' || item.kind === 'raw')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(-MAX_TIMELINE_ITEMS)
        .map((item) => {
        const timestamp = item.createdAt;
        const actor = item.actor;
        const kind = item.kind;
        return `[${timestamp}] ${actor}/${kind}: ${truncate(item.body, PER_TIMELINE_ITEM_CHARS)}`;
    });
    return summary.length > 0 ? summary : undefined;
}
function truncateOptional(value, maxChars) {
    return value ? truncate(value, maxChars) : undefined;
}
function truncate(value, maxChars) {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars - 1)}…`;
}
//# sourceMappingURL=task-context-snapshot.js.map