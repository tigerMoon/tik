export function buildArtifactPreviewApiUrl(apiBase, artifactId, versionId) {
    const base = normalizeApiBase(apiBase);
    return `${base}/api/workbench/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview`;
}
export function buildArtifactDetailUrl(apiBase, artifactId) {
    const base = normalizeApiBase(apiBase);
    return `${base}/artifacts/${encodeURIComponent(artifactId)}`;
}
export function formatArtifactList(artifacts) {
    if (artifacts.length === 0) {
        return 'No artifacts found.';
    }
    const rows = [
        'ID          STATUS        VER  KIND      TASK       TITLE',
        ...artifacts.map((artifact) => [
            truncate(artifact.id, 11).padEnd(11),
            artifact.status.padEnd(13),
            String(artifact.version).padEnd(4),
            artifact.kind.padEnd(9),
            truncate(artifact.taskId, 10).padEnd(10),
            artifact.title,
        ].join(' ')),
    ];
    return rows.join('\n');
}
export function formatArtifactShow(artifact, apiBase) {
    return [
        `Title: ${artifact.title}`,
        `Status: ${artifact.status}`,
        `Version: ${artifact.version}`,
        `Kind: ${artifact.kind}`,
        `Task: ${artifact.taskId}`,
        `Changed files: ${artifact.changedFiles?.length || 0}`,
        `Validation refs: ${artifact.validationRefs?.length || 0}`,
        `Risks: ${artifact.risks?.length || 0}`,
        `Preview: ${buildArtifactPreviewApiUrl(apiBase, artifact.id, artifact.latestVersionId)}`,
    ].join('\n');
}
export async function readArtifactResponse(response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload
            ? String(payload.error)
            : response.statusText;
        throw new Error(message || `Request failed: ${response.status}`);
    }
    return payload;
}
function normalizeApiBase(apiBase) {
    return apiBase.replace(/\/+$/, '');
}
function truncate(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return value.slice(0, Math.max(0, maxLength - 1)) + '…';
}
//# sourceMappingURL=artifacts-command.js.map