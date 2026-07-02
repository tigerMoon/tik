/**
 * Local Context Provider
 *
 * File-based context provider that scans the real project structure.
 * Provides: project metadata, file tree, git history, spec files, run state.
 *
 * Note: Deep repo-aware analysis (code index, method scanner, PR lineage)
 * will be provided via MCP in Phase 3.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateId } from '@tik/shared';
const execFileAsync = promisify(execFile);
export class LocalContextProvider {
    name = 'local-context';
    async getFragments(projectPath, _taskId, iteration) {
        const fragments = [];
        const [specFrags, repoFrags, runFrags] = await Promise.all([
            this.readSpecFragments(projectPath),
            this.readRepoFragments(projectPath),
            iteration > 1 ? this.readRunFragments(projectPath) : Promise.resolve([]),
        ]);
        fragments.push(...specFrags, ...repoFrags, ...runFrags);
        return fragments;
    }
    // ─── Spec Context ─────────────────────────────────────────
    async readSpecFragments(projectPath) {
        const fragments = [];
        const specDir = path.join(projectPath, '.specify');
        try {
            const entries = await fs.readdir(specDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const featureDir = path.join(specDir, entry.name);
                for (const [file, tag, relevance] of [
                    ['spec.md', 'spec', 0.9],
                    ['plan.md', 'plan', 0.8],
                    ['tasks.md', 'tasks', 0.7],
                ]) {
                    try {
                        const content = await fs.readFile(path.join(featureDir, file), 'utf-8');
                        fragments.push(this.frag('spec', content, file, [tag], relevance, 1.0));
                    }
                    catch { }
                }
            }
        }
        catch { }
        return fragments;
    }
    // ─── Repo Context (real project scanning) ─────────────────
    async readRepoFragments(projectPath) {
        const fragments = [];
        // 1. Project metadata
        const meta = await this.readProjectMetadata(projectPath);
        if (meta)
            fragments.push(this.frag('repo', meta, 'project-metadata', ['metadata'], 0.8, 0.7));
        // 2. File tree (top 3 levels)
        const tree = await this.getFileTree(projectPath, 3);
        if (tree)
            fragments.push(this.frag('repo', tree, 'file-tree', ['structure'], 0.7, 0.6));
        // 3. Git recent commits
        const gitLog = await this.getGitLog(projectPath, 15);
        if (gitLog)
            fragments.push(this.frag('repo', gitLog, 'git-history', ['git'], 0.5, 0.5));
        // 4. Git current status
        const gitStatus = await this.getGitStatus(projectPath);
        if (gitStatus)
            fragments.push(this.frag('repo', gitStatus, 'git-status', ['git'], 0.6, 0.8));
        // 5. Existing repo-aware index if available (from MCP)
        try {
            const content = await fs.readFile(path.join(projectPath, '.repo-aware', 'code_index.json'), 'utf-8');
            fragments.push(this.frag('repo', content, 'code-index', ['code', 'index'], 0.6, 0.5));
        }
        catch { }
        return fragments;
    }
    async readProjectMetadata(projectPath) {
        for (const file of ['package.json', 'pom.xml', 'build.gradle', 'Cargo.toml', 'go.mod', 'pyproject.toml']) {
            try {
                const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
                return `# Project: ${file}\n${content}`;
            }
            catch { }
        }
        return null;
    }
    async getFileTree(projectPath, maxDepth) {
        try {
            const { stdout } = await execFileAsync('find', [
                projectPath, '-maxdepth', String(maxDepth),
                '-not', '-path', '*/node_modules/*',
                '-not', '-path', '*/.git/*',
                '-not', '-path', '*/dist/*',
                '-not', '-path', '*/build/*',
                '-not', '-path', '*/target/*',
                '-not', '-path', '*/.tik/*',
                '-not', '-path', '*/.ace/*',
            ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
            const lines = stdout.trim().split('\n')
                .map(l => l.replace(projectPath, '.'))
                .slice(0, 200);
            return `# File Tree\n${lines.join('\n')}`;
        }
        catch {
            return null;
        }
    }
    async getGitLog(projectPath, count) {
        try {
            const { stdout } = await execFileAsync('git', ['log', '--oneline', '-n', String(count)], { cwd: projectPath, timeout: 5_000 });
            return `# Recent Commits\n${stdout}`;
        }
        catch {
            return null;
        }
    }
    async getGitStatus(projectPath) {
        try {
            const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: projectPath, timeout: 5_000 });
            return stdout.trim() ? `# Git Status\n${stdout}` : null;
        }
        catch {
            return null;
        }
    }
    // ─── Run Context ──────────────────────────────────────────
    async readRunFragments(projectPath) {
        const fragments = [];
        try {
            const content = await fs.readFile(path.join(projectPath, '.ace', 'state.json'), 'utf-8');
            fragments.push(this.frag('run', content, 'run-state', ['run'], 0.9, 1.0));
        }
        catch { }
        try {
            const content = await fs.readFile(path.join(projectPath, '.ace', 'memory', 'failures.json'), 'utf-8');
            fragments.push(this.frag('run', content, 'failures', ['failures'], 0.8, 0.9));
        }
        catch { }
        return fragments;
    }
    // ─── Helper ───────────────────────────────────────────────
    frag(category, content, source, tags, relevance, importance) {
        return {
            id: generateId(), category, content,
            tokenCount: Math.ceil(content.length / 4),
            relevance, recency: 1.0, importance, priority: 0, source, tags,
        };
    }
}
//# sourceMappingURL=local-provider.js.map