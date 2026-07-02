import * as path from 'node:path';
import chalk from 'chalk';
import { createDefaultRuntimeRunners, FileAgentRunStore, FileTrackerDaemonStateStore, loadTrackerWorkflow, resolveTrackerWorkflowPath, runWorkbenchKernelTaskInBackground, TrackerDaemon, WorkbenchTrackerLauncher, } from '@tik/kernel';
import { cleanupManagedTrackerWorkspace } from '../tracker-workspace-cleanup.js';
import { buildTaskImporterFromCli } from '../tracker-importer.js';
import { runTrackerHook } from '../tracker-hooks.js';
import { createKernel } from './kernel-factory.js';
import { serverProviderHelp } from './provider-resolution.js';
export function registerTrackerCommands(program, services) {
    program
        .command('tracker')
        .description('Run tracker-daemon operations')
        .argument('[command]', 'Command: tick or watch', 'tick')
        .option('--file <path>', 'JSON task snapshot file')
        .option('--workflow <path>', 'Workflow file name/path relative to project root')
        .option('-p, --project <path>', 'Workspace/project root', process.cwd())
        .option('--provider <provider>', serverProviderHelp, 'codex')
        .option('--model <model>', 'Override model name')
        .option('--mock', 'Force mock LLM')
        .addHelpText('after', `

Examples:
  tik tracker tick --file ./tasks.json --provider mock
  tik tracker watch --workflow WORKFLOW.md --provider codex
`)
        .action(async (command, opts) => {
        if (command !== 'tick' && command !== 'watch') {
            console.log(chalk.red(`\n  Unknown tracker command: ${command}\n`));
            return;
        }
        const workspaceRoot = path.resolve(opts.project);
        const provider = opts.mock ? 'mock' : opts.provider;
        const { kernel, llmName } = createKernel(workspaceRoot, { provider, model: opts.model });
        const workflowPath = await resolveTrackerWorkflowPath(workspaceRoot, opts.workflow);
        const workflow = await loadTrackerWorkflowFromCli(workspaceRoot, opts.workflow);
        const importer = buildTaskImporterFromCli({
            workspaceRoot,
            file: opts.file,
            workflow,
            workbench: kernel.workbench,
        });
        const daemon = new TrackerDaemon({
            importer,
            stateStore: FileTrackerDaemonStateStore.forWorkspace(workspaceRoot),
            agentRunStore: new FileAgentRunStore(workspaceRoot),
            launcher: new WorkbenchTrackerLauncher(kernel.workbench, {
                workspaceRoot,
                defaultProjectPath: workspaceRoot,
                workspaceName: path.basename(workspaceRoot),
                resolveExecutionTarget: async (input) => {
                    const target = await services.workspaceWorktreeManager.getExecutionTarget({
                        workspaceName: input.workspaceName,
                        workspaceRoot: input.workspaceRoot,
                        projectName: input.projectName,
                        sourceProjectPath: input.sourceProjectPath,
                        laneId: input.laneId,
                    });
                    return {
                        sourceProjectPath: target.sourceProjectPath,
                        effectiveProjectPath: target.effectiveProjectPath,
                        worktreeKind: target.worktree?.kind,
                        worktreePath: target.worktree?.worktreePath,
                    };
                },
                createKernelTask: (input) => kernel.taskManager.create(input),
                runTask: (task, input) => runWorkbenchKernelTaskInBackground(task, {
                    taskId: input.workbenchTaskId,
                    workbench: kernel.workbench,
                    runTask: (kernelTask) => kernel.runTask(kernelTask),
                    logError: (message, err) => {
                        console.error(message);
                        if (err.stack)
                            console.error('[tracker] Stack:', err.stack);
                    },
                }),
                isRunActive: (taskId) => Boolean(kernel.getSession(taskId)),
                stopTask: (taskId) => {
                    try {
                        kernel.control(taskId, { type: 'stop' });
                    }
                    catch { }
                },
                runHook: async (name, input) => {
                    await runTrackerHook(name, input);
                },
                cleanupWorkspace: async (input) => {
                    await cleanupManagedTrackerWorkspace({
                        workspaceRoot: input.workspaceRoot,
                        worktreePath: input.run?.projectPath,
                    });
                },
            }),
            workspaceRoot,
            defaultProjectPath: workspaceRoot,
            runtimeRunners: createDefaultRuntimeRunners(),
            workflow,
            maxConcurrentAgents: workflow?.config.polling.maxConcurrentAgents,
            pollIntervalMs: workflow?.config.polling.intervalMs,
            workflowProvider: command === 'watch'
                ? async () => loadTrackerWorkflow(path.dirname(workflowPath), path.basename(workflowPath)).catch(() => workflow)
                : undefined,
            terminalStates: workflow?.config.tracker.terminalStates,
            workspaceHooks: workflow?.config.workspace.hooks,
            cleanupTerminalWorkspaces: workflow?.config.workspace.cleanupTerminal,
        });
        if (command === 'watch') {
            console.log(chalk.bold('\n🎼 Tracker Daemon Watch\n'));
            console.log(chalk.dim(`  Provider: ${llmName}`));
            console.log(chalk.dim(`  Workspace: ${workspaceRoot}`));
            console.log(chalk.dim(`  Interval: ${workflow?.config.polling.intervalMs || 30_000}ms`));
            console.log(chalk.dim('  Press Ctrl+C to stop\n'));
            daemon.watch();
            return;
        }
        const result = await daemon.tick();
        console.log(chalk.bold('\n🎼 Tracker Daemon Tick\n'));
        console.log(chalk.dim(`  Provider: ${llmName}`));
        console.log(chalk.dim(`  Workspace: ${workspaceRoot}`));
        if (opts.file)
            console.log(chalk.dim(`  Tracker: ${path.resolve(opts.file)}\n`));
        if (result.dispatched.length)
            console.log(chalk.green(`  Dispatched: ${result.dispatched.join(', ')}`));
        if (result.stopped.length)
            console.log(chalk.yellow(`  Stopped: ${result.stopped.join(', ')}`));
        if (result.skipped.length) {
            console.log(chalk.dim(`  Skipped: ${result.skipped.map((item) => `${item.shortIdentifier}:${item.reason}`).join(', ')}`));
        }
        if (result.failed.length) {
            console.log(chalk.red(`  Failed: ${result.failed.map((item) => `${item.shortIdentifier}:${item.error}`).join(', ')}`));
        }
        if (!result.dispatched.length && !result.stopped.length && !result.skipped.length && !result.failed.length) {
            console.log(chalk.gray('  No tracker changes.'));
        }
        console.log();
    });
}
async function loadTrackerWorkflowFromCli(workspaceRoot, workflowPath) {
    const resolved = await resolveTrackerWorkflowPath(workspaceRoot, workflowPath);
    return loadTrackerWorkflow(path.dirname(resolved), path.basename(resolved));
}
//# sourceMappingURL=tracker-command.js.map