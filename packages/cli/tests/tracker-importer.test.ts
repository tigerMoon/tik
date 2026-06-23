import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '@tik/kernel';
import { WorkbenchService } from '@tik/kernel';
import { WorkbenchStore } from '@tik/kernel';
import { buildTaskImporterFromCli } from '../src/tracker-importer.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('buildTaskImporterFromCli', () => {
  it('rejects Linear as a runtime tracker source for daemon commands', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-cli-tracker-'));
    tempDirs.push(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });

    expect(() => buildTaskImporterFromCli({
      workspaceRoot: root,
      workflow: {
        config: {
          tracker: {
            kind: 'linear',
            activeStates: ['Todo'],
            terminalStates: ['Done'],
          },
          polling: {
            intervalMs: 30_000,
            maxConcurrentAgents: 1,
          },
          workspace: {
            root: '.tik/workspaces',
            cleanupTerminal: false,
            hooks: {
              afterCreate: [],
              beforeRun: [],
              afterRun: [],
              beforeRemove: [],
            },
          },
          agent: {
            timeoutMs: 1_000,
          },
        },
        promptTemplate: 'Implement {{ task.shortIdentifier }}.',
        renderPrompt(task) {
          return `Implement ${task.shortIdentifier}.`;
        },
      },
      workbench,
    })).toThrow(/Linear runtime import is no longer supported/i);
  });
});
