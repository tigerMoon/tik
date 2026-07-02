/**
 * Workspace Resolver
 *
 * Discovers and parses VSCode .code-workspace files.
 * Manages .tik/ state directory alongside the workspace.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class WorkspaceResolver {
    /**
     * Resolve workspace from a starting directory.
     *
     * 1. Walk up from cwd looking for *.code-workspace
     * 2. If found: parse folders, resolve paths
     * 3. If --target: scope to that project
     * 4. If no workspace: single-project mode (cwd = project)
     */
    async resolve(cwd, target) {
        const normalizedCwd = await this.normalizePath(cwd);
        const wsFile = await this.findWorkspaceFile(normalizedCwd);
        if (!wsFile) {
            return {
                workspace: null,
                projectPath: normalizedCwd,
                isWorkspace: false,
            };
        }
        const workspace = await this.parseWorkspace(wsFile);
        // Ensure .tik/ exists
        await this.ensureTikDir(workspace);
        // Resolve active project
        const projectPath = this.resolveProject(workspace, normalizedCwd, target);
        return {
            workspace,
            projectPath,
            isWorkspace: true,
        };
    }
    /**
     * Walk up from cwd looking for *.code-workspace file.
     */
    async findWorkspaceFile(startDir) {
        let dir = await this.normalizePath(startDir);
        const root = path.parse(dir).root;
        while (dir !== root) {
            try {
                const entries = await fs.readdir(dir);
                const wsFile = entries.find(e => e.endsWith('.code-workspace'));
                if (wsFile) {
                    return path.join(dir, wsFile);
                }
            }
            catch {
                // directory not readable
            }
            dir = path.dirname(dir);
        }
        return null;
    }
    /**
     * Parse a .code-workspace file into a Workspace.
     */
    async parseWorkspace(wsFilePath) {
        const content = await fs.readFile(wsFilePath, 'utf-8');
        const raw = JSON.parse(content);
        const rootPath = await this.normalizePath(path.dirname(wsFilePath));
        const name = path.basename(wsFilePath, '.code-workspace');
        const projects = await Promise.all(raw.folders.map(async (folder) => {
            const absPath = path.isAbsolute(folder.path)
                ? folder.path
                : path.resolve(rootPath, folder.path);
            const normalizedPath = await this.normalizePath(absPath);
            return {
                name: folder.name || path.basename(absPath),
                path: normalizedPath,
            };
        }));
        // Load .tik/config.json if exists
        const config = await this.loadConfig(rootPath);
        return {
            name,
            rootPath,
            workspaceFile: wsFilePath,
            projects,
            config,
        };
    }
    /**
     * Resolve which project to use.
     * Priority: --target flag > cwd inside a project > first project
     */
    resolveProject(workspace, cwd, target) {
        // 1. Explicit --target
        if (target) {
            const project = workspace.projects.find(p => p.name === target || path.basename(p.path) === target);
            if (project)
                return project.path;
            throw new Error(`Project "${target}" not found in workspace. Available: ${workspace.projects.map(p => p.name).join(', ')}`);
        }
        // 2. cwd is inside a project folder
        for (const project of workspace.projects) {
            if (cwd.startsWith(project.path)) {
                return project.path;
            }
        }
        // 3. Default to first project
        if (workspace.projects.length > 0) {
            return workspace.projects[0].path;
        }
        return cwd;
    }
    /**
     * Ensure .tik/ directory structure exists.
     */
    async ensureTikDir(workspace) {
        const tikDir = path.join(workspace.rootPath, '.tik');
        await fs.mkdir(path.join(tikDir, 'tasks'), { recursive: true });
        for (const project of workspace.projects) {
            const projectDir = path.join(tikDir, 'projects', project.name);
            await fs.mkdir(path.join(projectDir, 'memory'), { recursive: true });
            await fs.mkdir(path.join(projectDir, 'runs'), { recursive: true });
        }
    }
    /**
     * Load workspace config from .tik/config.json.
     */
    async loadConfig(rootPath) {
        try {
            const configPath = path.join(rootPath, '.tik', 'config.json');
            const content = await fs.readFile(configPath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return {};
        }
    }
    /**
     * Save workspace config to .tik/config.json.
     */
    async saveConfig(rootPath, config) {
        const tikDir = path.join(rootPath, '.tik');
        await fs.mkdir(tikDir, { recursive: true });
        await fs.writeFile(path.join(tikDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    }
    async normalizePath(inputPath) {
        const resolved = path.resolve(inputPath);
        try {
            return await fs.realpath(resolved);
        }
        catch {
            return resolved;
        }
    }
}
//# sourceMappingURL=workspace.js.map