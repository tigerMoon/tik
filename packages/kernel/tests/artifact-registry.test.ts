import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactRegistry } from '../src/artifacts/artifact-registry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRegistry(): Promise<{ root: string; registry: FileArtifactRegistry }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-artifact-registry-'));
  tempDirs.push(root);
  return {
    root,
    registry: new FileArtifactRegistry({ rootPath: root }),
  };
}

describe('FileArtifactRegistry', () => {
  it('creates a task-bound artifact with version metadata and by-task index entries', async () => {
    const { root, registry } = await makeRegistry();

    const artifact = await registry.create({
      taskId: 'task-1',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      title: 'Task Review: artifact layer',
      kind: 'report',
      content: '<h1>Review</h1>',
      contentType: 'text/html',
      extension: 'html',
      sourceEventIds: ['evt-1'],
      sourceEvidenceIds: ['ev-1'],
      changedFiles: ['packages/kernel/src/artifacts/artifact-registry.ts'],
      validationRefs: ['pnpm --filter @tik/kernel test'],
      producedBy: { provider: 'codex', model: 'gpt-5.4', template: 'task-review' },
      summary: 'Review artifact',
      risks: ['No browser validation yet'],
      tags: ['review'],
    });

    expect(artifact).toMatchObject({
      taskId: 'task-1',
      title: 'Task Review: artifact layer',
      kind: 'report',
      status: 'needs_review',
      visibility: 'local',
      version: 1,
      contentType: 'text/html',
      sourceEventIds: ['evt-1'],
      sourceEvidenceIds: ['ev-1'],
      changedFiles: ['packages/kernel/src/artifacts/artifact-registry.ts'],
      validationRefs: ['pnpm --filter @tik/kernel test'],
      producedBy: { provider: 'codex', model: 'gpt-5.4', template: 'task-review' },
    });
    expect(artifact.id).toMatch(/^art_/);
    expect(artifact.latestVersionId).toMatch(/^ver_/);
    expect(artifact.safeRelativePath).toBe(`.tik/workbench/artifacts/${artifact.id}/versions/v1.html`);
    expect(artifact.contentHash).toMatch(/^sha256:/);
    expect(artifact.sizeBytes).toBe(Buffer.byteLength('<h1>Review</h1>'));

    const content = await fs.readFile(path.join(root, artifact.safeRelativePath), 'utf-8');
    expect(content).toBe('<h1>Review</h1>');

    const byTask = JSON.parse(await fs.readFile(path.join(root, '.tik/workbench/artifacts/by-task/task-1.json'), 'utf-8'));
    expect(byTask.artifactIds).toEqual([artifact.id]);
    expect((await registry.list({ taskId: 'task-1' })).map((item) => item.id)).toEqual([artifact.id]);
  });

  it('appends versions and preserves version history while superseding rejected state', async () => {
    const { registry } = await makeRegistry();
    const artifact = await registry.create({
      taskId: 'task-1',
      title: 'Investigation',
      kind: 'timeline',
      content: 'v1',
      contentType: 'text/plain',
      extension: 'txt',
    });

    await registry.reject(artifact.id, 'Needs stronger validation', 'reviewer');
    const updated = await registry.appendVersion({
      artifactId: artifact.id,
      content: 'v2',
      contentType: 'text/plain',
      extension: 'txt',
      sourceEventIds: ['evt-2'],
      sourceEvidenceIds: ['ev-2'],
      summary: 'Added validation notes',
    });

    expect(updated.version).toBe(2);
    expect(updated.status).toBe('needs_review');
    expect(updated.safeRelativePath).toBe(`.tik/workbench/artifacts/${artifact.id}/versions/v2.txt`);
    expect(updated.rejectionReason).toBeUndefined();
    expect(updated.sourceEventIds).toEqual(['evt-2']);

    const versions = await registry.listVersions(artifact.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]?.safeRelativePath).toContain('v1.txt');
    expect(versions[1]).toMatchObject({
      artifactId: artifact.id,
      version: 2,
      summary: 'Added validation notes',
    });
  });

  it('supports status transitions with audit fields', async () => {
    const { registry } = await makeRegistry();
    const artifact = await registry.create({
      taskId: 'task-1',
      title: 'Release checklist',
      kind: 'checklist',
      content: '- [ ] verify',
      contentType: 'text/markdown',
      extension: 'md',
    });

    const accepted = await registry.accept(artifact.id, 'reviewer');
    expect(accepted).toMatchObject({
      status: 'accepted',
      acceptedBy: 'reviewer',
    });
    expect(accepted.acceptedAt).toEqual(expect.any(String));

    const rejected = await registry.reject(artifact.id, 'Rollback plan missing', 'reviewer');
    expect(rejected).toMatchObject({
      status: 'rejected',
      rejectedBy: 'reviewer',
      rejectionReason: 'Rollback plan missing',
    });
    expect(rejected.rejectedAt).toEqual(expect.any(String));

    const archived = await registry.archive(artifact.id, 'reviewer');
    expect(archived.status).toBe('archived');
  });

  it('filters artifacts by status, kind, workspace, project, and tag', async () => {
    const { registry } = await makeRegistry();
    await registry.create({
      taskId: 'task-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      title: 'Needs review report',
      kind: 'report',
      content: 'report',
      contentType: 'text/plain',
      extension: 'txt',
      tags: ['review'],
    });
    const accepted = await registry.create({
      taskId: 'task-b',
      workspaceId: 'workspace-b',
      projectId: 'project-b',
      title: 'Accepted diff',
      kind: 'diff',
      content: 'diff',
      contentType: 'text/x-diff',
      extension: 'diff',
      tags: ['diff'],
    });
    await registry.accept(accepted.id, 'reviewer');

    expect((await registry.list({ status: 'needs_review' })).map((item) => item.title)).toEqual(['Needs review report']);
    expect((await registry.list({ kind: 'diff' })).map((item) => item.title)).toEqual(['Accepted diff']);
    expect((await registry.list({ workspaceId: 'workspace-b' })).map((item) => item.title)).toEqual(['Accepted diff']);
    expect((await registry.list({ projectId: 'project-a' })).map((item) => item.title)).toEqual(['Needs review report']);
    expect((await registry.list({ tag: 'review' })).map((item) => item.title)).toEqual(['Needs review report']);
  });

  it('rejects unsafe extensions and oversized artifacts', async () => {
    const { registry } = await makeRegistry();

    await expect(registry.create({
      taskId: 'task-1',
      title: 'Unsafe executable',
      kind: 'text',
      content: 'echo nope',
      contentType: 'text/plain',
      extension: 'sh' as 'txt',
    })).rejects.toThrow(/Unsupported artifact extension/);

    const tinyRegistry = new FileArtifactRegistry({
      rootPath: (await makeRegistry()).root,
      maxArtifactBytes: 2,
    });
    await expect(tinyRegistry.create({
      taskId: 'task-1',
      title: 'Too large',
      kind: 'text',
      content: 'abc',
      contentType: 'text/plain',
      extension: 'txt',
    })).rejects.toThrow(/Artifact exceeds maximum size/);
  });
});
