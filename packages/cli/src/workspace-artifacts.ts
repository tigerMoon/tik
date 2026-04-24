import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WorkspaceArtifactResolution {
  path: string | null;
  ambiguous: boolean;
  candidates: string[];
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace-spec';
}

export function buildWorkspaceFeatureName(
  projectName: string,
  demand: string,
): string {
  const projectSlug = slugifySegment(projectName);
  const demandSlug = slugifySegment(demand).split('-').filter(Boolean).slice(0, 6).join('-') || 'feature';
  return `${projectSlug}-${demandSlug}`.slice(0, 72);
}

export function buildWorkspaceFeatureDir(
  projectPath: string,
  projectName: string,
  demand: string,
): string {
  return path.join(projectPath, '.specify', 'specs', buildWorkspaceFeatureName(projectName, demand));
}

export function buildWorkspaceSpecTargetPath(
  projectPath: string,
  projectName: string,
  demand: string,
): string {
  return path.join(buildWorkspaceFeatureDir(projectPath, projectName, demand), 'spec.md');
}

export function buildWorkspacePlanTargetPath(
  projectPath: string,
  projectName: string,
  demand: string,
): string {
  return path.join(buildWorkspaceFeatureDir(projectPath, projectName, demand), 'plan.md');
}

async function accessFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listWorkspaceFeatureArtifactPaths(
  projectPath: string,
  artifactName: 'spec.md' | 'plan.md',
): Promise<string[]> {
  const specsRoot = path.join(projectPath, '.specify', 'specs');
  const candidates: string[] = [];

  const directPath = path.join(specsRoot, artifactName);
  if (await accessFile(directPath)) {
    candidates.push(directPath);
  }

  try {
    const entries = await fs.readdir(specsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nestedPath = path.join(specsRoot, entry.name, artifactName);
      if (await accessFile(nestedPath)) {
        candidates.push(nestedPath);
      }
    }
  } catch {
    // ignore missing specs root
  }

  return candidates.sort();
}

export function workspaceFeatureDirForArtifact(artifactPath: string | null): string | null {
  if (!artifactPath) return null;
  return path.dirname(artifactPath);
}

export async function resolveWorkspaceSpecArtifact(
  projectPath: string,
  preferredSpecPath?: string | null,
): Promise<WorkspaceArtifactResolution> {
  if (preferredSpecPath) {
    if (await accessFile(preferredSpecPath)) {
      return { path: preferredSpecPath, ambiguous: false, candidates: [preferredSpecPath] };
    }
    return { path: null, ambiguous: false, candidates: [] };
  }

  const candidates = await listWorkspaceFeatureArtifactPaths(projectPath, 'spec.md');
  if (candidates.length === 0) {
    return { path: null, ambiguous: false, candidates: [] };
  }
  if (candidates.length === 1) {
    return { path: candidates[0]!, ambiguous: false, candidates };
  }
  return { path: null, ambiguous: true, candidates };
}

export async function resolveWorkspacePlanArtifact(
  projectPath: string,
  options?: {
    preferredPlanPath?: string | null;
    preferredFeatureDir?: string | null;
  },
): Promise<WorkspaceArtifactResolution> {
  if (options?.preferredPlanPath) {
    if (await accessFile(options.preferredPlanPath)) {
      return { path: options.preferredPlanPath, ambiguous: false, candidates: [options.preferredPlanPath] };
    }
    return { path: null, ambiguous: false, candidates: [] };
  }

  if (options?.preferredFeatureDir) {
    const preferredPlanPath = path.join(options.preferredFeatureDir, 'plan.md');
    if (await accessFile(preferredPlanPath)) {
      return { path: preferredPlanPath, ambiguous: false, candidates: [preferredPlanPath] };
    }
    return { path: null, ambiguous: false, candidates: [] };
  }

  const candidates = await listWorkspaceFeatureArtifactPaths(projectPath, 'plan.md');
  if (candidates.length === 0) {
    return { path: null, ambiguous: false, candidates: [] };
  }
  if (candidates.length === 1) {
    return { path: candidates[0]!, ambiguous: false, candidates };
  }
  return { path: null, ambiguous: true, candidates };
}
