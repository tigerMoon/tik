import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bashTool, globTool, readFileTool } from '../src/tools.js';
import { grepTool } from '../src/tools-search.js';
import type { ToolContext } from '@tik/shared';

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tool-guards-'));
  tempDirs.push(root);

  await fs.mkdir(path.join(root, 'catalog-suite-one-api', 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'unrelated', 'src'), { recursive: true });

  await fs.writeFile(
    path.join(root, 'catalog-suite-one-api', 'src', 'CatalogQueryService.java'),
    'class CatalogQueryService { String cacheKey = "query-cache"; }\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'unrelated', 'src', 'OtherService.java'),
    'class OtherService { String nothing = "noop"; }\n',
    'utf-8',
  );

  return root;
}

function createContext(root: string, likelyTargetPaths?: string[]): ToolContext {
  return {
    cwd: root,
    taskId: 'task-test',
    likelyTargetPaths,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('tool search guards', () => {
  it('read_file refuses to read directories', async () => {
    const root = await makeRepo();
    const result = await readFileTool.execute(
      { path: path.join(root, 'catalog-suite-one-api') },
      createContext(root),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing to read directory');
  });

  it('glob auto-scopes broad searches to likely target paths', async () => {
    const root = await makeRepo();
    const result = await globTool.execute(
      { pattern: '**/*', cwd: root },
      createContext(root, [path.join(root, 'catalog-suite-one-api')]),
    );

    expect(result.success).toBe(true);
    const files = result.output as string[];
    expect(files.some((file) => file.includes('catalog-suite-one-api/src/CatalogQueryService.java'))).toBe(true);
    expect(files.some((file) => file.includes('unrelated/src/OtherService.java'))).toBe(false);
  });

  it('glob supports path-aware patterns like claw glob_search', async () => {
    const root = await makeRepo();
    const result = await globTool.execute(
      { pattern: 'catalog-suite-one-api/**/*' },
      createContext(root, [path.join(root, 'catalog-suite-one-api')]),
    );

    expect(result.success).toBe(true);
    const files = result.output as string[];
    expect(files.some((file) => file.endsWith('catalog-suite-one-api/src/CatalogQueryService.java'))).toBe(true);
  });

  it('grep auto-scopes broad searches to likely target paths', async () => {
    const root = await makeRepo();
    const result = await grepTool.execute(
      { pattern: 'cacheKey' },
      createContext(root, [path.join(root, 'catalog-suite-one-api')]),
    );

    expect(result.success).toBe(true);
    const output = String(result.output);
    expect(output).toContain('CatalogQueryService.java');
    expect(output).not.toContain('OtherService.java');
  });

  it('bash rewrites broad repo-wide find to the likely target path', async () => {
    const root = await makeRepo();
    const result = await bashTool.execute(
      { command: 'find . -type f | sort' },
      createContext(root, [path.join(root, 'catalog-suite-one-api')]),
    );

    expect(result.success).toBe(true);
    const stdout = String((result.output as { stdout?: string }).stdout || '');
    expect(stdout).toContain('catalog-suite-one-api/src/CatalogQueryService.java');
    expect(stdout).not.toContain('unrelated/src/OtherService.java');
  });

  it('bash blocks broad repo-wide find when there is no likely target path', async () => {
    const root = await makeRepo();
    const result = await bashTool.execute(
      { command: 'find . -type f | sort' },
      createContext(root),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing broad repo-wide `find`');
  });

  it('bash blocks low-value file probes once implementation is ready', async () => {
    const root = await makeRepo();
    const result = await bashTool.execute(
      { command: 'wc -l catalog-suite-one-api/src/CatalogQueryService.java' },
      {
        ...createContext(root, [path.join(root, 'catalog-suite-one-api')]),
        implementationReady: true,
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing low-value shell file probe');
  });

  it('bash blocks find -name when structured search is available', async () => {
    const root = await makeRepo();
    const result = await bashTool.execute(
      { command: 'find catalog-suite-one-api/src -type f -name "*Query*.java"' },
      createContext(root, [path.join(root, 'catalog-suite-one-api')]),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing `bash find -name`');
  });

  it('bash blocks grep when structured search is available', async () => {
    const root = await makeRepo();
    const result = await bashTool.execute(
      { command: 'grep -n "cacheKey" catalog-suite-one-api/src/CatalogQueryService.java' },
      createContext(root, [path.join(root, 'catalog-suite-one-api')]),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing shell grep/rg');
  });
});
