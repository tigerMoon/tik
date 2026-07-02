import { spawnSync } from 'node:child_process';
/**
 * Rule-based explanation builder.
 *
 * v1 intentionally does not call an LLM. It turns existing workspace state,
 * phase artifacts, blockers, and git status into a stable explanation object.
 */
export class WorkspaceExplanationBuilder {
    build(input) {
        const projects = this.visibleProjects(input.state?.projects || [], input.projectNames);
        const changedFiles = this.collectChangedFiles(projects);
        const blockers = this.collectBlockers(input.state, projects);
        const phases = this.collectPhases(projects, changedFiles, blockers);
        const status = this.resolveStatus(input.state, projects, blockers);
        return {
            workspaceId: input.settings?.workspaceName,
            workspaceName: input.settings?.workspaceName,
            status,
            summary: this.buildSummary(status, projects, changedFiles, blockers),
            whyThisStatus: this.buildReasons(status, input.state, projects, blockers, changedFiles),
            phases,
            changedFiles,
            blockers,
            unresolvedItems: this.collectUnresolvedItems(input.state, projects, blockers),
            nextActions: this.buildNextActions(status, input.state, blockers, changedFiles),
            confidence: this.resolveConfidence(status, projects, changedFiles, blockers),
            generatedAt: new Date().toISOString(),
        };
    }
    visibleProjects(projects, projectNames) {
        const wanted = new Set((projectNames || []).filter(Boolean));
        if (wanted.size === 0)
            return projects;
        return projects.filter((project) => wanted.has(project.projectName));
    }
    resolveStatus(state, projects, blockers) {
        if (!state)
            return 'unknown';
        if (state.currentPhase === 'COMPLETED')
            return 'completed';
        if (state.currentPhase === 'FEEDBACK_ITERATION' || state.workspaceFeedback?.required)
            return 'feedback';
        if (projects.some((project) => project.status === 'failed'))
            return 'failed';
        if (blockers.length > 0 || projects.some((project) => project.status === 'blocked'))
            return 'blocked';
        if (projects.length > 0 && projects.every((project) => project.status === 'completed'))
            return 'completed';
        return 'unknown';
    }
    buildSummary(status, projects, changedFiles, blockers) {
        const completed = projects.filter((project) => project.status === 'completed').length;
        if (status === 'completed') {
            return `Workspace completed with ${completed}/${projects.length} project(s) completed and ${changedFiles.length} changed file(s) detected.`;
        }
        if (status === 'feedback') {
            return `Workspace entered feedback iteration with ${blockers.length} blocker(s) or follow-up item(s).`;
        }
        if (status === 'blocked') {
            return `Workspace is blocked by ${blockers.length} issue(s).`;
        }
        if (status === 'failed') {
            return `Workspace failed with ${projects.filter((project) => project.status === 'failed').length} failed project(s).`;
        }
        return `Workspace is currently ${status}.`;
    }
    buildReasons(status, state, projects, blockers, changedFiles) {
        const reasons = [];
        if (state?.currentPhase)
            reasons.push(`Workspace phase is ${state.currentPhase}.`);
        if (status === 'completed') {
            reasons.push('The workspace reached a successful terminal state.');
            if (projects.length > 0) {
                reasons.push(`${projects.filter((project) => project.status === 'completed').length}/${projects.length} visible project(s) are completed.`);
            }
            if (changedFiles.length > 0) {
                reasons.push(`${changedFiles.length} changed file(s) were detected for review.`);
            }
            if (blockers.length === 0) {
                reasons.push('No active Tik runtime blocker remains in the visible project set.');
            }
        }
        if (status === 'feedback') {
            reasons.push('The runtime selected a controlled feedback/retry path instead of hanging or reporting an opaque failure.');
            if (state?.workspaceFeedback?.reason)
                reasons.push(`Feedback reason: ${state.workspaceFeedback.reason}`);
            if (state?.workspaceFeedback?.nextPhase)
                reasons.push(`Next retry phase is ${state.workspaceFeedback.nextPhase}.`);
        }
        if (status === 'blocked' || status === 'failed') {
            for (const blocker of blockers)
                reasons.push(`Blocker: ${blocker.message}`);
            for (const project of projects.filter((project) => project.status === 'failed')) {
                reasons.push(`${project.projectName} is marked failed${project.summary ? `: ${project.summary}` : '.'}`);
            }
        }
        return Array.from(new Set(reasons));
    }
    collectPhases(projects, changedFiles, blockers) {
        return projects.map((project) => {
            const projectChangedFiles = changedFiles.filter((file) => file.projectName === project.projectName);
            const projectBlockers = blockers.filter((blocker) => blocker.projectName === project.projectName);
            const artifacts = [project.clarificationPath, project.specPath, project.planPath].filter(Boolean);
            const evidence = [
                project.clarifyTaskId ? `clarifyTaskId=${project.clarifyTaskId}` : '',
                project.specTaskId ? `specTaskId=${project.specTaskId}` : '',
                project.planTaskId ? `planTaskId=${project.planTaskId}` : '',
                project.aceTaskId ? `aceTaskId=${project.aceTaskId}` : '',
                project.taskId ? `taskId=${project.taskId}` : '',
                project.executionMode ? `executionMode=${project.executionMode}` : '',
                project.workflowContract ? `contract=${project.workflowContract}` : '',
                project.workflowSkillName ? `skill=${project.workflowSkillName}` : '',
            ].filter(Boolean);
            return {
                phase: project.phase,
                projectName: project.projectName,
                status: this.mapProjectStatus(project.status),
                summary: project.summary || `${project.projectName} is ${project.status} at ${project.phase}.`,
                artifacts,
                changedFiles: projectChangedFiles,
                blockers: projectBlockers,
                evidence,
            };
        });
    }
    mapProjectStatus(status) {
        if (status === 'completed')
            return 'completed';
        if (status === 'blocked')
            return 'blocked';
        if (status === 'failed')
            return 'failed';
        return 'unknown';
    }
    collectBlockers(state, projects) {
        const blockers = [];
        if (state?.workspaceFeedback?.required) {
            blockers.push({
                type: 'needs_human',
                message: state.workspaceFeedback.reason || 'Workspace feedback is required.',
                evidence: state.workspaceFeedback.nextPhase ? [`nextPhase=${state.workspaceFeedback.nextPhase}`] : [],
            });
        }
        for (const project of projects) {
            if (project.status === 'blocked') {
                blockers.push({
                    type: project.blockerKind === 'REPLAN' ? 'replan_required' : project.blockerKind === 'NEED_HUMAN' ? 'needs_human' : 'runtime_blocker',
                    projectName: project.projectName,
                    phase: project.phase,
                    message: project.summary || `${project.projectName} is blocked at ${project.phase}.`,
                    evidence: [project.recommendedCommand ? `next=${project.recommendedCommand}` : ''].filter(Boolean),
                });
            }
            if (project.status === 'failed') {
                blockers.push({
                    type: 'runtime_blocker',
                    projectName: project.projectName,
                    phase: project.phase,
                    message: project.summary || `${project.projectName} failed at ${project.phase}.`,
                });
            }
        }
        return blockers;
    }
    collectChangedFiles(projects) {
        const files = [];
        for (const project of projects) {
            const projectPath = project.effectiveProjectPath || project.projectPath;
            if (!projectPath)
                continue;
            const status = spawnSync('git', ['-C', projectPath, 'status', '--porcelain'], { encoding: 'utf-8' });
            if (status.status !== 0)
                continue;
            const rows = (status.stdout || '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
            for (const row of rows) {
                const code = row.slice(0, 2);
                const rawPath = row.slice(3).trim();
                if (!rawPath)
                    continue;
                files.push({
                    projectName: project.projectName,
                    path: rawPath,
                    changeType: this.mapGitStatusToChangeType(code),
                    reason: `Detected by git status in ${project.projectName}.`,
                    evidence: [`phase=${project.phase}`, `status=${project.status}`],
                });
            }
        }
        return files;
    }
    mapGitStatusToChangeType(code) {
        if (code.includes('R'))
            return 'renamed';
        if (code.includes('D'))
            return 'deleted';
        if (code.includes('A') || code.includes('?'))
            return 'created';
        if (code.trim())
            return 'modified';
        return 'unknown';
    }
    collectUnresolvedItems(state, projects, blockers) {
        const items = blockers.map((blocker) => blocker.projectName ? `${blocker.projectName}: ${blocker.message}` : blocker.message);
        if (state?.workspaceFeedback?.nextPhase)
            items.push(`Retry can continue at ${state.workspaceFeedback.nextPhase}.`);
        for (const project of projects) {
            if (project.recommendedCommand)
                items.push(`${project.projectName}: ${project.recommendedCommand}`);
        }
        return Array.from(new Set(items));
    }
    buildNextActions(status, state, blockers, changedFiles) {
        if (status === 'completed') {
            return [
                changedFiles.length > 0 ? 'Review generated diffs in the active workspace/worktree.' : 'Review generated artifacts and phase summaries.',
                'Run project-specific validation if needed.',
            ];
        }
        if (status === 'feedback' || status === 'blocked') {
            const nextPhase = state?.workspaceFeedback?.nextPhase;
            return [
                'Inspect blockers and pending decisions in `tik workspace board`.',
                nextPhase ? `Continue with feedback/retry at ${nextPhase}.` : 'Run `tik workspace feedback` or `tik workspace retry` after resolving blockers.',
            ];
        }
        if (status === 'failed') {
            return ['Inspect recent events and rerun the failed phase with narrower project scope.'];
        }
        return ['Inspect `tik workspace status` and `tik workspace report` for current state.'];
    }
    resolveConfidence(status, projects, changedFiles, blockers) {
        if (status === 'completed' && blockers.length === 0 && projects.length > 0) {
            return changedFiles.length > 0 ? 'high' : 'medium';
        }
        if (status === 'feedback' || status === 'blocked')
            return 'medium';
        return 'low';
    }
}
//# sourceMappingURL=workspace-explanation-builder.js.map