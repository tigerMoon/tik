import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const tempDirs: string[] = [];

function createMockChild(options?: {
  exitCode?: number;
  stdoutChunks?: string[];
  stderrChunks?: string[];
  onBeforeExit?: () => Promise<void> | void;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    if (child.exitCode === null) {
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
    }
    return true;
  });

  setImmediate(async () => {
    await options?.onBeforeExit?.();
    for (const chunk of options?.stdoutChunks || []) child.stdout.emit('data', chunk);
    for (const chunk of options?.stderrChunks || []) child.stderr.emit('data', chunk);
    child.exitCode = options?.exitCode ?? 0;
    child.emit('exit', child.exitCode, null);
  });

  return child;
}

async function makeFrontendRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-frontend-playwright-'));
  tempDirs.push(root);
  return root;
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('frontend Playwright browser tools', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('frontend_browser_screenshot shells out to Playwright and writes a screenshot artifact', async () => {
    const root = await makeFrontendRepo();
    const { frontendBrowserScreenshotTool } = await import('../src/tools-frontend.js');

    spawnMock.mockImplementation((command: string, args: string[]) => createMockChild({
      stdoutChunks: ['captured'],
      onBeforeExit: async () => {
        expect(command).toBe('playwright');
        expect(args).toEqual(expect.arrayContaining([
          'screenshot',
          'http://127.0.0.1:4173/',
          path.join(root, 'artifacts', 'hero.png'),
          '--full-page',
          '--wait-for-selector',
          '#app',
          '--wait-for-timeout',
          '150',
          '--timeout',
          '5000',
          '-b',
          'chromium',
          '--viewport-size',
          '1440,900',
        ]));

        await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
        await fs.writeFile(path.join(root, 'artifacts', 'hero.png'), PNG_HEADER);
      },
    }));

    const result = await frontendBrowserScreenshotTool.execute({
      url: 'http://127.0.0.1:4173/',
      outputPath: 'artifacts/hero.png',
      browser: 'chromium',
      fullPage: true,
      waitForSelector: '#app',
      waitForTimeoutMs: 150,
      timeoutMs: 5000,
      viewportSize: '1440,900',
    }, {
      cwd: root,
      taskId: 'browser-screenshot-task',
    });

    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.output).toMatchObject({
      url: 'http://127.0.0.1:4173/',
      browser: 'chromium',
      artifactPath: path.join(root, 'artifacts', 'hero.png'),
      bytes: PNG_HEADER.length,
    });
  });

  it('frontend_browser_screenshot returns a clear install hint when Playwright browsers are missing', async () => {
    const root = await makeFrontendRepo();
    const { frontendBrowserScreenshotTool } = await import('../src/tools-frontend.js');

    spawnMock.mockImplementation(() => createMockChild({
      exitCode: 1,
      stderrChunks: [
        'Error: Executable does not exist',
        'Please run the following command to download new browsers:',
        'playwright install',
      ],
    }));

    const result = await frontendBrowserScreenshotTool.execute({
      url: 'http://127.0.0.1:4173/',
    }, {
      cwd: root,
      taskId: 'browser-screenshot-error-task',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Playwright browser binary is not installed');
    expect(result.error).toContain('playwright install chromium');
  });
});
