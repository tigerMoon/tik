import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { frontendCommandCatalogTool, frontendPreviewProbeTool, frontendRunScriptTool } from '../src/tools-frontend.js';

const tempDirs: string[] = [];

async function makeFrontendRepo(options?: {
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  includePreviewServer?: boolean;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-frontend-tools-'));
  tempDirs.push(root);

  const port = 43123;
  const scripts: Record<string, string> = {
    dev: options?.includePreviewServer
      ? `node ./scripts/dev-server.js ${port}`
      : 'node -e "console.log(\'dev ready\')"',
    build: 'node -e "console.log(\'build ok\')"',
    test: 'node -e "console.log(\'test ok\')"',
    lint: 'node -e "console.log(\'lint ok\')"',
  };

  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'frontend-tools-app',
      scripts,
      dependencies: {
        react: '^18.3.0',
      },
      devDependencies: {
        vite: '^6.0.0',
      },
    }, null, 2),
    'utf-8',
  );

  if (options?.packageManager === 'pnpm') {
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf-8');
  } else if (options?.packageManager === 'npm') {
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n', 'utf-8');
  } else if (options?.packageManager === 'yarn') {
    await fs.writeFile(path.join(root, 'yarn.lock'), '# yarn lock\n', 'utf-8');
  } else if (options?.packageManager === 'bun') {
    await fs.writeFile(path.join(root, 'bun.lock'), '# bun lock\n', 'utf-8');
  }

  if (options?.includePreviewServer) {
    await fs.writeFile(
      path.join(root, 'scripts', 'dev-server.js'),
      [
        "const http = require('http');",
        "const port = Number(process.argv[2] || '43123');",
        "const server = http.createServer((_req, res) => {",
        "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
        "  res.end('<html><body><div id=\"app\">preview ok</div></body></html>');",
        '});',
        "server.listen(port, '127.0.0.1', () => {",
        "  console.log(`Local: http://127.0.0.1:${port}/`);",
        '});',
        "const shutdown = () => server.close(() => process.exit(0));",
        "process.on('SIGTERM', shutdown);",
        "process.on('SIGINT', shutdown);",
      ].join('\n'),
      'utf-8',
    );
  }

  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('frontend runtime tools', () => {
  it('frontend_command_catalog returns recommended package-manager commands and available scripts', async () => {
    const root = await makeFrontendRepo({ packageManager: 'pnpm' });

    const result = await frontendCommandCatalogTool.execute({}, {
      cwd: root,
      taskId: 'catalog-task',
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.packageManager).toBe('pnpm');
    expect(output.defaultPreviewScript).toBe('dev');
    expect(output.suggestedCommands).toMatchObject({
      dev: 'pnpm dev',
      build: 'pnpm build',
      test: 'pnpm test',
      lint: 'pnpm lint',
    });
  });

  it('frontend_run_script executes a whitelisted frontend script through the detected package manager', async () => {
    const root = await makeFrontendRepo({ packageManager: 'npm' });

    const result = await frontendRunScriptTool.execute({
      script: 'build',
      timeoutMs: 10_000,
    }, {
      cwd: root,
      taskId: 'run-script-task',
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.script).toBe('build');
    expect(output.command).toBe('npm run build');
    expect(String(output.stdout || '')).toContain('build ok');
  });

  it('frontend_preview_probe starts a short-lived preview command, captures the URL, and probes the page', async () => {
    const root = await makeFrontendRepo({ packageManager: 'npm', includePreviewServer: true });

    const result = await frontendPreviewProbeTool.execute({
      timeoutMs: 10_000,
    }, {
      cwd: root,
      taskId: 'preview-task',
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.script).toBe('dev');
    expect(String(output.url || '')).toContain('127.0.0.1:43123');
    expect(output.httpStatus).toBe(200);
    expect(String(output.bodySnippet || '')).toContain('preview ok');
  });
});
