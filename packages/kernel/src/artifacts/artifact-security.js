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
};
const ALLOWED_EXTENSIONS = new Set(Object.keys(ARTIFACT_EXTENSION_CONTENT_TYPES));
export function normalizeArtifactExtension(extension) {
    const normalized = extension.replace(/^\./, '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(normalized)) {
        throw new Error(`Unsupported artifact extension: ${extension}`);
    }
    return normalized;
}
export function toArtifactContentBuffer(content) {
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
}
export function assertArtifactSize(content, maxArtifactBytes) {
    if (content.byteLength > maxArtifactBytes) {
        throw new Error(`Artifact exceeds maximum size: ${content.byteLength} bytes > ${maxArtifactBytes} bytes`);
    }
}
export function hashArtifactContent(content) {
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
export async function resolveSafeArtifactPath(rootPath, safeRelativePath) {
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
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return nearestExistingRealpath(root, parent);
    });
    if (!isWithin(realRoot, nearestRealParent)) {
        throw new Error('Artifact path must not escape the project root through symlinks.');
    }
    return resolved;
}
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function nearestExistingRealpath(root, targetDir) {
    let current = path.resolve(targetDir);
    while (isWithin(root, current)) {
        try {
            return await fs.realpath(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
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
//# sourceMappingURL=artifact-security.js.map