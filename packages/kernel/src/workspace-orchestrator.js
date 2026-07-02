import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildWorkspaceEventProjection } from './workspace-event-projection.js';
import { WorkspaceEventStore } from './workspace-event-store.js';
import { WorkspaceMemoryStore } from './workspace-memory.js';
import { getWorkflowSkillRouteByPhase } from './workflow-skill-routes.js';
import { synthesizeWorkspaceDecision } from './workspace-decision-synthesizer.js';
import { resolveWorkspaceWorkflowPolicy } from './workspace-policy-engine.js';
export class WorkspaceOrchestrator {
    mutationQueues = new Map();
    lockTimeoutMs = 15_000;
    staleLockMs = 120_000;
    async bootstrap(input) {
        const { resolution, demand, workflowPolicy } = input;
        if (!resolution.workspace) {
            throw new Error('Workspace orchestration requires a .code-workspace root.');
        }
        const workspaceDir = this.getWorkspaceDir(resolution.workspace.rootPath);
        await fs.mkdir(workspaceDir, { recursive: true });
        return this.withWorkspaceMutation(resolution.workspace.rootPath, async () => {
            const settings = this.buildSettings(resolution.workspace, workflowPolicy);
            const splitDemands = this.buildSplitDemands(resolution, demand);
            const state = this.buildState(demand, splitDemands.items);
            await this.writeJson(path.join(workspaceDir, 'settings.json'), settings);
            await this.writeJson(path.join(workspaceDir, 'split-demands.json'), splitDemands);
            await this.writeJson(path.join(workspaceDir, 'state.json'), state);
            return { settings, state, splitDemands };
        });
    }
    async getStatus(rootPath) {
        const workspaceDir = this.getWorkspaceDir(rootPath);
        const [settings, state, splitDemands] = await Promise.all([
            this.readJson(path.join(workspaceDir, 'settings.json')),
            this.readJson(path.join(workspaceDir, 'state.json')),
            this.readJson(path.join(workspaceDir, 'split-demands.json')),
        ]);
        return { settings, state, splitDemands };
    }
    async markSpecifyResult(rootPath, projectName, specPath, summary, specTaskId, executionMode) {
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase: 'PARALLEL_SPECIFY',
            status: 'completed',
            specPath,
            specTaskId,
            executionMode,
            summary,
        }));
    }
    async markClarifyResult(rootPath, projectName, clarificationPath, summary, clarifyTaskId, clarificationStatus = 'generated') {
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase: 'PARALLEL_CLARIFY',
            status: 'completed',
            clarificationPath,
            clarifyTaskId,
            clarificationStatus,
            summary,
        }));
    }
    async markClarifyBlocked(rootPath, projectName, clarificationPath, summary, clarifyTaskId, clarificationStatus = 'awaiting_decision', decision) {
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase: 'PARALLEL_CLARIFY',
            status: 'blocked',
            clarificationPath,
            clarifyTaskId,
            clarificationStatus,
            summary,
        }, { decision }));
    }
    async markPlanResult(rootPath, projectName, planPath, summary, planTaskId, executionMode) {
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase: 'PARALLEL_PLAN',
            status: 'completed',
            planPath,
            planTaskId,
            executionMode,
            summary,
        }));
    }
    async markAceResult(rootPath, projectName, taskId, status, summary, executionMode) {
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase: 'PARALLEL_ACE',
            status,
            taskId,
            aceTaskId: taskId,
            executionMode,
            summary,
        }));
    }
    async markProjectInProgress(rootPath, projectName, phase, summary, taskId, executionMode) {
        const phaseTaskPatch = phase === 'PARALLEL_CLARIFY'
            ? { clarifyTaskId: taskId, taskId }
            : phase === 'PARALLEL_SPECIFY'
                ? { specTaskId: taskId, taskId }
                : phase === 'PARALLEL_PLAN'
                    ? { planTaskId: taskId, taskId }
                    : phase === 'PARALLEL_ACE'
                        ? { aceTaskId: taskId, taskId }
                        : taskId
                            ? { taskId }
                            : {};
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase,
            status: 'in_progress',
            summary,
            executionMode,
            ...phaseTaskPatch,
        }));
    }
    async markProjectBlocked(rootPath, projectName, phase, summary, taskId) {
        const phaseTaskPatch = phase === 'PARALLEL_CLARIFY'
            ? { clarifyTaskId: taskId, taskId }
            : phase === 'PARALLEL_SPECIFY'
                ? { specTaskId: taskId, taskId }
                : phase === 'PARALLEL_PLAN'
                    ? { planTaskId: taskId, taskId }
                    : phase === 'PARALLEL_ACE'
                        ? { aceTaskId: taskId, taskId }
                        : taskId
                            ? { taskId }
                            : {};
        return this.withWorkspaceMutation(rootPath, () => this.updateProjectState(rootPath, projectName, {
            phase,
            status: 'blocked',
            summary,
            ...phaseTaskPatch,
        }));
    }
    async markProjectWorktreeReady(rootPath, projectName, input) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
            if (!project) {
                throw new Error(`Workspace project not found: ${projectName}`);
            }
            return this.updateProjectState(rootPath, projectName, {
                worktreeLanes: this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree),
            });
        });
    }
    async markProjectWorktreeFailed(rootPath, projectName, input) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
            if (!project) {
                throw new Error(`Workspace project not found: ${projectName}`);
            }
            return this.updateProjectState(rootPath, projectName, {
                worktreeLanes: this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree),
                summary: input.summary,
            });
        });
    }
    async markProjectWorktreeRemoved(rootPath, projectName, input) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
            if (!project) {
                throw new Error(`Workspace project not found: ${projectName}`);
            }
            const worktreeLanes = this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree);
            const removingActiveLane = normalizeLaneId(project.worktree?.laneId) === normalizeLaneId(input.worktree.laneId);
            return this.updateProjectState(rootPath, projectName, {
                effectiveProjectPath: removingActiveLane ? input.sourceProjectPath : project.effectiveProjectPath,
                worktree: removingActiveLane ? undefined : project.worktree,
                worktreeLanes,
            });
        });
    }
    async activateProjectWorktreeLane(rootPath, projectName, input) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const project = (snapshot.state.projects || []).find((item) => item.projectName === projectName);
            if (!project) {
                throw new Error(`Workspace project not found: ${projectName}`);
            }
            return this.updateProjectState(rootPath, projectName, {
                effectiveProjectPath: input.effectiveProjectPath,
                worktree: input.worktree,
                worktreeLanes: this.upsertProjectWorktreeLane(project.worktree, project.worktreeLanes, input.worktree),
            });
        });
    }
    async recordFeedback(rootPath, reason, affectedProjects, nextPhase = 'PARALLEL_PLAN') {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const now = new Date().toISOString();
            const nextState = {
                ...snapshot.state,
                currentPhase: 'FEEDBACK_ITERATION',
                updatedAt: now,
                workspaceFeedback: {
                    required: true,
                    reason,
                    affectedProjects,
                    nextPhase,
                    updatedAt: now,
                },
                decisions: this.resolvePendingDecisions(snapshot.state.decisions || [], affectedProjects, {
                    status: 'resolved',
                    message: reason,
                    nextPhase,
                    resolvedAt: now,
                }),
                notes: [
                    ...(snapshot.state.notes || []),
                    `Workspace feedback recorded: ${reason}`,
                ],
                summary: this.computeSummary(snapshot.state.projects || [], now),
            };
            await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
            return {
                ...snapshot,
                state: nextState,
            };
        });
    }
    async clearFeedback(rootPath, nextPhase) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const now = new Date().toISOString();
            const nextState = {
                ...snapshot.state,
                currentPhase: nextPhase,
                updatedAt: now,
                workspaceFeedback: {
                    required: false,
                    affectedProjects: [],
                    updatedAt: now,
                },
                decisions: this.dismissStalePendingDecisions(snapshot.state.decisions || [], now),
                summary: this.computeSummary(snapshot.state.projects || [], now),
            };
            await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
            return {
                ...snapshot,
                state: nextState,
            };
        });
    }
    async resolveDecision(rootPath, input) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.state) {
                throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
            }
            const decisions = snapshot.state.decisions || [];
            const decision = decisions.find((item) => item.id === input.decisionId);
            if (!decision) {
                throw new Error(`Workspace decision not found: ${input.decisionId}`);
            }
            if (decision.status !== 'pending') {
                throw new Error(`Workspace decision is not pending: ${input.decisionId}`);
            }
            const option = input.optionId
                ? decision.options?.find((item) => item.id === input.optionId)
                : undefined;
            if (input.optionId && !option) {
                throw new Error(`Workspace decision option not found: ${input.optionId}`);
            }
            const now = new Date().toISOString();
            const nextPhase = option?.nextPhase || decision.phase;
            const affectedProjects = Array.from(new Set([
                ...(snapshot.state.workspaceFeedback?.affectedProjects || []),
                ...(decision.projectName ? [decision.projectName] : []),
            ]));
            const nextProjects = (snapshot.state.projects || []).map((project) => {
                if (decision.projectName && project.projectName !== decision.projectName)
                    return project;
                return {
                    ...project,
                    ...(option?.artifactField && option.artifactPath
                        ? { [option.artifactField]: option.artifactPath }
                        : {}),
                    clarificationStatus: decision.phase === 'PARALLEL_CLARIFY'
                        ? 'resolved'
                        : project.clarificationStatus,
                    blockerKind: undefined,
                    recommendedCommand: 'tik workspace next',
                    updatedAt: now,
                };
            });
            const resolution = {
                status: 'resolved',
                optionId: option?.id,
                message: input.message,
                nextPhase,
                resolvedAt: now,
            };
            const feedbackReason = [
                `Decision resolved: ${decision.title}`,
                option ? `choice=${option.label}` : '',
                input.message ? `message=${input.message}` : '',
            ].filter(Boolean).join(' | ');
            const nextState = {
                ...snapshot.state,
                currentPhase: 'FEEDBACK_ITERATION',
                updatedAt: now,
                projects: nextProjects,
                workspaceFeedback: {
                    required: true,
                    reason: feedbackReason,
                    affectedProjects,
                    nextPhase,
                    updatedAt: now,
                },
                decisions: decisions.map((item) => item.id === decision.id
                    ? {
                        ...item,
                        status: 'resolved',
                        updatedAt: now,
                        resolution,
                    }
                    : item),
                notes: [
                    ...(snapshot.state.notes || []),
                    feedbackReason,
                ],
                summary: this.computeSummary(nextProjects, now),
            };
            await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
            return {
                ...snapshot,
                state: nextState,
            };
        });
    }
    async updateWorkflowPolicy(rootPath, workflowPolicy) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.settings) {
                throw new Error('Workspace settings not initialized. Run workspace bootstrap first.');
            }
            const now = new Date().toISOString();
            const effectivePolicy = workflowPolicy.profile
                ? workflowPolicy
                : {
                    ...(snapshot.settings.workflowPolicy || this.defaultWorkflowPolicy()),
                    ...workflowPolicy,
                };
            const nextSettings = {
                ...snapshot.settings,
                updatedAt: now,
                workflowPolicy: resolveWorkspaceWorkflowPolicy(effectivePolicy),
            };
            await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'settings.json'), nextSettings);
            return {
                ...snapshot,
                settings: nextSettings,
            };
        });
    }
    async updateWorktreePolicy(rootPath, worktreePolicy) {
        return this.withWorkspaceMutation(rootPath, async () => {
            const snapshot = await this.getStatus(rootPath);
            if (!snapshot.settings) {
                throw new Error('Workspace settings not initialized. Run workspace bootstrap first.');
            }
            const now = new Date().toISOString();
            const nextSettings = {
                ...snapshot.settings,
                updatedAt: now,
                worktreePolicy: {
                    ...(snapshot.settings.worktreePolicy || this.defaultWorktreePolicy(rootPath)),
                    ...worktreePolicy,
                },
            };
            await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'settings.json'), nextSettings);
            return {
                ...snapshot,
                settings: nextSettings,
            };
        });
    }
    async withWorkspaceMutation(rootPath, fn) {
        const previous = this.mutationQueues.get(rootPath) || Promise.resolve();
        const run = previous
            .catch(() => undefined)
            .then(() => this.withWorkspaceFileLock(rootPath, fn));
        this.mutationQueues.set(rootPath, run);
        try {
            return await run;
        }
        finally {
            if (this.mutationQueues.get(rootPath) === run) {
                this.mutationQueues.delete(rootPath);
            }
        }
    }
    getWorkspaceDir(rootPath) {
        return path.join(rootPath, '.workspace');
    }
    getWorkspaceLockPath(rootPath) {
        return path.join(this.getWorkspaceDir(rootPath), '.state.lock');
    }
    buildSettings(workspace, workflowPolicy) {
        const now = new Date().toISOString();
        const effectivePolicy = workflowPolicy?.profile
            ? workflowPolicy
            : {
                ...this.defaultWorkflowPolicy(),
                ...(workflowPolicy || {}),
            };
        return {
            workspaceName: workspace.name,
            workspaceRoot: workspace.rootPath,
            workspaceFile: workspace.workspaceFile,
            createdAt: now,
            updatedAt: now,
            projects: workspace.projects,
            workflowPolicy: resolveWorkspaceWorkflowPolicy(effectivePolicy),
            worktreePolicy: this.defaultWorktreePolicy(workspace.rootPath),
        };
    }
    defaultWorkflowPolicy() {
        return {
            profile: 'balanced',
            phaseBudgetsMs: {
                PARALLEL_CLARIFY: 120_000,
                PARALLEL_SPECIFY: 300_000,
                PARALLEL_PLAN: 300_000,
                PARALLEL_ACE: 600_000,
            },
            maxFeedbackRetriesPerPhase: {
                PARALLEL_CLARIFY: 1,
                PARALLEL_SPECIFY: 1,
                PARALLEL_PLAN: 1,
                PARALLEL_ACE: 2,
            },
            enableNativeArtifactRescue: true,
            enableAceEvidencePromotion: true,
        };
    }
    defaultWorktreePolicy(rootPath) {
        return {
            mode: 'managed',
            defaultBranchStrategy: 'auto-create',
            defaultRetention: 'retain',
            nonGitStrategy: 'source',
            worktreeRoot: path.join(rootPath, '.workspace', 'worktrees'),
        };
    }
    buildSplitDemands(resolution, demand) {
        const workspace = resolution.workspace;
        const selected = this.selectProjects(workspace.projects, demand, resolution.projectPath);
        const createdAt = new Date().toISOString();
        return {
            demand,
            createdAt,
            items: selected.map((selection) => ({
                projectName: selection.project.name,
                projectPath: selection.project.path,
                demand,
                reason: selection.reason,
                status: 'pending',
            })),
        };
    }
    buildState(demand, items) {
        const now = new Date().toISOString();
        return {
            currentPhase: 'PARALLEL_CLARIFY',
            demand,
            activeProjectNames: items.map((item) => item.projectName),
            createdAt: now,
            updatedAt: now,
            projects: items.map((item) => ({
                projectName: item.projectName,
                projectPath: item.projectPath,
                sourceProjectPath: item.projectPath,
                effectiveProjectPath: item.projectPath,
                worktreeLanes: [],
                phase: 'PARALLEL_CLARIFY',
                status: 'pending',
                clarificationStatus: 'skipped',
                updatedAt: now,
            })),
            decisions: [],
            workspaceFeedback: {
                required: false,
                affectedProjects: [],
                updatedAt: now,
            },
            summary: this.computeSummary(items.map((item) => ({
                projectName: item.projectName,
                projectPath: item.projectPath,
                sourceProjectPath: item.projectPath,
                effectiveProjectPath: item.projectPath,
                worktreeLanes: [],
                phase: 'PARALLEL_CLARIFY',
                status: 'pending',
                clarificationStatus: 'skipped',
                updatedAt: now,
            })), now),
            notes: [
                'Phase 0 initialized by Tik Workspace Orchestrator MVP.',
                'Next step: run project-level clarification gating before specification.',
            ],
        };
    }
    selectProjects(projects, demand, activeProjectPath) {
        const loweredDemand = demand.toLowerCase();
        const analyses = projects.map((project) => this.analyzeProjectMention(project, loweredDemand));
        const directMatches = analyses
            .filter((analysis) => analysis.directScore > 0)
            .sort((left, right) => right.directScore - left.directScore || right.mentionCount - left.mentionCount);
        if (directMatches.length > 0) {
            const topScore = directMatches[0].directScore;
            const selected = directMatches.filter((analysis) => analysis.directScore === topScore);
            return selected.map((analysis) => ({
                project: analysis.project,
                reason: analysis.reason,
            }));
        }
        const explicitMatches = analyses.filter((analysis) => analysis.mentionCount > 0);
        if (explicitMatches.length === 1) {
            const match = explicitMatches[0];
            return [{
                    project: match.project,
                    reason: match.reason,
                }];
        }
        if (explicitMatches.length > 1) {
            const activeExplicitMatch = explicitMatches.find((analysis) => (analysis.project.path === activeProjectPath || activeProjectPath.startsWith(analysis.project.path)));
            if (activeExplicitMatch) {
                return [{
                        project: activeExplicitMatch.project,
                        reason: `Multiple project tokens matched, but only ${activeExplicitMatch.project.name} is the active project; defaulted conservatively to the active project.`,
                    }];
            }
        }
        const activeProject = projects.find((project) => project.path === activeProjectPath)
            || projects.find((project) => activeProjectPath.startsWith(project.path))
            || projects[0];
        if (!activeProject) {
            return [];
        }
        return [{
                project: activeProject,
                reason: `No explicit project token matched; defaulted to active project ${activeProject.name}`,
            }];
    }
    analyzeProjectMention(project, loweredDemand) {
        const tokens = Array.from(new Set([project.name, path.basename(project.path)]
            .map((value) => value.toLowerCase())
            .filter(Boolean)));
        let mentionCount = 0;
        let directScore = 0;
        let supportScore = 0;
        for (const token of tokens) {
            if (!loweredDemand.includes(token))
                continue;
            mentionCount += 1;
            const escaped = escapeRegExp(token);
            if (new RegExp(`(?:给|在|对|替换|修改|移除|删除|重构|新增|增加|改造|迁移|实现|收敛|治理|推进|修复|调整)\\s*${escaped}`, 'iu').test(loweredDemand)) {
                directScore += 3;
            }
            if (new RegExp(`${escaped}(?:项目|仓库|模块)?[^\\n，。,；;]{0,12}(?:需要|需|进行|做|改|修改|替换|移除|删除|重构|新增|增加|改造|迁移|实现|收敛|治理|推进|修复|调整)`, 'iu').test(loweredDemand)) {
                directScore += 2;
            }
            if (new RegExp(`(?:为|通过|调用|依赖|接入|使用|同步|对接)\\s*${escaped}[^\\n，。,；;]{0,12}(?:接口|服务|rpc|feign|契约|能力|数据源)`, 'iu').test(loweredDemand)) {
                supportScore += 2;
            }
            if (new RegExp(`${escaped}[^\\n，。,；;]{0,12}(?:接口|服务|rpc|feign|契约|能力|数据源|外部接口)`, 'iu').test(loweredDemand)) {
                supportScore += 1;
            }
        }
        const effectiveDirectScore = Math.max(0, directScore - supportScore);
        const reason = effectiveDirectScore > 0
            ? `Matched project ownership cues in demand: ${project.name}`
            : mentionCount > 0
                ? `Mentioned in demand but only as a dependency/reference: ${project.name}`
                : `No explicit project token matched: ${project.name}`;
        return {
            project,
            mentionCount,
            directScore: effectiveDirectScore,
            reason,
        };
    }
    async writeJson(filePath, payload) {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
        await fs.rename(tempPath, filePath);
    }
    async readJson(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
    async updateProjectState(rootPath, projectName, patch, options) {
        const snapshot = await this.getStatus(rootPath);
        if (!snapshot.state) {
            throw new Error('Workspace state not initialized. Run workspace bootstrap first.');
        }
        const now = new Date().toISOString();
        const projects = snapshot.state.projects || [];
        const nextProjects = projects.map((project) => {
            if (project.projectName !== projectName)
                return project;
            const nextProject = {
                ...project,
                ...patch,
                updatedAt: now,
            };
            return {
                ...nextProject,
                ...this.deriveProjectControlPlane(nextProject),
            };
        });
        const nextPhase = this.computeCurrentPhase(nextProjects, snapshot.state.currentPhase);
        const nextNotes = this.computeNotes(nextPhase, snapshot.state.notes || []);
        const nextState = {
            ...snapshot.state,
            currentPhase: nextPhase,
            updatedAt: now,
            projects: nextProjects,
            notes: nextNotes,
            summary: this.computeSummary(nextProjects, now),
        };
        const blockedOrFailedProjects = nextProjects.filter((project) => project.status === 'blocked' || project.status === 'failed');
        if (nextPhase === 'FEEDBACK_ITERATION' && blockedOrFailedProjects.length > 0) {
            const seededDecisions = options?.decision
                ? this.upsertDecisionRequest(snapshot.state.decisions || [], options.decision)
                : (snapshot.state.decisions || []);
            const failedPhase = patch.phase ?? blockedOrFailedProjects[0]?.phase ?? snapshot.state.currentPhase;
            nextState.workspaceFeedback = {
                required: true,
                reason: patch.summary || blockedOrFailedProjects[0]?.summary || 'Workspace phase requires feedback.',
                affectedProjects: blockedOrFailedProjects.map((project) => project.projectName),
                nextPhase: failedPhase === 'PARALLEL_ACE'
                    ? 'PARALLEL_ACE'
                    : failedPhase === 'PARALLEL_CLARIFY'
                        ? 'PARALLEL_CLARIFY'
                        : failedPhase === 'PARALLEL_PLAN'
                            ? 'PARALLEL_PLAN'
                            : 'PARALLEL_SPECIFY',
                updatedAt: now,
            };
            nextState.decisions = await this.reconcileDecisionRequests(rootPath, snapshot, seededDecisions, blockedOrFailedProjects, now);
        }
        else if (snapshot.state.workspaceFeedback?.required) {
            nextState.workspaceFeedback = {
                required: false,
                affectedProjects: [],
                updatedAt: now,
            };
            nextState.decisions = this.dismissStalePendingDecisions(snapshot.state.decisions || [], now);
        }
        else {
            nextState.decisions = this.dismissResolvedProjectDecisions(snapshot.state.decisions || [], nextProjects, now);
        }
        const nextSplitDemands = snapshot.splitDemands
            ? {
                ...snapshot.splitDemands,
                items: snapshot.splitDemands.items.map((item) => {
                    if (item.projectName !== projectName)
                        return item;
                    return {
                        ...item,
                        status: patch.status === 'completed'
                            ? 'completed'
                            : patch.status === 'in_progress'
                                ? 'in_progress'
                                : patch.status === 'blocked'
                                    ? 'blocked'
                                    : patch.status === 'failed'
                                        ? 'blocked'
                                        : item.status,
                    };
                }),
            }
            : null;
        await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'state.json'), nextState);
        if (nextSplitDemands) {
            await this.writeJson(path.join(this.getWorkspaceDir(rootPath), 'split-demands.json'), nextSplitDemands);
        }
        return {
            ...snapshot,
            state: nextState,
            splitDemands: nextSplitDemands,
        };
    }
    computeCurrentPhase(projects, currentPhase) {
        if (projects.length === 0)
            return currentPhase;
        if (projects.some((project) => project.status === 'blocked')) {
            return 'FEEDBACK_ITERATION';
        }
        if (projects.some((project) => project.status === 'failed')) {
            return 'FEEDBACK_ITERATION';
        }
        if (projects.every((project) => project.phase === 'PARALLEL_ACE' && project.status === 'completed')) {
            return 'COMPLETED';
        }
        if (projects.every((project) => project.phase === 'PARALLEL_PLAN' && project.status === 'completed')) {
            return 'PARALLEL_ACE';
        }
        if (projects.every((project) => project.phase === 'PARALLEL_SPECIFY' && project.status === 'completed')) {
            return 'PARALLEL_PLAN';
        }
        if (projects.every((project) => project.phase === 'PARALLEL_CLARIFY' && project.status === 'completed')) {
            return 'PARALLEL_SPECIFY';
        }
        return currentPhase;
    }
    computeNotes(nextPhase, notes) {
        const filtered = notes.filter((note) => !note.startsWith('Next step:'));
        const nextStep = nextPhase === 'PARALLEL_CLARIFY'
            ? 'Next step: run project-level clarification gating and decision synthesis.'
            : nextPhase === 'PARALLEL_SPECIFY'
                ? 'Next step: fan out project-level specify tasks.'
                : nextPhase === 'PARALLEL_PLAN'
                    ? 'Next step: validate or regenerate project plan.md files.'
                    : nextPhase === 'PARALLEL_ACE'
                        ? 'Next step: fan out project-level ACE execution tasks.'
                        : nextPhase === 'FEEDBACK_ITERATION'
                            ? 'Next step: review pending workspace decisions or feedback and choose which phase to resume.'
                            : 'Next step: workspace flow is complete.';
        return [...filtered, nextStep];
    }
    deriveProjectControlPlane(project) {
        const route = project.phase === 'PARALLEL_CLARIFY' || project.phase === 'PARALLEL_SPECIFY' || project.phase === 'PARALLEL_PLAN' || project.phase === 'PARALLEL_ACE'
            ? getWorkflowSkillRouteByPhase(project.phase)
            : undefined;
        const workflowContract = route?.contract;
        const workflowRole = route?.role;
        const workflowSkillName = route?.skillName;
        const workflowSkillPath = route?.skillPath;
        const looksLikeTimeout = !!project.summary && /timed out|did not finish within/i.test(project.summary);
        const blockerKind = project.status === 'blocked'
            ? project.phase === 'PARALLEL_PLAN'
                ? 'REPLAN'
                : looksLikeTimeout
                    ? 'EXECUTION_FAILED'
                    : 'NEED_HUMAN'
            : project.status === 'failed'
                ? project.phase === 'PARALLEL_ACE'
                    ? 'EXECUTION_FAILED'
                    : 'EXECUTION_FAILED'
                : undefined;
        const recommendedCommand = project.status === 'blocked' || project.status === 'failed'
            ? 'tik workspace decisions'
            : project.status === 'completed'
                ? project.phase === 'PARALLEL_CLARIFY'
                    ? 'tik workspace next'
                    : project.phase === 'PARALLEL_SPECIFY'
                        ? 'tik workspace next'
                        : project.phase === 'PARALLEL_PLAN'
                            ? 'tik workspace next'
                            : project.phase === 'PARALLEL_ACE'
                                ? 'tik workspace report'
                                : 'tik workspace status'
                : project.status === 'in_progress'
                    ? 'tik workspace status'
                    : project.phase === 'PARALLEL_CLARIFY'
                        ? 'tik workspace next'
                        : project.phase === 'PARALLEL_SPECIFY'
                            ? 'tik workspace next'
                            : project.phase === 'PARALLEL_PLAN'
                                ? 'tik workspace next'
                                : project.phase === 'PARALLEL_ACE'
                                    ? 'tik workspace next'
                                    : 'tik workspace status';
        return {
            workflowContract,
            workflowRole,
            workflowSkillName,
            workflowSkillPath,
            blockerKind,
            recommendedCommand,
        };
    }
    upsertProjectWorktreeLane(active, lanes, worktree) {
        const laneId = normalizeLaneId(worktree.laneId);
        const next = [...(lanes || []), ...(active ? [active] : [])];
        const deduped = next.filter((lane, index, all) => (all.findIndex((candidate) => normalizeLaneId(candidate.laneId) === normalizeLaneId(lane.laneId)) === index));
        const index = deduped.findIndex((lane) => normalizeLaneId(lane.laneId) === laneId);
        const normalized = {
            ...worktree,
            laneId,
        };
        if (index >= 0) {
            deduped[index] = normalized;
        }
        else {
            deduped.push(normalized);
        }
        return deduped;
    }
    async reconcileDecisionRequests(rootPath, snapshot, decisions, blockedProjects, now) {
        const next = [...decisions];
        for (const project of blockedProjects) {
            const existing = next.find((decision) => decision.status === 'pending'
                && decision.projectName === project.projectName
                && decision.phase === this.toDecisionPhase(project.phase));
            if (existing)
                continue;
            next.push(await this.buildDecisionRequest(rootPath, snapshot, project, now));
        }
        return next;
    }
    upsertDecisionRequest(decisions, decision) {
        const next = [...decisions];
        const existingIndex = next.findIndex((item) => (item.id === decision.id
            || (item.status === 'pending'
                && item.projectName === decision.projectName
                && item.phase === decision.phase)));
        if (existingIndex >= 0) {
            next[existingIndex] = decision;
            return next;
        }
        next.push(decision);
        return next;
    }
    resolvePendingDecisions(decisions, affectedProjects, resolution) {
        const affected = new Set(affectedProjects);
        return decisions.map((decision) => (decision.status === 'pending'
            && (affected.size === 0 || (decision.projectName && affected.has(decision.projectName)))
            ? {
                ...decision,
                status: resolution.status,
                updatedAt: resolution.resolvedAt,
                resolution,
            }
            : decision));
    }
    dismissStalePendingDecisions(decisions, now) {
        return decisions.map((decision) => (decision.status === 'pending'
            ? {
                ...decision,
                status: 'dismissed',
                updatedAt: now,
                resolution: {
                    status: 'dismissed',
                    resolvedAt: now,
                    message: 'Dismissed after workspace feedback loop advanced.',
                },
            }
            : decision));
    }
    dismissResolvedProjectDecisions(decisions, projects, now) {
        const stillBlocked = new Set(projects
            .filter((project) => project.status === 'blocked' || project.status === 'failed')
            .map((project) => `${project.projectName}:${this.toDecisionPhase(project.phase)}`));
        return decisions.map((decision) => (decision.status === 'pending'
            && decision.projectName
            && !stillBlocked.has(`${decision.projectName}:${decision.phase}`)
            ? {
                ...decision,
                status: 'dismissed',
                updatedAt: now,
                resolution: {
                    status: 'dismissed',
                    resolvedAt: now,
                    message: 'Dismissed because the project is no longer blocked in this phase.',
                },
            }
            : decision));
    }
    async buildDecisionRequest(rootPath, snapshot, project, now) {
        return synthesizeWorkspaceDecision(await this.buildDecisionSynthesisInput(rootPath, snapshot, project), now);
    }
    async buildDecisionSynthesisInput(rootPath, snapshot, project) {
        const eventStore = new WorkspaceEventStore({
            persistPath: path.join(this.getWorkspaceDir(rootPath), 'events.jsonl'),
        });
        const projection = buildWorkspaceEventProjection(eventStore.snapshot());
        const memoryStore = new WorkspaceMemoryStore(rootPath);
        const memory = await memoryStore.load();
        const recentProjectEvents = projection.recent
            .filter((event) => event.projectName === project.projectName)
            .slice(-4)
            .map((event) => `${event.phase} ${event.kind}: ${event.message}`);
        const recentWorkspaceEvents = projection.recent
            .slice(-4)
            .map((event) => `${event.projectName ? `${event.projectName} / ` : ''}${event.phase} ${event.kind}: ${event.message}`);
        const knownArtifacts = [project.clarificationPath, project.specPath, project.planPath].filter((item) => Boolean(item));
        const clarificationExcerpt = await this.readArtifactExcerpt(project.clarificationPath);
        const specExcerpt = await this.readArtifactExcerpt(project.specPath);
        const planExcerpt = await this.readArtifactExcerpt(project.planPath);
        return {
            projectName: project.projectName,
            phase: this.toDecisionPhase(project.phase),
            blockerKind: project.blockerKind,
            summary: project.summary,
            demand: snapshot.state?.demand,
            workflowContract: project.workflowContract,
            workflowRole: project.workflowRole,
            workflowSkillName: project.workflowSkillName,
            specPath: project.specPath,
            planPath: project.planPath,
            workflowProfile: snapshot.settings?.workflowPolicy?.profile,
            recentProjectEvents,
            recentWorkspaceEvents,
            projectKnownArtifacts: knownArtifacts,
            sessionNextAction: memory?.session.nextAction || project.recommendedCommand,
            specExcerpt: clarificationExcerpt ? [clarificationExcerpt, specExcerpt].filter(Boolean).join('\n\n') : specExcerpt,
            planExcerpt,
        };
    }
    toDecisionPhase(phase) {
        return phase === 'PARALLEL_CLARIFY'
            ? 'PARALLEL_CLARIFY'
            : phase === 'PARALLEL_PLAN'
                ? 'PARALLEL_PLAN'
                : phase === 'PARALLEL_ACE'
                    ? 'PARALLEL_ACE'
                    : 'PARALLEL_SPECIFY';
    }
    computeSummary(projects, updatedAt) {
        return {
            totalProjects: projects.length,
            completedProjects: projects.filter((project) => project.status === 'completed').length,
            blockedProjects: projects.filter((project) => project.status === 'blocked').length,
            failedProjects: projects.filter((project) => project.status === 'failed').length,
            clarifiedProjects: projects.filter((project) => Boolean(project.clarificationPath) && project.clarificationStatus !== 'awaiting_decision').length,
            pendingClarificationProjects: projects.filter((project) => Boolean(project.clarificationPath) && project.clarificationStatus === 'awaiting_decision').length,
            needsHumanProjects: projects.filter((project) => project.blockerKind === 'NEED_HUMAN').length,
            replanProjects: projects.filter((project) => project.blockerKind === 'REPLAN').length,
            updatedAt,
        };
    }
    async readArtifactExcerpt(artifactPath) {
        if (!artifactPath)
            return undefined;
        try {
            const content = await fs.readFile(artifactPath, 'utf-8');
            return content.slice(0, 1200);
        }
        catch {
            return undefined;
        }
    }
    async withWorkspaceFileLock(rootPath, fn) {
        const workspaceDir = this.getWorkspaceDir(rootPath);
        const lockPath = this.getWorkspaceLockPath(rootPath);
        await fs.mkdir(workspaceDir, { recursive: true });
        const startedAt = Date.now();
        while (true) {
            try {
                const handle = await fs.open(lockPath, 'wx');
                try {
                    await handle.writeFile(JSON.stringify({
                        pid: process.pid,
                        startedAt: new Date().toISOString(),
                    }));
                    return await fn();
                }
                finally {
                    await handle.close().catch(() => undefined);
                    await fs.unlink(lockPath).catch(() => undefined);
                }
            }
            catch (error) {
                const err = error;
                if (err.code !== 'EEXIST') {
                    throw error;
                }
                await this.maybeClearStaleWorkspaceLock(lockPath);
                if (Date.now() - startedAt > this.lockTimeoutMs) {
                    throw new Error(`Timed out waiting for workspace state lock: ${lockPath}`);
                }
                await sleep(25);
            }
        }
    }
    async maybeClearStaleWorkspaceLock(lockPath) {
        try {
            const stat = await fs.stat(lockPath);
            if (Date.now() - stat.mtimeMs > this.staleLockMs) {
                await fs.unlink(lockPath).catch(() => undefined);
            }
        }
        catch {
            // The lock may already be gone; ignore and retry.
        }
    }
}
function normalizeLaneId(value) {
    return (value || 'primary').trim() || 'primary';
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=workspace-orchestrator.js.map