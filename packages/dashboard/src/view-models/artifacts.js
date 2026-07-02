export function buildArtifactGalleryViewModel(input) {
    const inactiveTaskIds = input.tasks
        .filter((task) => task.status === 'cancelled' || task.status === 'archived')
        .map((task) => task.id);
    const groupedArtifacts = groupWorkbenchArtifactsForReview(input.artifacts, { inactiveTaskIds });
    return {
        groupedArtifacts,
        rows: groupedArtifacts.filter((artifact) => input.filter === 'all' || artifact.status === input.filter),
        counts: countWorkbenchArtifactGroupsByStatus(groupedArtifacts),
    };
}
export function buildTaskArtifactRailModel(artifacts) {
    const ordered = [...artifacts].sort(compareArtifactsByUpdatedAtDesc);
    const latest = ordered[0] || null;
    const needsReviewCount = artifacts.filter((artifact) => artifact.status === 'needs_review').length;
    const acceptedCount = artifacts.filter((artifact) => artifact.status === 'accepted').length;
    const rejectedCount = artifacts.filter((artifact) => artifact.status === 'rejected').length;
    const statusParts = [
        needsReviewCount > 0 ? `${formatCount(needsReviewCount, 'need review', 'need review')}` : null,
        acceptedCount > 0 ? `${formatCount(acceptedCount, 'accepted', 'accepted')}` : null,
        rejectedCount > 0 ? `${formatCount(rejectedCount, 'rejected', 'rejected')}` : null,
    ].filter((part) => Boolean(part));
    return {
        totalCount: artifacts.length,
        needsReviewCount,
        acceptedCount,
        rejectedCount,
        latestArtifactId: latest?.id || null,
        latestTitle: latest?.title || 'No artifacts yet',
        latestMeta: latest ? `${latest.kind} · v${latest.version} · ${latest.status.replace(/_/g, ' ')}` : 'Generate review evidence from current task output.',
        primaryActionLabel: artifacts.length > 0 ? `Open ${formatCount(artifacts.length, 'artifact')}` : 'Open artifacts',
        statusSummary: statusParts.join(' · ') || 'No review artifacts yet',
    };
}
export function groupWorkbenchArtifactsForReview(artifacts, options = {}) {
    const groups = new Map();
    const inactiveTaskIds = new Set(options.inactiveTaskIds || []);
    for (const artifact of artifacts) {
        if (inactiveTaskIds.has(artifact.taskId)) {
            continue;
        }
        const key = buildArtifactLogicalKey(artifact);
        const group = groups.get(key);
        if (group) {
            group.push(artifact);
        }
        else {
            groups.set(key, [artifact]);
        }
    }
    return Array.from(groups.values())
        .map((group) => {
        const ordered = [...group].sort(compareArtifactsByUpdatedAtDesc);
        const latest = ordered[0];
        return {
            ...latest,
            groupedArtifactCount: ordered.length,
            groupedVersionCount: ordered.reduce((count, artifact) => count + Math.max(artifact.version || 1, 1), 0),
            groupedArtifactIds: ordered.map((artifact) => artifact.id),
        };
    })
        .sort(compareArtifactsByUpdatedAtDesc);
}
export function countWorkbenchArtifactGroupsByStatus(artifacts) {
    return {
        all: artifacts.length,
        needs_review: artifacts.filter((artifact) => artifact.status === 'needs_review').length,
        accepted: artifacts.filter((artifact) => artifact.status === 'accepted').length,
        rejected: artifacts.filter((artifact) => artifact.status === 'rejected').length,
    };
}
function buildArtifactLogicalKey(artifact) {
    return [
        artifact.taskId,
        artifact.kind,
        artifact.producedBy.template || artifact.producedBy.tool || artifact.producedBy.provider || 'manual',
        normalizeArtifactTitle(artifact.title),
    ].join('\u0000');
}
function normalizeArtifactTitle(title) {
    return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
function formatCount(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
function compareArtifactsByUpdatedAtDesc(left, right) {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdatedAt !== 0)
        return byUpdatedAt;
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    if (byCreatedAt !== 0)
        return byCreatedAt;
    return left.id.localeCompare(right.id);
}
//# sourceMappingURL=artifacts.js.map