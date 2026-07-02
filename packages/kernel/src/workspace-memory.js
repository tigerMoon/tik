import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class WorkspaceMemoryStore {
    rootPath;
    constructor(rootPath) {
        this.rootPath = rootPath;
    }
    async refresh(input) {
        const snapshot = this.buildSnapshot({
            rootPath: this.rootPath,
            ...input,
        });
        const memoryDir = this.getMemoryDir();
        const projectDir = path.join(memoryDir, 'projects');
        await fs.mkdir(projectDir, { recursive: true });
        await this.writeIfChanged(path.join(memoryDir, 'session.json'), JSON.stringify(snapshot.session, null, 2));
        const activeProjectFiles = new Set(snapshot.projects.map((project) => this.projectFileName(project.projectName)));
        const existingEntries = await fs.readdir(projectDir);
        await Promise.all(existingEntries
            .filter((entry) => entry.endsWith('.json') && !activeProjectFiles.has(entry))
            .map((entry) => fs.rm(path.join(projectDir, entry), { force: true })));
        await Promise.all(snapshot.projects.map(async (project) => {
            await this.writeIfChanged(path.join(projectDir, this.projectFileName(project.projectName)), JSON.stringify(project, null, 2));
        }));
        return snapshot;
    }
    async load() {
        const memoryDir = this.getMemoryDir();
        try {
            const [sessionContent, projectEntries] = await Promise.all([
                fs.readFile(path.join(memoryDir, 'session.json'), 'utf-8'),
                fs.readdir(path.join(memoryDir, 'projects')),
            ]);
            const projects = await Promise.all(projectEntries
                .filter((entry) => entry.endsWith('.json'))
                .sort()
                .map(async (entry) => JSON.parse(await fs.readFile(path.join(memoryDir, 'projects', entry), 'utf-8'))));
            return {
                session: JSON.parse(sessionContent),
                projects,
            };
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
    async loadOrBuild(input) {
        const existing = await this.load();
        if (existing)
            return existing;
        return this.refresh(input);
    }
    buildSnapshot(input) {
        const projects = (input.state?.projects || []).map((project) => {
            const projection = input.projection.projects.find((entry) => entry.projectName === project.projectName);
            const knownArtifacts = [project.specPath, project.planPath].filter((entry) => Boolean(entry));
            return {
                projectName: project.projectName,
                projectPath: project.projectPath,
                phase: project.phase,
                status: project.status,
                workflowRole: project.workflowRole,
                workflowContract: project.workflowContract,
                workflowSkillName: project.workflowSkillName,
                executionMode: project.executionMode,
                knownArtifacts,
                recentEvents: projection?.lastMessage ? [projection.lastMessage] : [],
                summary: project.summary,
                blockerKind: project.blockerKind,
                recommendedCommand: project.recommendedCommand,
                updatedAt: project.updatedAt,
            };
        });
        const currentPhase = input.state?.currentPhase;
        const nextAction = currentPhase === 'COMPLETED'
            ? 'tik workspace report'
            : input.state?.workspaceFeedback?.required
                ? `tik workspace feedback --message "<feedback>" --next-phase ${input.state.workspaceFeedback.nextPhase || 'PARALLEL_PLAN'}`
                : 'tik workspace next --provider codex';
        return {
            session: {
                workspaceName: input.settings?.workspaceName,
                rootPath: input.rootPath,
                demand: input.state?.demand || input.splitDemands?.demand,
                currentPhase,
                workflowProfile: input.settings?.workflowPolicy?.profile,
                completedProjects: projects.filter((project) => project.status === 'completed').map((project) => project.projectName),
                blockedProjects: projects.filter((project) => project.status === 'blocked').map((project) => project.projectName),
                failedProjects: projects.filter((project) => project.status === 'failed').map((project) => project.projectName),
                recentEvents: input.projection.recent.map((event) => `${event.projectName ? `${event.projectName} / ` : ''}${event.phase} ${event.kind}: ${event.message}`),
                nextAction,
                updatedAt: input.state?.updatedAt || input.settings?.updatedAt || new Date().toISOString(),
            },
            projects,
        };
    }
    getMemoryDir() {
        return path.join(this.rootPath, '.workspace', 'memory');
    }
    projectFileName(projectName) {
        return `${projectName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}.json`;
    }
    async writeIfChanged(filePath, content) {
        try {
            const existing = await fs.readFile(filePath, 'utf-8');
            if (existing === content)
                return;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        await fs.writeFile(filePath, content, 'utf-8');
    }
}
//# sourceMappingURL=workspace-memory.js.map