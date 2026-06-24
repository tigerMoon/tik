import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

describe('CLI entrypoint', () => {
  it('awaits Commander async actions so long-running commands stay alive', async () => {
    const source = await fs.readFile(path.resolve('src/index.ts'), 'utf-8');

    expect(source).toContain('program.parseAsync');
    expect(source).not.toContain('program.parse();');
  });
});
