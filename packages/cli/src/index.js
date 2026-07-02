/**
 * Tik CLI
 *
 * Task-first CLI for Tik.
 * Commands: run, plan, status, logs, eval, stop, list, serve, workspace
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as TikKernel from '@tik/kernel';
import { buildWorkspaceEventProjection, createWorkspaceSkillExecutorRegistry, isWorkspacePlanValid, LocalWorkflowSkillRuntimeAdapter, materializeWorkflowSkillDelegatedSpec, WorkspaceContextAssembler, WorkspaceMemoryStore, WorkspaceEventStore, WorkspacePolicyEngine, WorkspaceWorktreeManager, WorkspaceWorkflowEngine, WorkflowSubtaskRuntime, FileRunProofStore, } from '@tik/kernel';
import { displayTask, displayTaskResult, displayEvent, } from './display/display.js';
import { runShell } from './shell.js';
import { listCliSessions } from './session-store.js';
import { buildWorkspaceFeatureDir, buildWorkspacePlanTargetPath, buildWorkspaceSpecTargetPath, resolveWorkspacePlanArtifact, resolveWorkspaceSpecArtifact, workspaceFeatureDirForArtifact, } from './workspace-artifacts.js';
import { buildArtifactDetailUrl, buildArtifactPreviewApiUrl, formatArtifactList, formatArtifactShow, readArtifactResponse, } from './artifacts-command.js';
import { createKernel } from './cli/kernel-factory.js';
import { registerServeCommand } from './cli/serve-command.js';
import { registerTrackerCommands } from './cli/tracker-command.js';
import { registerWorkflowCommands } from './cli/workflow-command-registration.js';
import { registerWorktreeCommands } from './cli/worktree-command.js';
import { interactiveProviderHelp, planningProviderHelp, } from './cli/provider-resolution.js';
import { captureWorkspaceGitChangedFiles } from './workspace-git.js';
const DEFAULT_API_BASE_URL = 'http://localhost:3300';
// ─── Workspace Resolution ────────────────────────────────────
const { WorkspaceResolver } = TikKernel;
const workspaceResolver = new WorkspaceResolver();
const workspaceWorktreeManager = new WorkspaceWorktreeManager();
const workspaceOrchestrator = new TikKernel.WorkspaceOrchestrator();
async function resolveProjectPath(opts) {
    if (opts.project) {
        const resolved = await workspaceResolver.resolve(opts.project, opts.target);
        if (resolved.workspace) {
            return resolved;
        }
        return { workspace: null, projectPath: opts.project, isWorkspace: false };
    }
    return workspaceResolver.resolve(process.cwd(), opts.target);
}
// ─── CLI Program ─────────────────────────────────────────────
const program = new Command();
program
    .name('tik')
    .description('Tik - Observable, Controllable, Convergent Agent')
    .version('0.1.0')
    .addHelpText('after', `

Provider guidance:
  codex            Governed implementation mode for real coding tasks
  codex-delegate   Delegated subtask execution for review, analysis, and complete handoff runs

Examples:
  tik
  tik run "实现用户认证" --provider codex
  tik run "审查当前改动并总结风险" --provider codex-delegate
`);
// ── tik shell ────────────────────────────────────────────────
program
    .command('shell')
    .description('Start an interactive Tik shell')
    .option('-p, --project <path>', 'Explicit project or workspace path')
    .option('-t, --target <name>', 'Target project in workspace')
    .option('--resume <session>', 'Resume a saved shell session by id or path')
    .option('-s, --strategy <strategy>', 'Convergence strategy', 'incremental')
    .option('-m, --max-iterations <n>', 'Max iterations per turn', '5')
    .option('--mode <mode>', 'Execution mode: single or multi', 'single')
    .option('--provider <provider>', interactiveProviderHelp, 'codex')
    .option('--model <model>', 'Override model name')
    .option('--mock', 'Force mock LLM')
    .addHelpText('after', `

Examples:
  tik shell
  tik shell --provider codex
  tik shell --provider codex-delegate
`)
    .action(async (opts) => {
    const resolution = await resolveProjectPath(opts);
    const provider = opts.mock ? 'mock' : opts.provider;
    await runShell({
        config: {
            projectPath: resolution.projectPath,
            provider,
            model: opts.model,
            mode: opts.mode,
            strategy: opts.strategy,
            maxIterations: parseInt(opts.maxIterations),
            resolution,
            resume: opts.resume,
        },
        createRuntime: ({ projectPath, provider: shellProvider, model }) => {
            const { kernel, llmName, provider: resolvedProvider } = createKernel(projectPath, { provider: shellProvider, model });
            return { kernel, llmName, provider: resolvedProvider };
        },
    });
});
program
    .command('sessions')
    .description('List saved Tik shell sessions')
    .option('-p, --project <path>', 'Explicit project or workspace path')
    .option('-t, --target <name>', 'Target project in workspace')
    .action(async (opts) => {
    const resolution = await resolveProjectPath(opts);
    const sessions = await listCliSessions(resolution.projectPath);
    console.log(chalk.bold('\n💾 Saved Sessions\n'));
    console.log(chalk.dim(`  Project: ${resolution.projectPath}\n`));
    if (sessions.length === 0) {
        console.log(chalk.yellow('  No saved shell sessions.\n'));
        return;
    }
    for (const session of sessions.slice().reverse()) {
        const lastTask = session.lastTaskId ? ` | last task: ${session.lastTaskId} (${session.lastTaskStatus || 'unknown'})` : '';
        console.log(`  ${chalk.cyan(session.sessionId)}  ${session.provider}  ${session.mode}  turns=${session.turns}  updated=${session.updatedAt}${lastTask}`);
    }
    console.log('');
});
program
    .command('init')
    .description('Scaffold CLAUDE.md and AGENTS.md in the target project')
    .option('-p, --project <path>', 'Explicit project or workspace path')
    .option('-t, --target <name>', 'Target project in workspace')
    .option('--force', 'Overwrite existing instruction files')
    .action(async (opts) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const resolution = await resolveProjectPath(opts);
    const targets = [
        {
            path: path.join(resolution.projectPath, 'CLAUDE.md'),
            content: [
                '# Project Instructions',
                '',
                '- Describe the project goal and constraints here.',
                '- Capture preferred workflows, validation rules, and review expectations.',
                '- Keep this file concise and actionable for coding agents.',
                '',
            ].join('\n'),
        },
        {
            path: path.join(resolution.projectPath, 'AGENTS.md'),
            content: [
                '# Agent Instructions',
                '',
                '- List important roles, ownership boundaries, and handoff expectations.',
                '- Document repository conventions that planner/coder/reviewer should follow.',
                '- Add task-specific coordination notes as they stabilize.',
                '',
            ].join('\n'),
        },
    ];
    const created = [];
    for (const target of targets) {
        let exists = false;
        try {
            await fs.access(target.path);
            exists = true;
        }
        catch {
            exists = false;
        }
        if (exists && !opts.force)
            continue;
        await fs.mkdir(path.dirname(target.path), { recursive: true });
        await fs.writeFile(target.path, target.content, 'utf-8');
        created.push(target.path);
    }
    console.log(chalk.bold('\n🧭 Tik Init\n'));
    if (created.length === 0) {
        console.log(chalk.yellow('  Instruction files already exist. Use --force to rewrite them.\n'));
        return;
    }
    for (const file of created) {
        console.log(chalk.green(`  Created ${file}`));
    }
    console.log('');
});
// ── tik run ──────────────────────────────────────────────────
program
    .command('run')
    .description('Submit and run a task')
    .argument('<description>', 'Task description')
    .option('-p, --project <path>', 'Explicit project or workspace path')
    .option('-t, --target <name>', 'Target project in workspace')
    .option('-s, --strategy <strategy>', 'Convergence strategy', 'incremental')
    .option('-m, --max-iterations <n>', 'Max iterations', '5')
    .option('--mode <mode>', 'Execution mode: single or multi', 'single')
    .option('--provider <provider>', interactiveProviderHelp, 'codex')
    .option('--model <model>', 'Override model name')
    .option('--mock', 'Force mock LLM (skip Claude API)')
    .addHelpText('after', `

Examples:
  tik run "实现用户认证" --provider claude
  tik run "给票务查询接口做缓存" --provider codex
  tik run "审查当前改动并总结风险" --provider codex-delegate
`)
    .action(async (description, opts) => {
    const resolution = await resolveProjectPath(opts);
    const provider = opts.mock ? 'mock' : opts.provider;
    const { kernel, llmName } = createKernel(resolution.projectPath, { provider, model: opts.model, stream: true });
    console.log(chalk.bold('\n🚀 Tik - Starting Task\n'));
    if (resolution.isWorkspace) {
        console.log(chalk.dim(`  Workspace: ${resolution.workspace.name}`));
    }
    console.log(chalk.dim(`  Project: ${resolution.projectPath}`));
    console.log(chalk.dim(`  LLM: ${llmName} | Mode: ${opts.mode} | Strategy: ${opts.strategy} | Max: ${opts.maxIterations} iterations\n`));
    const unsub = kernel.eventBus.onAny((event) => {
        displayEvent(event);
    });
    const spinner = ora('Executing task...').start();
    try {
        const result = await kernel.submitTask({
            description,
            projectPath: resolution.projectPath,
            strategy: opts.strategy,
            maxIterations: parseInt(opts.maxIterations),
            mode: opts.mode,
        });
        spinner.stop();
        displayTaskResult(result);
    }
    catch (err) {
        spinner.fail(`Task failed: ${err.message}`);
    }
    finally {
        unsub();
        kernel.dispose();
    }
});
// ── tik plan ─────────────────────────────────────────────────
program
    .command('plan')
    .description('Generate a plan without executing')
    .argument('<description>', 'Task description')
    .option('-p, --project <path>', 'Explicit project path')
    .option('-t, --target <name>', 'Target project in workspace')
    .option('--provider <provider>', planningProviderHelp, 'codex')
    .option('--model <model>', 'Override model name')
    .option('--mock', 'Force mock LLM')
    .addHelpText('after', `

Examples:
  tik plan "设计缓存方案" --provider claude
  tik plan "review this refactor" --provider codex
`)
    .action(async (description, opts) => {
    const resolution = await resolveProjectPath(opts);
    const provider = opts.mock ? 'mock' : opts.provider;
    const { kernel } = createKernel(resolution.projectPath, { provider, model: opts.model });
    console.log(chalk.bold('\n📋 Generating Plan\n'));
    if (resolution.isWorkspace) {
        console.log(chalk.dim(`  Workspace: ${resolution.workspace.name} | Project: ${resolution.projectPath}\n`));
    }
    const task = await kernel.planTask({ description, projectPath: resolution.projectPath });
    displayTask(task);
    kernel.dispose();
});
// ── tik agent ────────────────────────────────────────────────
program
    .command('agent')
    .description('Manage agents')
    .argument('[subcommand]', 'Subcommand: list')
    .action(async (subcommand) => {
    if (!subcommand || subcommand === 'list') {
        // List registered agents
        const resolution = await workspaceResolver.resolve(process.cwd());
        const { kernel } = createKernel(resolution.projectPath, { provider: 'mock' });
        console.log(chalk.bold('\n🤖 Registered Agents\n'));
        const agents = kernel.agentRegistry.list();
        if (agents.length === 0) {
            console.log(chalk.gray('  No agents registered.'));
        }
        else {
            for (const agent of agents) {
                console.log(`  ${chalk.cyan(agent.id.padEnd(12))} ${chalk.dim(agent.role.padEnd(10))} ${agent.metadata?.description || ''}`);
                if (agent.metadata?.version) {
                    console.log(`  ${' '.repeat(12)} ${chalk.gray(`v${agent.metadata.version}`)}`);
                }
            }
        }
        console.log('');
        kernel.dispose();
    }
    else {
        console.log(chalk.red(`\n  Unknown subcommand: ${subcommand}`));
        console.log(chalk.dim('  Available: list\n'));
    }
});
registerWorktreeCommands(program, {
    resolveProjectPath,
    workspaceOrchestrator,
    workspaceWorktreeManager,
    selectWorkspaceProjectSnapshot,
    selectManagedWorktreeEntry,
});
program
    .command('workspace')
    .alias('ws')
    .description('Show workspace info or run Workspace SDD Phase 0 split')
    .argument('[subcommand]', 'Subcommand: info, run, status, board, next, clarify, specify, plan-phase, ace, feedback, report, retry, policy, decisions, decide')
    .option('--demand <text>', 'Workspace-level demand to split into project tasks')
    .option('-p, --project <path>', 'Explicit project or workspace path')
    .option('-t, --target <name>', 'Target project in workspace')
    .option('--workflow-profile <profile>', 'Workflow policy profile: balanced, fast-feedback, deep-verify')
    .option('--non-git <strategy>', 'Worktree policy for non-git projects: block, source, copy')
    .option('--message <text>', 'Workspace feedback message')
    .option('--projects <names>', 'Comma-separated project names for workspace feedback')
    .option('--next-phase <phase>', 'Next phase after feedback: PARALLEL_CLARIFY, PARALLEL_SPECIFY, PARALLEL_PLAN, or PARALLEL_ACE', 'PARALLEL_PLAN')
    .option('--id <decisionId>', 'Workspace decision id')
    .option('--option <optionId>', 'Workspace decision option id')
    .option('--provider <provider>', interactiveProviderHelp, 'codex')
    .option('--model <model>', 'Override model name')
    .option('--mock', 'Force mock LLM')
    .action(async (subcommand, opts) => {
    let command = subcommand || 'info';
    const autoAdvance = command === 'next';
    let implicitProjects = opts.projects;
    const resolution = await resolveProjectPath(opts);
    try {
        const workflowPolicy = resolveWorkspacePolicyOption(opts.workflowProfile);
        const worktreePolicy = resolveWorkspaceWorktreePolicyOption(opts.nonGit);
        while (true) {
            if (command === 'run') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace run requires a .code-workspace root.\n'));
                    return;
                }
                if (!opts.demand) {
                    console.log(chalk.red('\n  Missing --demand for workspace run.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.bootstrap({
                    resolution,
                    demand: opts.demand,
                    workflowPolicy,
                });
                console.log(chalk.bold('\n🧩 Workspace Split Initialized\n'));
                console.log(chalk.dim(`  Workspace: ${resolution.workspace.name}`));
                console.log(chalk.dim(`  Root: ${resolution.workspace.rootPath}`));
                console.log(chalk.dim(`  File: ${resolution.workspace.workspaceFile}`));
                console.log(chalk.dim(`  Active Project: ${resolution.projectPath}`));
                console.log(chalk.dim(`  Phase: ${snapshot.state?.currentPhase || 'WORKSPACE_SPLIT'}\n`));
                if (snapshot.settings?.workflowPolicy?.profile) {
                    console.log(chalk.dim(`  Workflow Profile: ${snapshot.settings.workflowPolicy.profile}\n`));
                }
                console.log(chalk.bold('  Project Demand Mapping:'));
                for (const item of snapshot.splitDemands?.items || []) {
                    console.log(`    ${chalk.cyan(item.projectName)}  ${chalk.dim(item.reason)}`);
                }
                console.log('');
                console.log(chalk.dim(`  Wrote ${resolution.workspace.rootPath}/.workspace/settings.json`));
                console.log(chalk.dim(`  Wrote ${resolution.workspace.rootPath}/.workspace/state.json`));
                console.log(chalk.dim(`  Wrote ${resolution.workspace.rootPath}/.workspace/split-demands.json\n`));
                console.log(chalk.bold('  Next step:'));
                console.log(chalk.dim(`    tik workspace next --provider ${(opts.mock ? 'mock' : opts.provider)}\n`));
                return;
            }
            if (command === 'status') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace status requires a .code-workspace root.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                printWorkspaceStatus(snapshot, resolution.workspace.rootPath, opts.projects);
                return;
            }
            if (command === 'board') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace board requires a .code-workspace root.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                printWorkspaceBoard(snapshot, resolution.workspace.rootPath, opts.projects);
                return;
            }
            if (command === 'next') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace next requires a .code-workspace root.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const nextPhase = snapshot.state?.currentPhase;
                if (!nextPhase) {
                    console.log(chalk.yellow('\n  No workspace phase found. Run `tik workspace run --demand "..."` first.\n'));
                    return;
                }
                if (nextPhase === 'PARALLEL_CLARIFY' || nextPhase === 'PARALLEL_SPECIFY' || nextPhase === 'PARALLEL_PLAN' || nextPhase === 'PARALLEL_ACE') {
                    command = workspacePhaseToCommand(nextPhase);
                }
                else if (nextPhase === 'FEEDBACK_ITERATION') {
                    const feedbackNext = snapshot.state?.workspaceFeedback?.nextPhase;
                    const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state);
                    if (pendingDecisions.length > 0) {
                        console.log(chalk.yellow('\n  Workspace is waiting on human decisions.\n'));
                        console.log(chalk.dim('  Review `tik workspace decisions` and use `tik workspace decide --id ... --option ... [--message ...]`.\n'));
                        return;
                    }
                    if (!feedbackNext) {
                        console.log(chalk.yellow('\n  Workspace is in FEEDBACK_ITERATION.\n'));
                        console.log(chalk.dim('  Review `tik workspace status` and use `tik workspace feedback --message ... --projects ... --next-phase PARALLEL_CLARIFY|PARALLEL_SPECIFY|PARALLEL_PLAN|PARALLEL_ACE`.\n'));
                        return;
                    }
                    if (!implicitProjects && snapshot.state?.workspaceFeedback?.affectedProjects?.length) {
                        implicitProjects = snapshot.state.workspaceFeedback.affectedProjects.join(',');
                    }
                    await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, feedbackNext);
                    command = workspacePhaseToCommand(feedbackNext);
                }
                else if (nextPhase === 'COMPLETED') {
                    console.log(chalk.green('\n  Workspace flow is already completed.\n'));
                    return;
                }
            }
            if (command === 'retry') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace retry requires a .code-workspace root.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const retryPhase = snapshot.state?.workspaceFeedback?.nextPhase || snapshot.state?.currentPhase;
                if (getPendingWorkspaceDecisions(snapshot.state).length > 0) {
                    console.log(chalk.yellow('\n  Workspace retry is blocked by pending human decisions.\n'));
                    console.log(chalk.dim('  Resolve them first with `tik workspace decisions` and `tik workspace decide --id ...`.\n'));
                    return;
                }
                if (!retryPhase || retryPhase === 'FEEDBACK_ITERATION' || retryPhase === 'COMPLETED' || retryPhase === 'WORKSPACE_SPLIT') {
                    console.log(chalk.yellow('\n  No retryable workspace phase found.\n'));
                    console.log(chalk.dim('  Use `tik workspace status` to inspect the current phase and feedback.\n'));
                    return;
                }
                if (snapshot.state?.workspaceFeedback?.required && (retryPhase === 'PARALLEL_CLARIFY' || retryPhase === 'PARALLEL_SPECIFY' || retryPhase === 'PARALLEL_PLAN' || retryPhase === 'PARALLEL_ACE')) {
                    if (!implicitProjects && snapshot.state.workspaceFeedback.affectedProjects?.length) {
                        implicitProjects = snapshot.state.workspaceFeedback.affectedProjects.join(',');
                    }
                    await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, retryPhase);
                }
                command = workspacePhaseToCommand(retryPhase);
            }
            if (command === 'report') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace report requires a .code-workspace root.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                printWorkspaceReport(snapshot, resolution.workspace.rootPath, opts.projects);
                return;
            }
            if (command === 'policy') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace policy requires a .code-workspace root.\n'));
                    return;
                }
                if (workflowPolicy || worktreePolicy) {
                    let snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                    if (workflowPolicy) {
                        snapshot = await workspaceOrchestrator.updateWorkflowPolicy(resolution.workspace.rootPath, workflowPolicy);
                    }
                    if (worktreePolicy) {
                        snapshot = await workspaceOrchestrator.updateWorktreePolicy(resolution.workspace.rootPath, worktreePolicy);
                    }
                    const policy = snapshot.settings?.workflowPolicy;
                    const worktree = snapshot.settings?.worktreePolicy;
                    console.log(chalk.bold('\n🧪 Workspace Policy Updated\n'));
                    if (policy?.profile) {
                        console.log(chalk.dim(`  Workflow Profile: ${policy.profile}`));
                    }
                    if (policy?.phaseBudgetsMs) {
                        console.log(chalk.dim(`  Phase Budgets: clarify=${policy.phaseBudgetsMs.PARALLEL_CLARIFY}ms, specify=${policy.phaseBudgetsMs.PARALLEL_SPECIFY}ms, plan=${policy.phaseBudgetsMs.PARALLEL_PLAN}ms, ace=${policy.phaseBudgetsMs.PARALLEL_ACE}ms`));
                    }
                    if (worktree) {
                        console.log(chalk.dim(`  Worktree Mode: ${worktree.mode || 'managed'}`));
                        console.log(chalk.dim(`  Non-git Strategy: ${worktree.nonGitStrategy || 'source'}`));
                    }
                    console.log('');
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const policy = snapshot.settings?.workflowPolicy;
                const worktree = snapshot.settings?.worktreePolicy;
                console.log(chalk.bold('\n🧪 Workspace Policy\n'));
                if (policy?.profile) {
                    console.log(chalk.dim(`  Workflow Profile: ${policy.profile}`));
                }
                if (policy?.phaseBudgetsMs) {
                    console.log(chalk.dim(`  Phase Budgets: clarify=${policy.phaseBudgetsMs.PARALLEL_CLARIFY}ms, specify=${policy.phaseBudgetsMs.PARALLEL_SPECIFY}ms, plan=${policy.phaseBudgetsMs.PARALLEL_PLAN}ms, ace=${policy.phaseBudgetsMs.PARALLEL_ACE}ms`));
                }
                if (policy?.maxFeedbackRetriesPerPhase) {
                    console.log(chalk.dim(`  Feedback Retries: clarify=${policy.maxFeedbackRetriesPerPhase.PARALLEL_CLARIFY}, specify=${policy.maxFeedbackRetriesPerPhase.PARALLEL_SPECIFY}, plan=${policy.maxFeedbackRetriesPerPhase.PARALLEL_PLAN}, ace=${policy.maxFeedbackRetriesPerPhase.PARALLEL_ACE}`));
                }
                if (worktree) {
                    console.log(chalk.dim(`  Worktree Mode: ${worktree.mode || 'managed'}`));
                    console.log(chalk.dim(`  Worktree Root: ${worktree.worktreeRoot || path.join(resolution.workspace.rootPath, '.workspace', 'worktrees')}`));
                    console.log(chalk.dim(`  Non-git Strategy: ${worktree.nonGitStrategy || 'source'}`));
                }
                console.log('');
                return;
            }
            if (command === 'decisions') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace decisions requires a .code-workspace root.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                printWorkspaceDecisions(snapshot);
                return;
            }
            if (command === 'decide') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace decide requires a .code-workspace root.\n'));
                    return;
                }
                if (!opts.id) {
                    console.log(chalk.red('\n  Missing --id for workspace decide.\n'));
                    return;
                }
                const snapshot = await workspaceOrchestrator.resolveDecision(resolution.workspace.rootPath, {
                    decisionId: opts.id,
                    optionId: opts.option,
                    message: opts.message,
                });
                const resolved = snapshot.state?.decisions?.find((decision) => decision.id === opts.id);
                console.log(chalk.bold('\n🪄 Workspace Decision Recorded\n'));
                if (resolved?.title)
                    console.log(chalk.dim(`  Decision: ${resolved.title}`));
                if (resolved?.resolution?.optionId)
                    console.log(chalk.dim(`  Option: ${resolved.resolution.optionId}`));
                if (resolved?.resolution?.nextPhase)
                    console.log(chalk.dim(`  Next phase: ${resolved.resolution.nextPhase}`));
                if (resolved?.resolution?.message)
                    console.log(chalk.dim(`  Message: ${resolved.resolution.message}`));
                console.log(chalk.dim('\n  Continue with: tik workspace next\n'));
                return;
            }
            if (command === 'clarify') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace clarify requires a .code-workspace root.\n'));
                    return;
                }
                const provider = opts.mock ? 'mock' : opts.provider;
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const selectedProjectNames = parseProjectNames(implicitProjects);
                if (snapshot.state?.workspaceFeedback?.required && selectedProjectNames.length === 0) {
                    await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, 'PARALLEL_CLARIFY');
                }
                const items = selectWorkspaceItems(snapshot, selectedProjectNames.length > 0
                    ? implicitProjects
                    : snapshot.state?.workspaceFeedback?.affectedProjects?.join(','));
                if (items.length === 0) {
                    console.log(chalk.red('\n  No matching workspace projects found for clarify.\n'));
                    return;
                }
                console.log(chalk.bold('\n🧭 Parallel Clarify\n'));
                printWorkspacePhaseKickoff('Parallel Clarify', resolution.workspace.rootPath, provider, items, provider);
                const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
                const outcome = await engine.runPhase({
                    phase: 'PARALLEL_CLARIFY',
                    resolution: { workspace: resolution.workspace },
                    snapshot: snapshot,
                    items,
                    provider,
                    model: opts.model,
                    autoAdvance,
                    reporter: createWorkspacePhaseReporter(),
                });
                for (const result of outcome.projectResults) {
                    if (result.status === 'completed') {
                        console.log(`  ${chalk.cyan(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.gray('(mode=native)')}`);
                    }
                    else {
                        console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.red(result.reasonLabel || '(clarification required)')}`);
                    }
                }
                console.log('');
                if (!autoAdvance)
                    return;
                if (outcome.completed) {
                    console.log(chalk.green('  Workspace flow completed.\n'));
                    return;
                }
                if (outcome.requiresFeedback) {
                    console.log(chalk.yellow('  Workspace flow requires clarification decisions before continuing.\n'));
                    return;
                }
                if (outcome.nextPhase) {
                    command = workspacePhaseToCommand(outcome.nextPhase);
                    console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
                    continue;
                }
                return;
            }
            if (command === 'specify') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace specify requires a .code-workspace root.\n'));
                    return;
                }
                const provider = opts.mock ? 'mock' : opts.provider;
                const phaseProvider = resolveWorkspacePhaseProvider(provider, 'PARALLEL_SPECIFY');
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const items = selectWorkspaceItems(snapshot, implicitProjects);
                if (items.length === 0) {
                    console.log(chalk.red('\n  No matching workspace projects found for specify.\n'));
                    return;
                }
                console.log(chalk.bold('\n📝 Parallel Specify\n'));
                printWorkspacePhaseKickoff('Parallel Specify', resolution.workspace.rootPath, provider, items, phaseProvider);
                const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
                const outcome = await engine.runPhase({
                    phase: 'PARALLEL_SPECIFY',
                    resolution: { workspace: resolution.workspace },
                    snapshot: snapshot,
                    items,
                    provider,
                    model: opts.model,
                    autoAdvance,
                    reporter: createWorkspacePhaseReporter(),
                });
                for (const result of outcome.projectResults) {
                    if (result.status === 'completed') {
                        const modeLabel = result.reused ? 'reused' : 'mode=native';
                        console.log(`  ${chalk.cyan(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.gray(`(${modeLabel})`)}`);
                    }
                    else {
                        console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.red(result.reasonLabel || '(blocked)')}`);
                    }
                }
                console.log('');
                if (!autoAdvance)
                    return;
                if (outcome.completed) {
                    console.log(chalk.green('  Workspace flow completed.\n'));
                    return;
                }
                if (outcome.requiresFeedback) {
                    console.log(chalk.yellow('  Workspace flow requires feedback before continuing.\n'));
                    return;
                }
                if (outcome.nextPhase) {
                    command = workspacePhaseToCommand(outcome.nextPhase);
                    console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
                    continue;
                }
                return;
            }
            if (command === 'plan-phase') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace plan-phase requires a .code-workspace root.\n'));
                    return;
                }
                const provider = opts.mock ? 'mock' : opts.provider;
                const phaseProvider = resolveWorkspacePhaseProvider(provider, 'PARALLEL_PLAN');
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const selectedProjectNames = parseProjectNames(implicitProjects);
                if (snapshot.state?.workspaceFeedback?.required) {
                    await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, 'PARALLEL_PLAN');
                }
                const items = selectWorkspaceItems(snapshot, selectedProjectNames.length > 0
                    ? implicitProjects
                    : snapshot.state?.workspaceFeedback?.affectedProjects?.join(','));
                const projectStateByName = new Map((snapshot.state?.projects || []).map((project) => [project.projectName, project]));
                if (items.length === 0) {
                    console.log(chalk.red('\n  No matching workspace projects found for plan-phase.\n'));
                    return;
                }
                console.log(chalk.bold('\n🗺 Parallel Plan\n'));
                printWorkspacePhaseKickoff('Parallel Plan', resolution.workspace.rootPath, provider, items, phaseProvider);
                const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
                const outcome = await engine.runPhase({
                    phase: 'PARALLEL_PLAN',
                    resolution: { workspace: resolution.workspace },
                    snapshot: snapshot,
                    items,
                    provider,
                    model: opts.model,
                    autoAdvance,
                    reporter: createWorkspacePhaseReporter(),
                });
                for (const result of outcome.projectResults) {
                    if (result.status === 'completed') {
                        const modeLabel = result.reused ? 'reused' : 'mode=native';
                        console.log(`  ${chalk.cyan(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.gray(`(${modeLabel})`)}`);
                    }
                    else {
                        console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.outputPath || '')} ${chalk.red(result.reasonLabel || '(blocked)')}`);
                    }
                }
                console.log('');
                if (!autoAdvance)
                    return;
                if (outcome.completed) {
                    console.log(chalk.green('  Workspace flow completed.\n'));
                    return;
                }
                if (outcome.requiresFeedback) {
                    console.log(chalk.yellow('  Workspace flow requires feedback before continuing.\n'));
                    return;
                }
                if (outcome.nextPhase) {
                    command = workspacePhaseToCommand(outcome.nextPhase);
                    console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
                    continue;
                }
                return;
            }
            if (command === 'ace') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace ace requires a .code-workspace root.\n'));
                    return;
                }
                const provider = opts.mock ? 'mock' : opts.provider;
                const phaseProvider = resolveWorkspacePhaseProvider(provider, 'PARALLEL_ACE');
                const snapshot = await workspaceOrchestrator.getStatus(resolution.workspace.rootPath);
                const selectedProjectNames = parseProjectNames(implicitProjects);
                if (snapshot.state?.workspaceFeedback?.required && snapshot.state.workspaceFeedback.affectedProjects?.length === 0) {
                    await workspaceOrchestrator.clearFeedback(resolution.workspace.rootPath, 'PARALLEL_ACE');
                }
                const items = selectWorkspaceItems(snapshot, selectedProjectNames.length > 0
                    ? implicitProjects
                    : snapshot.state?.workspaceFeedback?.affectedProjects?.join(','));
                if (items.length === 0) {
                    console.log(chalk.red('\n  No matching workspace projects found for ACE.\n'));
                    return;
                }
                console.log(chalk.bold('\n⚙ Parallel ACE\n'));
                printWorkspacePhaseKickoff('Parallel ACE', resolution.workspace.rootPath, provider, items, phaseProvider);
                const engine = createWorkspaceWorkflowEngineInstance(resolution.workspace.rootPath, snapshot.settings?.workflowPolicy);
                const outcome = await engine.runPhase({
                    phase: 'PARALLEL_ACE',
                    resolution: { workspace: resolution.workspace },
                    snapshot: snapshot,
                    items,
                    provider,
                    model: opts.model,
                    autoAdvance,
                    reporter: createWorkspacePhaseReporter(),
                });
                for (const result of outcome.projectResults) {
                    if (result.status === 'completed') {
                        console.log(`  ${chalk.cyan(result.projectName)} -> completed ${chalk.dim(result.taskId || '')} ${chalk.gray('(mode=native)')}`);
                    }
                    else {
                        console.log(`  ${chalk.yellow(result.projectName)} -> ${chalk.dim(result.taskId || '')} ${chalk.red(result.reasonLabel || '(blocked)')}`);
                    }
                }
                console.log('');
                if (!autoAdvance)
                    return;
                if (outcome.completed) {
                    console.log(chalk.green('  Workspace flow completed.\n'));
                    return;
                }
                if (outcome.requiresFeedback) {
                    console.log(chalk.yellow('  Workspace flow requires feedback before continuing.\n'));
                    return;
                }
                if (outcome.nextPhase) {
                    command = workspacePhaseToCommand(outcome.nextPhase);
                    console.log(chalk.dim(`  Auto-advancing to ${outcome.nextPhase}...\n`));
                    continue;
                }
                return;
            }
            if (command === 'feedback') {
                if (!resolution.workspace) {
                    console.log(chalk.red('\n  Workspace feedback requires a .code-workspace root.\n'));
                    return;
                }
                if (!opts.message) {
                    console.log(chalk.red('\n  Missing --message for workspace feedback.\n'));
                    return;
                }
                const affectedProjects = (opts.projects || '')
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);
                const nextPhase = opts.nextPhase === 'PARALLEL_ACE'
                    ? 'PARALLEL_ACE'
                    : opts.nextPhase === 'PARALLEL_CLARIFY'
                        ? 'PARALLEL_CLARIFY'
                        : opts.nextPhase === 'PARALLEL_SPECIFY'
                            ? 'PARALLEL_SPECIFY'
                            : 'PARALLEL_PLAN';
                await workspaceOrchestrator.recordFeedback(resolution.workspace.rootPath, opts.message, affectedProjects, nextPhase);
                console.log(chalk.bold('\n🪄 Workspace Feedback Recorded\n'));
                console.log(chalk.dim(`  Next phase: ${nextPhase}`));
                console.log(chalk.dim(`  Affected projects: ${affectedProjects.join(', ') || '(none)'}`));
                console.log(chalk.dim(`  Message: ${opts.message}\n`));
                return;
            }
            if (command !== 'info') {
                console.log(chalk.red(`\n  Unknown workspace subcommand: ${command}`));
                console.log(chalk.dim('  Available: info, run, status, board, next, clarify, specify, plan-phase, ace, feedback, report, retry, policy, decisions, decide\n'));
                return;
            }
            if (!resolution.workspace) {
                console.log(chalk.bold('\n📁 No Workspace\n'));
                console.log(chalk.dim('  No .code-workspace file found.'));
                console.log(chalk.dim(`  Current directory: ${process.cwd()}\n`));
                console.log(chalk.dim('  Create a .code-workspace file to enable multi-project mode.\n'));
                return;
            }
            const ws = resolution.workspace;
            console.log(chalk.bold(`\n📁 Workspace: ${ws.name}\n`));
            console.log(`  Root:  ${ws.rootPath}`);
            console.log(`  File:  ${ws.workspaceFile}`);
            console.log('');
            console.log(chalk.bold('  Projects:'));
            for (const p of ws.projects) {
                const isCurrent = resolution.projectPath === p.path;
                const marker = isCurrent ? chalk.green(' ← active') : '';
                console.log(`    ${chalk.cyan(p.name.padEnd(20))} ${chalk.dim(p.path)}${marker}`);
            }
            console.log('');
            if (ws.config.strategy || ws.config.maxIterations) {
                console.log(chalk.bold('  Config:'));
                if (ws.config.strategy)
                    console.log(`    Strategy: ${ws.config.strategy}`);
                if (ws.config.maxIterations)
                    console.log(`    Max iterations: ${ws.config.maxIterations}`);
                console.log('');
            }
            return;
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`\n  Workspace command failed: ${message}\n`));
        return;
    }
});
// ── tik status ───────────────────────────────────────────────
program
    .command('status')
    .description('Check task status')
    .argument('[taskId]', 'Task ID')
    .option('--api <url>', 'API server URL', DEFAULT_API_BASE_URL)
    .action(async (taskId, opts) => {
    console.log(chalk.bold('\n📌 Task Status\n'));
    try {
        if (taskId) {
            const res = await fetch(`${opts.api}/api/tasks/${taskId}`);
            if (!res.ok) {
                console.log(chalk.red(`  Task ${taskId} not found`));
                return;
            }
            displayTask(await res.json());
        }
        else {
            const res = await fetch(`${opts.api}/api/tasks`);
            const tasks = await res.json();
            if (tasks.length === 0) {
                console.log(chalk.gray('  No tasks. Submit one with: tik run "<description>"'));
            }
            else {
                for (const task of tasks)
                    displayTask(task);
            }
        }
    }
    catch {
        console.log(chalk.yellow('  Cannot connect to API server. Start with: tik serve'));
    }
});
// ── tik logs ─────────────────────────────────────────────────
program
    .command('logs')
    .description('Stream execution events')
    .argument('<taskId>', 'Task ID')
    .option('--api <url>', 'API server URL', DEFAULT_API_BASE_URL)
    .action(async (taskId, opts) => {
    console.log(chalk.bold(`\n📜 Event Stream: ${taskId}\n`));
    try {
        const response = await fetch(`${opts.api}/api/tasks/${taskId}/events`);
        if (!response.body) {
            console.log(chalk.red('  No stream'));
            return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            for (const line of decoder.decode(value).split('\n')) {
                if (line.startsWith('data: ')) {
                    try {
                        displayEvent(JSON.parse(line.slice(6)));
                    }
                    catch { }
                }
            }
        }
    }
    catch {
        console.log(chalk.red('  Connection failed. Start server with: tik serve'));
    }
});
// ── tik eval ─────────────────────────────────────────────────
program
    .command('eval')
    .description('View evaluation metrics')
    .argument('<taskId>', 'Task ID')
    .option('--api <url>', 'API server URL', DEFAULT_API_BASE_URL)
    .action(async (taskId, opts) => {
    console.log(chalk.bold(`\n📊 Evaluation: ${taskId}\n`));
    try {
        const res = await fetch(`${opts.api}/api/tasks/${taskId}`);
        if (!res.ok) {
            console.log(chalk.red('  Task not found'));
            return;
        }
        const task = await res.json();
        for (const iter of (task.iterations || [])) {
            const e = iter.evaluation;
            console.log(`  Iteration ${iter.number}: fitness=${chalk.green(e.fitness.toFixed(3))} drift=${e.drift.toFixed(2)} entropy=${e.entropy.toFixed(3)}`);
        }
    }
    catch {
        console.log(chalk.yellow('  Cannot connect to API server. Start with: tik serve'));
    }
});
// ── tik stop ─────────────────────────────────────────────────
program
    .command('stop')
    .description('Stop a running task')
    .argument('<taskId>', 'Task ID')
    .option('--api <url>', 'API server URL', DEFAULT_API_BASE_URL)
    .action(async (taskId, opts) => {
    try {
        const res = await fetch(`${opts.api}/api/tasks/${taskId}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'stop' }),
        });
        console.log(res.ok ? chalk.green('\n  Task stopped') : chalk.red(`\n  Failed: ${(await res.json()).error}`));
    }
    catch {
        console.log(chalk.yellow('\n  Cannot connect to API server.'));
    }
});
// ── tik list ─────────────────────────────────────────────────
program
    .command('list')
    .description('List all tasks')
    .option('--api <url>', 'API server URL', DEFAULT_API_BASE_URL)
    .action(async (opts) => {
    console.log(chalk.bold('\n📋 Tasks\n'));
    try {
        const tasks = await (await fetch(`${opts.api}/api/tasks`)).json();
        if (tasks.length === 0) {
            console.log(chalk.gray('  No tasks.'));
        }
        else {
            for (const t of tasks) {
                const c = (t.status === 'converged' || t.status === 'completed')
                    ? chalk.green
                    : t.status === 'failed'
                        ? chalk.red
                        : chalk.cyan;
                console.log(`  ${c(t.status.padEnd(12))} ${t.id}  ${chalk.dim(t.description)}`);
            }
        }
    }
    catch {
        console.log(chalk.gray('  No tasks. Submit one with: tik run "<description>"'));
    }
});
// ── tik artifacts ────────────────────────────────────────────
program
    .command('artifacts [subcommand] [artifactId]')
    .description('List, inspect, create, and review workbench artifacts')
    .option('--api <url>', 'API server URL', DEFAULT_API_BASE_URL)
    .option('--task <taskId>', 'Filter by task or create from task')
    .option('--status <status>', 'Filter by artifact status')
    .option('--workspace <workspaceId>', 'Filter by workspace id')
    .option('--project <projectId>', 'Filter by project id')
    .option('--kind <kind>', 'Filter by artifact kind')
    .option('--tag <tag>', 'Filter by tag')
    .option('--template <template>', 'Template for create/generate', 'task-review')
    .option('--version <version>', 'Version id or number for open/export')
    .option('--reason <reason>', 'Rejection reason')
    .option('--message <message>', 'Review message')
    .option('--out <path>', 'Output path for export')
    .action(async (subcommand, artifactId, opts) => {
    const command = subcommand || 'list';
    const apiBase = opts.api.replace(/\/+$/, '');
    try {
        if (command === 'list') {
            const query = new URLSearchParams();
            if (opts.task)
                query.set('taskId', opts.task);
            if (opts.status)
                query.set('status', opts.status);
            if (opts.workspace)
                query.set('workspaceId', opts.workspace);
            if (opts.project)
                query.set('projectId', opts.project);
            if (opts.kind)
                query.set('kind', opts.kind);
            if (opts.tag)
                query.set('tag', opts.tag);
            const response = await fetch(`${apiBase}/api/workbench/artifacts${query.size ? `?${query}` : ''}`);
            const payload = await readArtifactResponse(response);
            console.log(formatArtifactList(payload.artifacts));
            return;
        }
        if (command === 'show') {
            if (!artifactId) {
                console.log(chalk.red('\n  Missing artifact id.\n'));
                return;
            }
            const response = await fetch(`${apiBase}/api/workbench/artifacts/${encodeURIComponent(artifactId)}`);
            const payload = await readArtifactResponse(response);
            console.log(formatArtifactShow(payload.artifact, apiBase));
            return;
        }
        if (command === 'create') {
            if (!opts.task) {
                console.log(chalk.red('\n  Missing --task for artifact creation.\n'));
                return;
            }
            const response = await fetch(`${apiBase}/api/workbench/tasks/${encodeURIComponent(opts.task)}/artifacts/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ template: opts.template || 'task-review' }),
            });
            const payload = await readArtifactResponse(response);
            console.log(formatArtifactShow(payload.artifact, apiBase));
            return;
        }
        if (command === 'accept' || command === 'archive') {
            if (!artifactId) {
                console.log(chalk.red('\n  Missing artifact id.\n'));
                return;
            }
            const response = await fetch(`${apiBase}/api/workbench/artifacts/${encodeURIComponent(artifactId)}/${command}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actor: 'cli', message: opts.message }),
            });
            const payload = await readArtifactResponse(response);
            console.log(formatArtifactShow(payload.artifact, apiBase));
            return;
        }
        if (command === 'reject') {
            if (!artifactId) {
                console.log(chalk.red('\n  Missing artifact id.\n'));
                return;
            }
            const reason = opts.reason || opts.message;
            if (!reason) {
                console.log(chalk.red('\n  Missing --reason for rejection.\n'));
                return;
            }
            const response = await fetch(`${apiBase}/api/workbench/artifacts/${encodeURIComponent(artifactId)}/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actor: 'cli', reason }),
            });
            const payload = await readArtifactResponse(response);
            console.log(formatArtifactShow(payload.artifact, apiBase));
            return;
        }
        if (command === 'open') {
            if (!artifactId) {
                console.log(chalk.red('\n  Missing artifact id.\n'));
                return;
            }
            console.log(buildArtifactDetailUrl(apiBase, artifactId));
            return;
        }
        if (command === 'export') {
            if (!artifactId || !opts.out) {
                console.log(chalk.red('\n  Missing artifact id or --out for export.\n'));
                return;
            }
            const artifactResponse = await fetch(`${apiBase}/api/workbench/artifacts/${encodeURIComponent(artifactId)}`);
            const artifactPayload = await readArtifactResponse(artifactResponse);
            const previewUrl = buildArtifactPreviewApiUrl(apiBase, artifactId, opts.version || artifactPayload.artifact.latestVersionId);
            const previewResponse = await fetch(previewUrl);
            if (!previewResponse.ok) {
                throw new Error(`Preview export failed: ${previewResponse.statusText}`);
            }
            const buffer = Buffer.from(await previewResponse.arrayBuffer());
            await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
            await fs.writeFile(path.resolve(opts.out), buffer);
            console.log(chalk.green(`Exported ${artifactId} to ${path.resolve(opts.out)}`));
            return;
        }
        console.log(chalk.red(`\n  Unknown artifacts subcommand: ${command}\n`));
    }
    catch (error) {
        console.log(chalk.red(`\n  Artifact command failed: ${error.message}\n`));
    }
});
// ── tik runs ─────────────────────────────────────────────────
program
    .command('runs [subcommand] [runId]')
    .description('Inspect agent run evidence and proof records')
    .option('-p, --project <path>', 'Workspace/project root', process.cwd())
    .option('--task <taskId>', 'List proofs for a workbench task')
    .action(async (subcommand, runId, opts) => {
    const command = subcommand || 'proof';
    const workspaceRoot = path.resolve(opts.project);
    const proofStore = new FileRunProofStore(workspaceRoot);
    try {
        if (command === 'proof') {
            if (opts.task) {
                const proofs = await proofStore.listProofsByTask(opts.task);
                if (!proofs.length) {
                    console.log(chalk.gray(`No run proofs found for task ${opts.task}.`));
                    return;
                }
                for (const proof of proofs) {
                    console.log(`${proof.runId}  attempt=${proof.attempt}  status=${proof.status}  risk=${proof.risk}  files=${proof.diff.filesChanged}`);
                }
                return;
            }
            if (!runId) {
                console.log(chalk.red('\n  Missing run id. Use `tik runs proof <runId>` or `tik runs proof --task <taskId>`.\n'));
                return;
            }
            const proof = await proofStore.readProof(runId).catch(() => null);
            if (!proof) {
                console.log(chalk.yellow(`No run proof found for ${runId}.`));
                return;
            }
            console.log([
                `Run: ${proof.runId}`,
                `Task: ${proof.taskId}`,
                `Attempt: ${proof.attempt}`,
                `Status: ${proof.status}`,
                `Risk: ${proof.risk}`,
                `Summary: ${proof.summary}`,
                `Files changed: ${proof.diff.filesChanged}`,
                `Changed files: ${proof.diff.changedFiles.length ? proof.diff.changedFiles.join(', ') : 'none'}`,
                `Artifacts: ${proof.producedArtifactIds.length ? proof.producedArtifactIds.join(', ') : 'none'}`,
            ].join('\n'));
            return;
        }
        console.log(chalk.red(`\n  Unknown runs subcommand: ${command}\n`));
    }
    catch (error) {
        console.log(chalk.red(`\n  Runs command failed: ${error.message}\n`));
    }
});
// ── tik update ───────────────────────────────────────────────
program
    .command('update')
    .description('Rebuild tik from source')
    .action(async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const execFileAsync = promisify(execFile);
    // Resolve tik project root (cli/dist/index.js → cli → packages → tik root)
    const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const tikRoot = path.resolve(cliDir, '../..');
    console.log(chalk.bold('\n🔄 Updating Tik\n'));
    console.log(chalk.dim(`  Source: ${tikRoot}\n`));
    try {
        const spinner = ora('Installing dependencies...').start();
        await execFileAsync('pnpm', ['install'], { cwd: tikRoot, timeout: 60_000 });
        spinner.text = 'Building packages...';
        const { stdout } = await execFileAsync('pnpm', ['build'], { cwd: tikRoot, timeout: 120_000 });
        spinner.stop();
        const match = stdout.match(/Tasks:\s+(\d+) successful/);
        console.log(chalk.green(`  ✅ Build complete (${match ? match[1] : '?'} packages)`));
        console.log(chalk.dim('  tik command is now up to date.\n'));
    }
    catch (err) {
        console.log(chalk.red(`  Build failed: ${err.message}`));
    }
});
registerTrackerCommands(program, { workspaceWorktreeManager });
registerWorkflowCommands(program);
registerServeCommand(program);
// ─── Parse & Run ─────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length === 0) {
    await program.parseAsync([process.argv[0] ?? 'node', process.argv[1] ?? 'tik', 'shell']);
}
else {
    await program.parseAsync();
}
function printWorkspaceStatus(snapshot, rootPath, projects) {
    const eventProjection = loadWorkspaceEventProjection(rootPath);
    console.log(chalk.bold('\n🗂 Workspace Status\n'));
    console.log(chalk.dim(`  Root: ${rootPath}`));
    if (!snapshot.state && !snapshot.settings && !snapshot.splitDemands) {
        console.log(chalk.yellow('\n  No .workspace state found. Run `tik workspace run --demand "..."` first.\n'));
        return;
    }
    if (snapshot.state) {
        console.log(chalk.dim(`  Phase: ${snapshot.state.currentPhase}`));
        console.log(chalk.dim(`  Active Projects: ${snapshot.state.activeProjectNames.join(', ') || '(none)'}`));
    }
    const workflowProfile = snapshot.settings?.workflowPolicy?.profile;
    if (workflowProfile) {
        console.log(chalk.dim(`  Workflow Profile: ${workflowProfile}`));
    }
    const visibleItems = selectWorkspaceItems(snapshot, projects);
    const selectedProjectNames = new Set(visibleItems.map((item) => item.projectName));
    if (visibleItems.length) {
        console.log(chalk.bold('\n  Split Demands:'));
        for (const item of visibleItems) {
            console.log(`    ${chalk.cyan(item.projectName)}  ${item.status}  ${chalk.dim(item.reason)}`);
        }
    }
    if (snapshot.state?.notes?.length) {
        console.log(chalk.bold('\n  Notes:'));
        for (const note of snapshot.state.notes) {
            console.log(`    ${chalk.dim(`- ${note}`)}`);
        }
    }
    if (snapshot.state?.workspaceFeedback?.required) {
        console.log(chalk.bold('\n  Workspace Feedback:'));
        console.log(`    ${chalk.yellow(snapshot.state.workspaceFeedback.reason || 'Feedback required')}`);
        if (snapshot.state.workspaceFeedback.affectedProjects?.length) {
            console.log(`    ${chalk.dim(`affected: ${snapshot.state.workspaceFeedback.affectedProjects.join(', ')}`)}`);
        }
        if (snapshot.state.workspaceFeedback.nextPhase) {
            console.log(`    ${chalk.dim(`next: ${snapshot.state.workspaceFeedback.nextPhase}`)}`);
        }
    }
    const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state);
    if (pendingDecisions.length > 0) {
        console.log(chalk.bold('\n  Pending Decisions:'));
        for (const decision of pendingDecisions) {
            console.log(`    ${chalk.magenta(decision.id)}  ${decision.kind}  ${chalk.cyan(decision.projectName || 'workspace')}  ${chalk.dim(decision.title)}`);
            console.log(`      ${chalk.dim(decision.prompt)}`);
            if (decision.confidence || decision.rationale) {
                const parts = [
                    decision.confidence ? `confidence=${decision.confidence}` : '',
                    decision.rationale || '',
                ].filter(Boolean);
                console.log(`      ${chalk.dim(parts.join(' | '))}`);
            }
            if (decision.signals?.length) {
                console.log(`      ${chalk.dim(`signals: ${decision.signals.join(', ')}`)}`);
            }
            if (decision.options?.length) {
                for (const option of decision.options) {
                    const marker = option.recommended ? '*' : '-';
                    console.log(`      ${chalk.dim(`${marker} ${option.id}: ${option.label}${option.nextPhase ? ` -> ${option.nextPhase}` : ''}`)}`);
                }
            }
            console.log(`      ${chalk.dim(`next: tik workspace decide --id ${decision.id}${decision.recommendedOptionId ? ` --option ${decision.recommendedOptionId}` : ''}${decision.allowFreeform ? ' --message "..."' : ''}`)}`);
        }
    }
    const visibleProjects = (snapshot.state?.projects || []).filter((project) => selectedProjectNames.size === 0 || selectedProjectNames.has(project.projectName));
    if (visibleProjects.length) {
        console.log(chalk.bold('\n  Project State:'));
        for (const project of visibleProjects) {
            console.log(`    ${chalk.cyan(project.projectName)}  ${project.phase}  ${project.status}`);
            if (project.sourceProjectPath)
                console.log(`      ${chalk.dim(`source: ${project.sourceProjectPath}`)}`);
            if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath) {
                console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
            }
            if (project.worktree?.status)
                console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
            if (project.worktree?.worktreeBranch)
                console.log(`      ${chalk.dim(`worktree-branch: ${project.worktree.worktreeBranch}`)}`);
            if (project.specPath)
                console.log(`      ${chalk.dim(`spec: ${project.specPath}`)}`);
            if (project.planPath)
                console.log(`      ${chalk.dim(`plan: ${project.planPath}`)}`);
            if (project.workflowContract)
                console.log(`      ${chalk.dim(`contract: ${project.workflowContract}`)}`);
            if (project.workflowRole)
                console.log(`      ${chalk.dim(`role: ${project.workflowRole}`)}`);
            if (project.workflowSkillName)
                console.log(`      ${chalk.dim(`skill: ${project.workflowSkillName}`)}`);
            if (project.workflowSkillPath)
                console.log(`      ${chalk.dim(`skill-path: ${project.workflowSkillPath}`)}`);
            if (project.executionMode)
                console.log(`      ${chalk.dim(`exec-mode: ${project.executionMode}`)}`);
            if (project.blockerKind)
                console.log(`      ${chalk.dim(`blocker: ${project.blockerKind}`)}`);
            if (project.taskId)
                console.log(`      ${chalk.dim(`task: ${project.taskId}`)}`);
            if (project.specTaskId)
                console.log(`      ${chalk.dim(`spec-task: ${project.specTaskId}`)}`);
            if (project.planTaskId)
                console.log(`      ${chalk.dim(`plan-task: ${project.planTaskId}`)}`);
            if (project.aceTaskId)
                console.log(`      ${chalk.dim(`ace-task: ${project.aceTaskId}`)}`);
            if (project.summary)
                console.log(`      ${chalk.dim(project.summary)}`);
            if (project.recommendedCommand)
                console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
        }
    }
    if (snapshot.state?.summary) {
        console.log(chalk.bold('\n  Summary:'));
        console.log(`    completed=${chalk.green(String(snapshot.state.summary.completedProjects))} blocked=${chalk.yellow(String(snapshot.state.summary.blockedProjects))} failed=${chalk.red(String(snapshot.state.summary.failedProjects))} total=${snapshot.state.summary.totalProjects}`);
        console.log(`    need-human=${chalk.magenta(String(snapshot.state.summary.needsHumanProjects))} replan=${chalk.yellow(String(snapshot.state.summary.replanProjects))}`);
    }
    if (eventProjection.totalEvents > 0) {
        console.log(chalk.bold('\n  Recent Events:'));
        for (const event of eventProjection.recentDisplay.slice(-5)) {
            const scope = event.projectName ? `${event.projectName} / ` : '';
            const repeat = event.count > 1 ? ` x${event.count}` : '';
            console.log(`    ${chalk.dim(`${scope}${event.phase} ${event.kind}${repeat} :: ${event.message}`)}`);
        }
    }
    console.log('');
}
function resolveWorkspacePolicyOption(profile) {
    if (!profile)
        return undefined;
    const normalized = profile.trim();
    if (!['balanced', 'fast-feedback', 'deep-verify'].includes(normalized)) {
        throw new Error(`Unsupported workflow profile: ${profile}. Use balanced, fast-feedback, or deep-verify.`);
    }
    return { profile: normalized };
}
function resolveWorkspaceWorktreePolicyOption(nonGit) {
    if (!nonGit)
        return undefined;
    const normalized = nonGit.trim();
    if (normalized !== 'block' && normalized !== 'source' && normalized !== 'copy') {
        throw new Error(`Unsupported non-git worktree strategy: ${nonGit}. Use block, source, or copy.`);
    }
    return { nonGitStrategy: normalized };
}
function printWorkspaceBoard(snapshot, rootPath, projects) {
    const eventProjection = loadWorkspaceEventProjection(rootPath);
    console.log(chalk.bold('\n🧭 Workspace Board\n'));
    console.log(chalk.dim(`  Root: ${rootPath}`));
    console.log(chalk.dim(`  Phase: ${snapshot.state?.currentPhase || 'WORKSPACE_SPLIT'}`));
    const visibleItems = selectWorkspaceItems(snapshot, projects);
    const selectedProjectNames = new Set(visibleItems.map((item) => item.projectName));
    const visibleProjects = (snapshot.state?.projects || []).filter((project) => selectedProjectNames.size === 0 || selectedProjectNames.has(project.projectName));
    const needsHuman = visibleProjects.filter((project) => project.blockerKind === 'NEED_HUMAN');
    const replan = visibleProjects.filter((project) => project.blockerKind === 'REPLAN');
    const healthy = visibleProjects.filter((project) => !project.blockerKind);
    if (needsHuman.length) {
        console.log(chalk.bold('\n  Need Human:'));
        for (const project of needsHuman) {
            console.log(`    ${chalk.magenta(project.projectName)}  ${project.phase}  ${project.status}`);
            if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath)
                console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
            if (project.worktree?.status)
                console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
            if (project.summary)
                console.log(`      ${chalk.dim(project.summary)}`);
            if (project.recommendedCommand)
                console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
        }
    }
    const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state).filter((decision) => selectedProjectNames.size === 0 || !decision.projectName || selectedProjectNames.has(decision.projectName));
    if (pendingDecisions.length) {
        console.log(chalk.bold('\n  Pending Decisions:'));
        for (const decision of pendingDecisions) {
            console.log(`    ${chalk.magenta(decision.id)}  ${decision.kind}  ${chalk.cyan(decision.projectName || 'workspace')}`);
            console.log(`      ${chalk.dim(decision.title)}`);
            if (decision.confidence) {
                console.log(`      ${chalk.dim(`confidence: ${decision.confidence}`)}`);
            }
            if (decision.rationale) {
                console.log(`      ${chalk.dim(decision.rationale)}`);
            }
            if (decision.recommendedOptionId) {
                console.log(`      ${chalk.dim(`recommended: ${decision.recommendedOptionId}`)}`);
            }
            console.log(`      ${chalk.dim(`next: tik workspace decide --id ${decision.id}${decision.recommendedOptionId ? ` --option ${decision.recommendedOptionId}` : ''}${decision.allowFreeform ? ' --message "..."' : ''}`)}`);
        }
    }
    if (replan.length) {
        console.log(chalk.bold('\n  Replan Required:'));
        for (const project of replan) {
            console.log(`    ${chalk.yellow(project.projectName)}  ${project.phase}  ${project.status}`);
            if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath)
                console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
            if (project.worktree?.status)
                console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
            if (project.summary)
                console.log(`      ${chalk.dim(project.summary)}`);
            if (project.recommendedCommand)
                console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
        }
    }
    if (healthy.length) {
        const healthyHeading = healthy.every((project) => project.status === 'completed')
            ? 'Healthy / Completed:'
            : 'Healthy / In Flight:';
        console.log(chalk.bold(`\n  ${healthyHeading}`));
        for (const project of healthy) {
            console.log(`    ${chalk.cyan(project.projectName)}  ${project.phase}  ${project.status}`);
            if (project.effectiveProjectPath && project.effectiveProjectPath !== project.sourceProjectPath)
                console.log(`      ${chalk.dim(`exec: ${project.effectiveProjectPath}`)}`);
            if (project.worktree?.status)
                console.log(`      ${chalk.dim(`worktree: ${project.worktree.status}`)}`);
            if (project.workflowContract)
                console.log(`      ${chalk.dim(`contract: ${project.workflowContract}`)}`);
            if (project.workflowRole)
                console.log(`      ${chalk.dim(`role: ${project.workflowRole}`)}`);
            if (project.executionMode)
                console.log(`      ${chalk.dim(`exec-mode: ${project.executionMode}`)}`);
            if (project.recommendedCommand)
                console.log(`      ${chalk.dim(`next: ${project.recommendedCommand}`)}`);
            const projectEvents = eventProjection.projects.find((entry) => entry.projectName === project.projectName);
            if (projectEvents?.lastMessage)
                console.log(`      ${chalk.dim(`last-event: ${projectEvents.lastMessage}`)}`);
        }
    }
    if (visibleProjects.length === 0) {
        console.log(chalk.dim('\n  No matching workspace projects.\n'));
        return;
    }
    console.log('');
}
function workspacePhaseToCommand(phase) {
    if (phase === 'PARALLEL_CLARIFY')
        return 'clarify';
    if (phase === 'PARALLEL_SPECIFY')
        return 'specify';
    if (phase === 'PARALLEL_PLAN')
        return 'plan-phase';
    return 'ace';
}
function printWorkspaceExplanation(explanation) {
    console.log('\n## Explanation');
    console.log(`- Status: ${explanation.status}`);
    console.log(`- Confidence: ${explanation.confidence}`);
    console.log(`- Summary: ${explanation.summary}`);
    if (explanation.whyThisStatus.length > 0) {
        console.log('\n### Why this status');
        for (const reason of explanation.whyThisStatus) {
            console.log(`- ${reason}`);
        }
    }
    if (explanation.phases.length > 0) {
        console.log('\n### Phase Summary');
        for (const phase of explanation.phases) {
            const project = phase.projectName ? `${phase.projectName}:` : '';
            console.log(`- ${project}${phase.phase} (${phase.status}) ${phase.summary}`);
        }
    }
    if (explanation.changedFiles.length > 0) {
        console.log('\n### Changed Files');
        for (const file of explanation.changedFiles) {
            const project = file.projectName ? `${file.projectName}: ` : '';
            console.log(`- ${project}${file.path} (${file.changeType})`);
        }
    }
    if (explanation.blockers.length > 0) {
        console.log('\n### Blockers');
        for (const blocker of explanation.blockers) {
            const project = blocker.projectName ? `${blocker.projectName}: ` : '';
            console.log(`- ${project}${blocker.message}`);
        }
    }
    if (explanation.unresolvedItems.length > 0) {
        console.log('\n### Unresolved Items');
        for (const item of explanation.unresolvedItems) {
            console.log(`- ${item}`);
        }
    }
    if (explanation.nextActions.length > 0) {
        console.log('\n### Next Actions');
        for (const action of explanation.nextActions) {
            console.log(`- ${action}`);
        }
    }
}
function printWorkspaceReport(snapshot, rootPath, projects) {
    const eventProjection = loadWorkspaceEventProjection(rootPath);
    console.log(chalk.bold('\n# Workspace SDD Summary\n'));
    const visibleItems = selectWorkspaceItems(snapshot, projects);
    const selectedProjectNames = new Set(visibleItems.map((item) => item.projectName));
    const visibleProjects = (snapshot.state?.projects || []).filter((project) => selectedProjectNames.size === 0 || selectedProjectNames.has(project.projectName));
    console.log(`- Root: ${rootPath}`);
    console.log(`- Phase: ${snapshot.state?.currentPhase || 'WORKSPACE_SPLIT'}`);
    console.log(`- Total Projects: ${visibleProjects.length || visibleItems.length || 0}`);
    console.log(`- Completed: ${visibleProjects.filter((project) => project.status === 'completed').length}`);
    console.log(`- Blocked: ${visibleProjects.filter((project) => project.status === 'blocked').length}`);
    console.log(`- Failed: ${visibleProjects.filter((project) => project.status === 'failed').length}`);
    console.log(`- Need Human: ${visibleProjects.filter((project) => project.blockerKind === 'NEED_HUMAN').length}`);
    console.log(`- Replan: ${visibleProjects.filter((project) => project.blockerKind === 'REPLAN').length}`);
    console.log(`- Clarified: ${visibleProjects.filter((project) => project.phase === 'PARALLEL_CLARIFY' && project.status === 'completed').length}`);
    console.log(`- Pending Decisions: ${getPendingWorkspaceDecisions(snapshot.state).length}`);
    console.log(`- Event Count: ${eventProjection.totalEvents}`);
    const policy = snapshot.settings?.workflowPolicy;
    if (policy?.profile) {
        console.log(`- Workflow Profile: ${policy.profile}`);
    }
    if (policy?.phaseBudgetsMs) {
        console.log(`- Phase Budgets: clarify=${policy.phaseBudgetsMs.PARALLEL_CLARIFY ?? '-'}ms, specify=${policy.phaseBudgetsMs.PARALLEL_SPECIFY ?? '-'}ms, plan=${policy.phaseBudgetsMs.PARALLEL_PLAN ?? '-'}ms, ace=${policy.phaseBudgetsMs.PARALLEL_ACE ?? '-'}ms`);
    }
    if (snapshot.state?.workspaceFeedback?.required) {
        console.log(`- Feedback: ${snapshot.state.workspaceFeedback.reason || 'required'}`);
        if (snapshot.state.workspaceFeedback.nextPhase) {
            console.log(`- Feedback Next Phase: ${snapshot.state.workspaceFeedback.nextPhase}`);
        }
    }
    const explanationBuilder = new TikKernel.WorkspaceExplanationBuilder();
    const explanation = explanationBuilder.build({
        workspaceRoot: rootPath,
        settings: snapshot.settings,
        state: snapshot.state,
        splitDemands: snapshot.splitDemands,
        projectNames: projects
            ? String(projects).split(',').map((project) => project.trim()).filter(Boolean)
            : undefined,
    });
    printWorkspaceExplanation(explanation);
    console.log('\n## Project Details');
    console.log('| Project | Phase | Status | Exec | Blocker | Contract | Role | Skill | Summary | Next |');
    console.log('|---------|-------|--------|------|---------|----------|------|-------|---------|------|');
    for (const project of visibleProjects) {
        const ids = Array.from(new Set([project.clarifyTaskId, project.specTaskId, project.planTaskId, project.aceTaskId, project.taskId].filter(Boolean))).join(', ');
        const summary = [project.summary || '', ids ? `(tasks: ${ids})` : ''].filter(Boolean).join(' ');
        const executionMode = (project.executionMode || '').replace(/\|/g, '\\|');
        const worktreeMode = project.worktree?.status ? `${executionMode}${executionMode ? ';' : ''}${project.worktree.status}` : executionMode;
        const blocker = (project.blockerKind || '').replace(/\|/g, '\\|');
        const contract = (project.workflowContract || '').replace(/\|/g, '\\|');
        const role = (project.workflowRole || '').replace(/\|/g, '\\|');
        const skill = (project.workflowSkillName || '').replace(/\|/g, '\\|');
        const next = (project.recommendedCommand || '').replace(/\|/g, '\\|');
        console.log(`| ${project.projectName} | ${project.phase} | ${project.status} | ${worktreeMode.replace(/\|/g, '\\|')} | ${blocker} | ${contract} | ${role} | ${skill} | ${summary.replace(/\|/g, '\\|')} | ${next} |`);
    }
    if (eventProjection.projects.length > 0) {
        console.log('\n## Event Projection');
        console.log('| Project | Events | Feedback | Recoveries | Completions | Last Event |');
        console.log('|---------|--------|----------|------------|-------------|------------|');
        for (const project of eventProjection.projects) {
            console.log(`| ${project.projectName} | ${project.eventCount} | ${project.feedbackCount} | ${project.recoveryCount} | ${project.completionCount} | ${(project.lastMessage || '').replace(/\|/g, '\\|')} |`);
        }
    }
    if (eventProjection.recentDisplay.length > 0) {
        console.log('\n## Recent Events');
        for (const event of eventProjection.recentDisplay) {
            const scope = event.projectName ? `${event.projectName} / ` : '';
            const repeat = event.count > 1 ? ` x${event.count}` : '';
            console.log(`- ${scope}${event.phase} ${event.kind}${repeat}: ${event.message}`);
        }
    }
    const pendingDecisions = getPendingWorkspaceDecisions(snapshot.state);
    if (pendingDecisions.length > 0) {
        console.log('\n## Pending Decisions');
        for (const decision of pendingDecisions) {
            console.log(`- ${decision.id} | ${decision.kind} | ${decision.projectName || 'workspace'} | ${decision.title}`);
            console.log(`  - prompt: ${decision.prompt}`);
            if (decision.confidence) {
                console.log(`  - confidence: ${decision.confidence}`);
            }
            if (decision.rationale) {
                console.log(`  - rationale: ${decision.rationale}`);
            }
            if (decision.signals?.length) {
                console.log(`  - signals: ${decision.signals.join(', ')}`);
            }
            if (decision.options?.length) {
                for (const option of decision.options) {
                    const recommended = option.recommended ? ' (recommended)' : '';
                    console.log(`  - option ${option.id}: ${option.label}${recommended}${option.nextPhase ? ` -> ${option.nextPhase}` : ''}`);
                }
            }
        }
    }
    console.log('');
}
function printWorkspaceDecisions(snapshot) {
    const decisions = snapshot.state?.decisions || [];
    const pending = decisions.filter((decision) => decision.status === 'pending');
    console.log(chalk.bold('\n🧠 Workspace Decisions\n'));
    if (pending.length === 0) {
        console.log(chalk.dim('  No pending human decisions.\n'));
        return;
    }
    for (const decision of pending) {
        console.log(`  ${chalk.magenta(decision.id)}  ${chalk.cyan(decision.kind)}  ${chalk.dim(decision.projectName || 'workspace')}`);
        console.log(`    ${decision.title}`);
        console.log(`    ${chalk.dim(decision.prompt)}`);
        if (decision.confidence) {
            console.log(`    ${chalk.dim(`confidence: ${decision.confidence}`)}`);
        }
        if (decision.rationale) {
            console.log(`    ${chalk.dim(decision.rationale)}`);
        }
        if (decision.signals?.length) {
            console.log(`    ${chalk.dim(`signals: ${decision.signals.join(', ')}`)}`);
        }
        if (decision.options?.length) {
            console.log(chalk.dim('    Options:'));
            for (const option of decision.options) {
                const recommended = option.recommended ? ' (recommended)' : '';
                const next = option.nextPhase ? ` -> ${option.nextPhase}` : '';
                console.log(`      ${chalk.dim(`${option.id}: ${option.label}${recommended}${next}`)}`);
                if (option.description) {
                    console.log(`      ${chalk.dim(`  ${option.description}`)}`);
                }
            }
        }
        console.log(`    ${chalk.dim(`Resolve with: tik workspace decide --id ${decision.id}${decision.recommendedOptionId ? ` --option ${decision.recommendedOptionId}` : ''}${decision.allowFreeform ? ' --message "..."' : ''}`)}`);
        console.log('');
    }
}
function getPendingWorkspaceDecisions(snapshot) {
    return (snapshot?.decisions || []).filter((decision) => decision.status === 'pending');
}
function selectWorkspaceProjectSnapshot(projects, activeProjectPath, target) {
    if (target) {
        return projects.find((project) => (project.projectName === target
            || path.basename(project.projectPath) === target
            || path.basename(project.sourceProjectPath || project.projectPath) === target));
    }
    return projects.find((project) => (activeProjectPath === project.projectPath
        || activeProjectPath === project.sourceProjectPath
        || activeProjectPath === project.effectiveProjectPath
        || activeProjectPath.startsWith(project.projectPath)
        || (project.sourceProjectPath ? activeProjectPath.startsWith(project.sourceProjectPath) : false)
        || (project.effectiveProjectPath ? activeProjectPath.startsWith(project.effectiveProjectPath) : false))) || projects[0];
}
function selectManagedWorktreeEntry(entries, projectName, sourceProjectPath, laneId) {
    const normalizedLaneId = normalizeWorktreeLaneId(laneId);
    const projectEntries = entries.filter((entry) => (entry.projectName === projectName
        && (!sourceProjectPath || entry.sourceProjectPath === sourceProjectPath)));
    if (laneId) {
        return projectEntries.find((entry) => normalizeWorktreeLaneId(entry.laneId) === normalizedLaneId);
    }
    return projectEntries.find((entry) => entry.active) || projectEntries[0];
}
function normalizeWorktreeLaneId(value) {
    return (value || 'primary')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'primary';
}
function parseProjectNames(projects) {
    return (projects || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}
function printWorkspacePhaseKickoff(title, rootPath, provider, items, effectiveProvider) {
    console.log(chalk.dim(`  Workspace: ${rootPath}`));
    console.log(chalk.dim(`  Provider: ${provider}`));
    if (effectiveProvider && effectiveProvider !== provider) {
        console.log(chalk.dim(`  Execution engine: ${effectiveProvider} (${title === 'Parallel ACE' ? 'phase-specific override' : 'document/delegated subtask mode'})`));
    }
    console.log(chalk.dim(`  Projects: ${items.map((item) => item.projectName).join(', ')}`));
    console.log(chalk.dim(`  Running ${items.length} project subtask(s).`));
    if (effectiveProvider === 'codex' || effectiveProvider === 'codex-delegate' || provider === 'codex' || provider === 'codex-delegate') {
        console.log(chalk.dim('  Codex may spend a short while reading context before the first visible action.'));
    }
    console.log('');
}
function printWorkspaceSubtaskTransition(record) {
    if (record.state === 'running') {
        console.log(`  ${chalk.cyan('→')} ${chalk.cyan(record.projectName)} ${chalk.dim(`started ${record.skillName || 'subtask'} (${record.taskId})`)}`);
        return;
    }
    const marker = record.state === 'completed'
        ? chalk.green('✓')
        : record.state === 'blocked'
            ? chalk.yellow('!')
            : chalk.red('✗');
    const detail = [record.skillName, record.taskId].filter(Boolean).join(' · ');
    console.log(`  ${marker} ${chalk.cyan(record.projectName)} ${chalk.dim(`${record.state}${detail ? ` (${detail})` : ''}`)}`);
    if (record.summary) {
        console.log(chalk.dim(`    ${record.summary}`));
    }
}
function createWorkspaceSubtaskEventMonitor(provider) {
    const heartbeatTimers = new Map();
    const lastVisibleAt = new Map();
    const idleThresholdMs = 8000;
    const heartbeatEveryMs = 12000;
    const clearHeartbeat = (taskId) => {
        const timer = heartbeatTimers.get(taskId);
        if (timer) {
            clearInterval(timer);
            heartbeatTimers.delete(taskId);
        }
        lastVisibleAt.delete(taskId);
    };
    const startHeartbeat = (record) => {
        if (provider !== 'codex' && provider !== 'codex-delegate')
            return;
        if (heartbeatTimers.has(record.taskId))
            return;
        lastVisibleAt.set(record.taskId, Date.now());
        const timer = setInterval(() => {
            const lastVisible = lastVisibleAt.get(record.taskId) || 0;
            const idleMs = Date.now() - lastVisible;
            if (idleMs < idleThresholdMs)
                return;
            const time = new Date().toLocaleTimeString();
            console.log(`${chalk.gray(time)} ${chalk.cyan(`[${record.projectName}]`)} ${chalk.dim('still working; waiting for the next visible Codex action...')}`);
            lastVisibleAt.set(record.taskId, Date.now());
        }, heartbeatEveryMs);
        heartbeatTimers.set(record.taskId, timer);
    };
    return {
        onEvent(event, context) {
            lastVisibleAt.set(context.taskId, Date.now());
            if (!shouldDisplayWorkspaceSubtaskEvent(event))
                return;
            displayWorkspaceSubtaskEvent(event, context);
        },
        onSubtaskRunning(record) {
            startHeartbeat(record);
        },
        onSubtaskFinished(record) {
            clearHeartbeat(record.taskId);
        },
    };
}
function createWorkspaceSubtaskEventForwarder(monitor) {
    return (event, context) => {
        monitor.onEvent(event, context);
    };
}
function shouldDisplayWorkspaceSubtaskEvent(event) {
    const type = event.type;
    if (type === 'session.message'
        || type === 'session.usage'
        || type === 'evaluation.started'
        || type === 'evaluation.fitness'
        || type === 'evaluation.drift'
        || type === 'evaluation.entropy') {
        return false;
    }
    return (type === 'session.started'
        || type === 'iteration.started'
        || type === 'iteration.completed'
        || type === 'context.built'
        || type === 'plan.started'
        || type === 'plan.generated'
        || type === 'tool.called'
        || type === 'tool.result'
        || type === 'tool.error'
        || type === 'system.warning'
        || type === 'convergence.achieved'
        || type === 'evaluation.completed');
}
function displayWorkspaceSubtaskEvent(event, context) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    const prefix = chalk.cyan(`[${context.projectName}]`);
    const line = formatWorkspaceSubtaskEventLine(event);
    if (!line)
        return;
    console.log(`${chalk.gray(time)} ${prefix} ${line}`);
}
function formatWorkspaceSubtaskEventLine(event) {
    const payload = (event.payload && typeof event.payload === 'object')
        ? event.payload
        : {};
    switch (event.type) {
        case 'session.started':
            return chalk.blue('session started');
        case 'iteration.started':
            return chalk.cyan(`iteration ${payload.iteration ?? '?'} started`);
        case 'iteration.completed':
            return chalk.cyan(`iteration ${payload.iteration ?? '?'} completed`);
        case 'context.built':
            return chalk.blue(`context built${payload.tokensUsed ? ` (${payload.tokensUsed} tokens)` : ''}`);
        case 'plan.started':
            return chalk.blue('plan started');
        case 'plan.generated':
            return chalk.blue('plan generated');
        case 'tool.called':
            return chalk.yellow(`tool ${payload.toolName || 'unknown'} called`);
        case 'tool.result':
            return chalk.green(`tool ${payload.toolName || 'unknown'} ok`);
        case 'tool.error':
            return chalk.red(`tool ${payload.toolName || 'unknown'} failed`);
        case 'evaluation.completed':
            return chalk.blue(`evaluation completed${typeof payload.fitness === 'number' ? ` (fitness=${payload.fitness.toFixed(3)})` : ''}`);
        case 'convergence.achieved':
            return chalk.green('converged');
        case 'system.warning':
            return chalk.yellow(String(payload.message || 'warning'));
        default:
            return null;
    }
}
function selectWorkspaceItems(snapshot, projects) {
    const items = snapshot.splitDemands?.items || [];
    const selected = parseProjectNames(projects);
    if (selected.length === 0)
        return items;
    const wanted = new Set(selected);
    return items.filter((item) => wanted.has(item.projectName));
}
function createWorkspaceSubtaskRuntime(provider, model, executionMode = 'single', onEvent) {
    return new WorkflowSubtaskRuntime((projectPath) => {
        const { kernel } = createKernel(projectPath, { provider, model, stream: false });
        return {
            kernel,
            dispose: () => kernel.dispose(),
        };
    }, executionMode, onEvent);
}
function createWorkspacePhaseReporter() {
    return {
        onKickoff: () => { },
        onRunning: (record) => {
            printWorkspaceSubtaskTransition(record);
        },
        onTerminal: () => { },
        onProjectResult: () => { },
        onInfo: (message) => {
            if (message)
                console.log(message);
        },
    };
}
function workspaceEventLogPath(rootPath) {
    return path.join(rootPath, '.workspace', 'events.jsonl');
}
function loadWorkspaceEventProjection(rootPath) {
    const store = new WorkspaceEventStore({ persistPath: workspaceEventLogPath(rootPath) });
    return buildWorkspaceEventProjection(store.snapshot());
}
function createWorkspaceWorkflowEngineInstance(rootPath, policyConfig) {
    const contextAssembler = new WorkspaceContextAssembler();
    const policyEngine = new WorkspacePolicyEngine(policyConfig);
    const eventStore = new WorkspaceEventStore({ persistPath: workspaceEventLogPath(rootPath) });
    const memoryStore = new WorkspaceMemoryStore(rootPath);
    const normalizeArtifactResolution = async (promise) => {
        const resolution = await promise;
        return {
            path: resolution.path ?? undefined,
            ambiguous: resolution.ambiguous,
            candidates: resolution.candidates,
        };
    };
    return new WorkspaceWorkflowEngine({
        orchestrator: workspaceOrchestrator,
        contextAssembler,
        clarifier: new TikKernel.WorkspaceSuperpowersClarifier(),
        policyEngine,
        eventStore,
        memoryStore,
        policyConfig,
        resolveWorkspaceSpecArtifact: (projectPath, preferredPath) => normalizeArtifactResolution(resolveWorkspaceSpecArtifact(projectPath, preferredPath)),
        resolveWorkspacePlanArtifact: (projectPath, options) => normalizeArtifactResolution(resolveWorkspacePlanArtifact(projectPath, options)),
        buildWorkspaceSpecTargetPath,
        buildWorkspacePlanTargetPath,
        buildWorkspaceFeatureDir,
        workspaceFeatureDirForArtifact,
        skillRuntimeFactory: () => new LocalWorkflowSkillRuntimeAdapter(),
        materializeWorkflowSkillDelegatedSpec,
        createSubtaskRuntime: (provider, model, executionMode, onEvent) => createWorkspaceSubtaskRuntime(provider, model, executionMode, onEvent),
        createEventMonitor: (provider) => createWorkspaceSubtaskEventMonitor(provider),
        createEventForwarder: (monitor) => createWorkspaceSubtaskEventForwarder(monitor),
        ensureWorkspaceExecutionTarget: async (input) => {
            const snapshot = await workspaceOrchestrator.getStatus(rootPath);
            const worktreePolicy = snapshot.settings?.worktreePolicy;
            try {
                const target = await workspaceWorktreeManager.getExecutionTarget({
                    ...input,
                    policy: worktreePolicy,
                });
                if (target.worktree) {
                    const shouldPersist = target.effectiveProjectPath !== input.existingEffectiveProjectPath
                        || target.worktree.worktreePath !== input.existingWorktree?.worktreePath
                        || target.worktree.status !== input.existingWorktree?.status
                        || target.worktree.worktreeBranch !== input.existingWorktree?.worktreeBranch
                        || target.worktree.laneId !== input.existingWorktree?.laneId;
                    if (shouldPersist) {
                        await workspaceOrchestrator.markProjectWorktreeReady(rootPath, input.projectName, {
                            effectiveProjectPath: target.effectiveProjectPath,
                            worktree: target.worktree,
                        });
                    }
                    await workspaceOrchestrator.activateProjectWorktreeLane(rootPath, input.projectName, {
                        effectiveProjectPath: target.effectiveProjectPath,
                        worktree: target.worktree,
                    });
                }
                return target;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const failedPolicy = workspaceWorktreeManager.resolvePolicy(input.workspaceRoot, worktreePolicy);
                await workspaceOrchestrator.markProjectWorktreeFailed(rootPath, input.projectName, {
                    effectiveProjectPath: input.existingEffectiveProjectPath || input.sourceProjectPath,
                    worktree: {
                        enabled: failedPolicy.mode === 'managed',
                        status: 'failed',
                        laneId: input.existingWorktree?.laneId || 'primary',
                        sourceBranch: workspaceWorktreeManager.readSourceBranch(input.sourceProjectPath),
                        worktreeBranch: input.existingWorktree?.worktreeBranch || workspaceWorktreeManager.buildManagedWorktreeBranch(input.workspaceName, input.projectName, input.sourceProjectPath, input.existingWorktree?.laneId),
                        worktreePath: input.existingWorktree?.worktreePath || workspaceWorktreeManager.buildManagedWorktreePath(input.workspaceRoot, input.projectName, input.sourceProjectPath, input.existingWorktree?.laneId, worktreePolicy),
                        createdAt: input.existingWorktree?.createdAt,
                        updatedAt: new Date().toISOString(),
                        retainedAfterCompletion: failedPolicy.defaultRetention === 'retain',
                        lastError: message,
                    },
                    summary: `Worktree preparation failed: ${message}`,
                });
                throw error;
            }
        },
        resolvePhaseProvider: (provider, phase) => resolveWorkspacePhaseProvider(provider, phase),
        resolveNativeRescueProvider: (provider) => resolveNativeRescueProvider(provider),
        runNativeWorkspaceArtifactRescue: (spec, provider, model, summary) => runNativeWorkspaceArtifactRescue(spec, provider, model, summary),
        safeReadFile,
        artifactWasMaterializedDuringWorkspaceRun,
        isWorkspacePlanValid,
        killWorkspaceTaskProcesses,
        captureGitChangedFiles,
    });
}
async function runNativeWorkspaceArtifactRescue(spec, provider, model, summary) {
    const { kernel, llm } = createKernel(spec.projectPath, { provider, model, stream: false });
    try {
        const completion = {
            complete: async (_projectPath, prompt, options) => ({
                content: await llm.complete(prompt, {
                    allowWrites: false,
                    onProviderEvent: options?.onProviderEvent,
                }),
                executionMode: 'native',
            }),
        };
        const registry = createWorkspaceSkillExecutorRegistry({
            completion,
            skillRuntime: new LocalWorkflowSkillRuntimeAdapter(),
        });
        return await registry.execute(spec.contract, {
            spec,
            subtask: {
                taskId: `native-rescue-${Date.now()}`,
                projectName: spec.projectName,
                projectPath: spec.projectPath,
                phase: spec.phase,
                contract: spec.contract,
                role: spec.role,
                skillName: spec.skillName,
                status: 'completed',
                summary,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
            },
        });
    }
    finally {
        kernel.dispose();
    }
}
function resolveNativeRescueProvider(provider) {
    return provider === 'codex-delegate' ? 'codex' : provider;
}
function resolveWorkspacePhaseProvider(provider, phase) {
    if (provider === 'codex'
        && (phase === 'PARALLEL_SPECIFY' || phase === 'PARALLEL_PLAN')) {
        return 'codex-delegate';
    }
    return provider;
}
async function safeReadFile(filePath) {
    const fs = await import('node:fs/promises');
    try {
        return await fs.readFile(filePath, 'utf-8');
    }
    catch {
        return '';
    }
}
async function artifactWasMaterializedDuringWorkspaceRun(artifactPath, workspaceCreatedAt) {
    if (!workspaceCreatedAt)
        return false;
    const startedAt = Date.parse(workspaceCreatedAt);
    if (Number.isNaN(startedAt))
        return false;
    const fs = await import('node:fs/promises');
    try {
        const stat = await fs.stat(artifactPath);
        return stat.mtimeMs >= startedAt - 1000;
    }
    catch {
        return false;
    }
}
async function captureGitChangedFiles(projectPath) {
    return captureWorkspaceGitChangedFiles(projectPath);
}
async function killWorkspaceTaskProcesses(taskIds) {
    const { spawnSync } = await import('node:child_process');
    for (const taskId of taskIds.filter(Boolean)) {
        spawnSync('pkill', ['-f', taskId], { stdio: 'ignore' });
    }
}
//# sourceMappingURL=index.js.map