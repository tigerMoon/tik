import type { WorkbenchArtifactRecord } from '@tik/shared';

export function buildArtifactPreviewApiUrl(apiBase: string, artifactId: string, versionId: string): string {
  const base = normalizeApiBase(apiBase);
  return `${base}/api/workbench/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview`;
}

export function buildArtifactDetailUrl(apiBase: string, artifactId: string): string {
  const base = normalizeApiBase(apiBase);
  return `${base}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function formatArtifactList(artifacts: WorkbenchArtifactRecord[]): string {
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

export function formatArtifactShow(artifact: WorkbenchArtifactRecord, apiBase: string): string {
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

export async function readArtifactResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error)
      : response.statusText;
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return payload as T;
}

function normalizeApiBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, '');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, Math.max(0, maxLength - 1)) + '…';
}
