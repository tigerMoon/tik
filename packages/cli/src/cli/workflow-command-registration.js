import * as path from 'node:path';
import chalk from 'chalk';
import { explainWorkflowTask, initWorkflowV2, validateWorkflow, } from '../workflow-command.js';
export function registerWorkflowCommands(program) {
    program
        .command('workflow [command] [taskId]')
        .description('Initialize, validate, and explain tracker workflow v2 files')
        .option('-p, --project <path>', 'Workspace/project root', process.cwd())
        .option('--file <path>', 'Workflow file name/path relative to project root')
        .option('--v2', 'Initialize a workflow v2 file')
        .option('--force', 'Overwrite an existing workflow when initializing')
        .action(async (command, taskId, opts) => {
        const workspaceRoot = path.resolve(opts.project);
        const subcommand = command || 'validate';
        try {
            if (subcommand === 'init') {
                if (!opts.v2) {
                    console.log(chalk.red('\n  Use `tik workflow init --v2` to initialize a workflow v2 file.\n'));
                    return;
                }
                const result = await initWorkflowV2({
                    workspaceRoot,
                    file: opts.file,
                    force: opts.force,
                });
                console.log(result.created
                    ? chalk.green(`Created workflow v2: ${result.path}`)
                    : chalk.yellow(`Workflow already exists: ${result.path}`));
                return;
            }
            if (subcommand === 'validate') {
                console.log(await validateWorkflow({
                    workspaceRoot,
                    file: opts.file,
                }));
                return;
            }
            if (subcommand === 'explain') {
                if (!taskId) {
                    console.log(chalk.red('\n  Missing task id. Use `tik workflow explain <task-id>`.\n'));
                    return;
                }
                console.log(await explainWorkflowTask({
                    workspaceRoot,
                    file: opts.file,
                    taskId,
                }));
                return;
            }
            console.log(chalk.red(`\n  Unknown workflow command: ${subcommand}\n`));
        }
        catch (error) {
            console.log(chalk.red(`\n  Workflow command failed: ${error.message}\n`));
        }
    });
}
//# sourceMappingURL=workflow-command-registration.js.map