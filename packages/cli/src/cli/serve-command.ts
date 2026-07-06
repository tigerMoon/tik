import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import type { ProviderOption } from '../types.js';
import { createKernel } from './kernel-factory.js';
import { serverProviderHelp } from './provider-resolution.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the API server')
    .option('-p, --port <port>', 'Port', '3300')
    .option('--host <host>', 'Host interface to bind', 'localhost')
    .option('--project <path>', 'Default project/workspace root', process.cwd())
    .option('--provider <provider>', serverProviderHelp, 'codex')
    .option('--model <model>', 'Override model name')
    .option('--mock', 'Force mock LLM')
    .addHelpText('after', `

Examples:
  tik serve --provider claude
  tik serve --provider codex
`)
    .action(async (opts: { port: string; host: string; project: string; provider: ProviderOption; model?: string; mock?: boolean }) => {
      const provider = opts.mock ? 'mock' : opts.provider;
      const workspaceRoot = path.resolve(opts.project);
      const port = parseInt(opts.port);
      const publicHost = opts.host === 'localhost' || opts.host === '::1' ? '127.0.0.1' : opts.host;
      const publicApiBaseUrl = `http://${publicHost}:${port}/api`;
      const { kernel, llmName } = createKernel(workspaceRoot, { provider, model: opts.model });
      const { createServer } = await import('@tik/kernel');

      console.log(chalk.bold('\n🌐 Tik Workbench Server\n'));
      console.log(chalk.dim(`  LLM: ${llmName}`));
      console.log(chalk.dim(`  Workspace root: ${workspaceRoot}`));

      await createServer(kernel, { port, host: opts.host }, { workspaceRoot, publicApiBaseUrl });

      console.log(chalk.green(`  API: ${publicApiBaseUrl}`));
      console.log(chalk.dim('  Workbench UI expects the dashboard dev server on http://localhost:5173'));
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));
    });
}
