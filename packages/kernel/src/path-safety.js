import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export async function safeResolveWorkspacePath(root, requestedPath, options = {}) {
    if (!requestedPath || !requestedPath.trim()) {
        throw new Error('Path is required.');
    }
    if (path.isAbsolute(requestedPath)) {
        throw new Error(`Absolute paths are not allowed: ${requestedPath}`);
    }
    const workspaceRoot = path.resolve(root);
    const realRoot = await fs.realpath(workspaceRoot);
    const normalized = requestedPath.replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) {
        throw new Error(`Refusing parent traversal outside the workspace: ${requestedPath}`);
    }
    const resolved = path.resolve(workspaceRoot, requestedPath);
    if (!isWithin(workspaceRoot, resolved)) {
        throw new Error(`Refusing path outside the workspace: ${requestedPath}`);
    }
    const realTarget = await fs.realpath(resolved).catch((error) => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return null;
    });
    if (realTarget) {
        if (!isWithin(realRoot, realTarget)) {
            throw new Error(`Refusing symlink escape outside the workspace: ${requestedPath}`);
        }
        const stat = await fs.stat(realTarget);
        if (stat.isDirectory() && !options.allowDirectory) {
            throw new Error(`Directory paths are not allowed for this tool path: ${requestedPath}`);
        }
        return realTarget;
    }
    const nearestExisting = await nearestExistingPath(workspaceRoot, path.dirname(resolved));
    if (!isWithin(realRoot, nearestExisting.realPath)) {
        throw new Error(`Refusing symlink escape outside the workspace: ${requestedPath}`);
    }
    const missingSuffix = path.relative(nearestExisting.path, resolved);
    if (missingSuffix.startsWith('..') || path.isAbsolute(missingSuffix)) {
        throw new Error(`Refusing path outside the workspace: ${requestedPath}`);
    }
    return resolved;
}
export async function safeResolve(contextCwd, requestedPath, options = {}) {
    if (!options.allowAbsolute || !path.isAbsolute(requestedPath)) {
        return safeResolveWorkspacePath(contextCwd, requestedPath, {
            allowDirectory: options.allowDirectory,
        });
    }
    const workspaceRoot = path.resolve(contextCwd);
    const relativePath = path.relative(workspaceRoot, path.resolve(requestedPath)) || '.';
    return safeResolveWorkspacePath(contextCwd, relativePath, {
        allowDirectory: options.allowDirectory,
    });
}
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function nearestExistingPath(root, targetDir) {
    let current = path.resolve(targetDir);
    const resolvedRoot = path.resolve(root);
    while (isWithin(resolvedRoot, current)) {
        try {
            return {
                path: current,
                realPath: await fs.realpath(current),
            };
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            const parent = path.dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    throw new Error(`Refusing path outside the workspace: ${targetDir}`);
}
//# sourceMappingURL=path-safety.js.map