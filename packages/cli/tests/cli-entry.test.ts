import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

describe('CLI entrypoint', () => {
  it('awaits Commander async actions so long-running commands stay alive', async () => {
    const source = await fs.readFile(path.resolve('src/index.ts'), 'utf-8');

    expect(source).toContain('program.parseAsync');
    expect(source).not.toContain('program.parse();');
  });

  it('registers workflow v2 lifecycle commands', async () => {
    const source = await fs.readFile(path.resolve('src/index.ts'), 'utf-8');

    expect(source).toContain(".command('workflow [command] [taskId]')");
    expect(source).toContain('initWorkflowV2');
    expect(source).toContain('validateWorkflow');
    expect(source).toContain('explainWorkflowTask');
  });

  it('defaults serve to localhost and exposes an explicit host override', async () => {
    const source = await fs.readFile(path.resolve('src/index.ts'), 'utf-8');

    expect(source).toContain(".option('--host <host>', 'Host interface to bind', 'localhost')");
    expect(source).toContain("host: opts.host");
    expect(source).not.toContain("host: '0.0.0.0'");
  });
});
