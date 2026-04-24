import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkspaceFeatureDir,
  buildWorkspaceFeatureName,
  buildWorkspacePlanTargetPath,
  buildWorkspaceSpecTargetPath,
  resolveWorkspacePlanArtifact,
  resolveWorkspaceSpecArtifact,
  workspaceFeatureDirForArtifact,
} from '../src/workspace-artifacts.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

async function makeProject(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workspace-artifacts-'));
  tempDirs.push(projectPath);
  await fs.mkdir(path.join(projectPath, '.specify', 'specs'), { recursive: true });
  return projectPath;
}

describe('workspace artifact resolution', () => {
  it('builds deterministic workspace feature target paths', async () => {
    const projectPath = await makeProject();
    const featureName = buildWorkspaceFeatureName('require-category', '给 service-b 增加缓存并同步 service-a 契约');
    expect(featureName).toContain('require-category');
    const featureDir = buildWorkspaceFeatureDir(projectPath, 'require-category', '给 service-b 增加缓存并同步 service-a 契约');
    expect(featureDir).toBe(path.join(projectPath, '.specify', 'specs', featureName));
    expect(buildWorkspaceSpecTargetPath(projectPath, 'require-category', '给 service-b 增加缓存并同步 service-a 契约')).toBe(
      path.join(featureDir, 'spec.md'),
    );
    expect(buildWorkspacePlanTargetPath(projectPath, 'require-category', '给 service-b 增加缓存并同步 service-a 契约')).toBe(
      path.join(featureDir, 'plan.md'),
    );
  });

  it('resolves a single nested feature spec path', async () => {
    const projectPath = await makeProject();
    const specPath = path.join(projectPath, '.specify', 'specs', 'feat-001-cache', 'spec.md');
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, '# spec\n', 'utf-8');

    const resolved = await resolveWorkspaceSpecArtifact(projectPath);
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.path).toBe(specPath);
    expect(workspaceFeatureDirForArtifact(resolved.path)).toBe(path.dirname(specPath));
  });

  it('reports ambiguity when multiple feature specs exist without a pinned path', async () => {
    const projectPath = await makeProject();
    const first = path.join(projectPath, '.specify', 'specs', 'feat-001-cache', 'spec.md');
    const second = path.join(projectPath, '.specify', 'specs', 'feat-002-contract', 'spec.md');
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.mkdir(path.dirname(second), { recursive: true });
    await fs.writeFile(first, '# spec 1\n', 'utf-8');
    await fs.writeFile(second, '# spec 2\n', 'utf-8');

    const resolved = await resolveWorkspaceSpecArtifact(projectPath);
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.path).toBeNull();
    expect(resolved.candidates).toEqual([first, second].sort());
  });

  it('does not block a new specify target when multiple historical specs exist but the preferred path is missing', async () => {
    const projectPath = await makeProject();
    const first = path.join(projectPath, '.specify', 'specs', 'feat-001-cache', 'spec.md');
    const second = path.join(projectPath, '.specify', 'specs', 'feat-002-contract', 'spec.md');
    const preferred = path.join(projectPath, '.specify', 'specs', 'service-a-new-demand', 'spec.md');
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.mkdir(path.dirname(second), { recursive: true });
    await fs.writeFile(first, '# spec 1\n', 'utf-8');
    await fs.writeFile(second, '# spec 2\n', 'utf-8');

    const resolved = await resolveWorkspaceSpecArtifact(projectPath, preferred);
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.path).toBeNull();
    expect(resolved.candidates).toEqual([]);
  });

  it('uses the pinned spec path and its feature dir to resolve plan.md', async () => {
    const projectPath = await makeProject();
    const pinnedSpecPath = path.join(projectPath, '.specify', 'specs', 'feat-002-contract', 'spec.md');
    const pinnedPlanPath = path.join(projectPath, '.specify', 'specs', 'feat-002-contract', 'plan.md');
    const otherPlanPath = path.join(projectPath, '.specify', 'specs', 'feat-001-cache', 'plan.md');
    await fs.mkdir(path.dirname(pinnedSpecPath), { recursive: true });
    await fs.mkdir(path.dirname(otherPlanPath), { recursive: true });
    await fs.writeFile(pinnedSpecPath, '# spec\n', 'utf-8');
    await fs.writeFile(pinnedPlanPath, '# plan pinned\n', 'utf-8');
    await fs.writeFile(otherPlanPath, '# plan other\n', 'utf-8');

    const resolved = await resolveWorkspacePlanArtifact(projectPath, {
      preferredFeatureDir: workspaceFeatureDirForArtifact(pinnedSpecPath),
    });
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.path).toBe(pinnedPlanPath);
  });

  it('does not block a new plan target when the preferred feature dir is known but older plans exist elsewhere', async () => {
    const projectPath = await makeProject();
    const preferredFeatureDir = path.join(projectPath, '.specify', 'specs', 'service-a-new-demand');
    const otherPlanPath = path.join(projectPath, '.specify', 'specs', 'feat-001-cache', 'plan.md');
    await fs.mkdir(path.dirname(otherPlanPath), { recursive: true });
    await fs.writeFile(otherPlanPath, '# plan other\n', 'utf-8');

    const resolved = await resolveWorkspacePlanArtifact(projectPath, {
      preferredFeatureDir,
    });
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.path).toBeNull();
    expect(resolved.candidates).toEqual([]);
  });
});
