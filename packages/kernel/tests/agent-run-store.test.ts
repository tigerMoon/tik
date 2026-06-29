import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAgentRunStore } from '../src/agent-runners/agent-run-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('FileAgentRunStore', () => {
  it('stores a global index, append-only events, and reconstructs metadata from events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-agent-run-store-'));
    tempDirs.push(root);
    const store = new FileAgentRunStore(root);

    await store.createRun({
      id: 'run-1',
      taskId: 'task-1',
      shortIdentifier: 'TIK-1',
      attempt: 0,
      runner: 'codex',
      runnerMode: 'codex_app_server',
      workflowPath: path.join(root, '.tik', 'WORKFLOW.md'),
      workflowConfigHash: 'config-hash',
      workflowPromptHash: 'prompt-hash',
      status: 'queued',
      workspaceRoot: root,
      projectPath: root,
      transcriptRefs: [],
      eventRefs: [],
      artifactIds: [],
    });
    await store.appendEvent({
      runId: 'run-1',
      ts: '2026-06-23T00:00:00.000Z',
      source: 'tik',
      kind: 'run.start',
      payload: {},
    });
    await store.appendEvent({
      runId: 'run-1',
      ts: '2026-06-23T00:00:01.000Z',
      source: 'tik',
      kind: 'run.complete',
      payload: { artifactIds: ['artifact-1'] },
    });
    await store.appendEvent({
      runId: 'run-1',
      ts: '2026-06-23T00:00:02.000Z',
      source: 'tik',
      kind: 'artifact.discovered',
      payload: {
        status: 'needs_review',
        artifactIds: ['artifact-2'],
        transcriptRefs: [{ path: path.join(root, '.tik', 'runs', 'run-1', 'stdout.log'), contentType: 'text/plain' }],
        diffSummary: {
          changedFiles: ['src/proof.ts'],
          insertions: 4,
          deletions: 1,
          patchPath: path.join(root, '.tik', 'runs', 'run-1', 'run-diff.patch'),
        },
      },
    });

    const recovered = new FileAgentRunStore(root);
    const runs = await recovered.listRuns();
    const metadata = await recovered.readRun('run-1');
    const events = await recovered.readEvents('run-1');

    expect(runs.map((run) => run.id)).toEqual(['run-1']);
    expect(metadata).toMatchObject({
      id: 'run-1',
      status: 'needs_review',
      artifactIds: ['artifact-1', 'artifact-2'],
      transcriptRefs: [{ path: path.join(root, '.tik', 'runs', 'run-1', 'stdout.log'), contentType: 'text/plain' }],
      diffSummary: {
        changedFiles: ['src/proof.ts'],
        insertions: 4,
        deletions: 1,
        patchPath: path.join(root, '.tik', 'runs', 'run-1', 'run-diff.patch'),
      },
      startedAt: '2026-06-23T00:00:00.000Z',
      endedAt: '2026-06-23T00:00:01.000Z',
    });
    expect(events.map((event) => event.kind)).toEqual(['run.start', 'run.complete', 'artifact.discovered']);
  });
});
