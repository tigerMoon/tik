import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export const ARTIFACT_EXTENSION_CONTENT_TYPES = {
  html: 'text/html',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  json: 'application/json',
  txt: 'text/plain',
  diff: 'text/x-diff',
} as const;

export type ArtifactFileExtension = keyof typeof ARTIFACT_EXTENSION_CONTENT_TYPES;

const ALLOWED_EXTENSIONS = new Set<string>(Object.keys(ARTIFACT_EXTENSION_CONTENT_TYPES));

export function normalizeArtifactExtension(extension: string): ArtifactFileExtension {
  const normalized = extension.replace(/^\./, '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(normalized)) {
    throw new Error(`Unsupported artifact extension: ${extension}`);
  }
  return normalized as ArtifactFileExtension;
}

export function toArtifactContentBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

export function assertArtifactSize(content: Buffer, maxArtifactBytes: number): void {
  if (content.byteLength > maxArtifactBytes) {
    throw new Error(`Artifact exceeds maximum size: ${content.byteLength} bytes > ${maxArtifactBytes} bytes`);
  }
}

export function hashArtifactContent(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export async function resolveSafeArtifactPath(
  rootPath: string,
  safeRelativePath: string,
): Promise<string> {
  if (!safeRelativePath || path.isAbsolute(safeRelativePath)) {
    throw new Error('Artifact path must be relative.');
  }

  const normalized = safeRelativePath.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) {
    throw new Error('Artifact path must not include parent traversal.');
  }

  if (!normalized.startsWith('.tik/workbench/artifacts/')) {
    throw new Error('Artifact path must stay within the artifact store.');
  }

  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, safeRelativePath);
  if (!isWithin(root, resolved)) {
    throw new Error('Artifact path must stay within the project root.');
  }

  const realRoot = await fs.realpath(root);
  const parent = path.dirname(resolved);
  const nearestRealParent = await fs.realpath(parent).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return nearestExistingRealpath(root, parent);
  });

  if (!isWithin(realRoot, nearestRealParent)) {
    throw new Error('Artifact path must not escape the project root through symlinks.');
  }

  return resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingRealpath(root: string, targetDir: string): Promise<string> {
  let current = path.resolve(targetDir);

  while (isWithin(root, current)) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  throw new Error(`Artifact path must stay within the project root: ${targetDir}`);
}
