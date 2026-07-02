import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRunProofStore } from '../src/agent-runners/run-proof-store.js';
const tempDirs = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('FileRunProofStore', () => {
    it('persists proofs by run id and lists them by task', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-run-proof-store-'));
        tempDirs.push(root);
        const store = new FileRunProofStore(root);
        const proof = makeProof(root);
        await store.saveProof(proof);
        const reloaded = new FileRunProofStore(root);
        await expect(reloaded.readProof('run-1')).resolves.toMatchObject({
            id: 'proof-run-1',
            taskId: 'task-1',
            runId: 'run-1',
            status: 'ready_for_review',
            diff: {
                filesChanged: 1,
                changedFiles: ['src/app.ts'],
            },
        });
        await expect(reloaded.listProofsByTask('task-1')).resolves.toMatchObject([
            {
                id: 'proof-run-1',
                runId: 'run-1',
            },
        ]);
    });
    it('skips corrupt proof files when listing proofs for a task', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-run-proof-store-'));
        tempDirs.push(root);
        const store = new FileRunProofStore(root);
        await store.saveProof(makeProof(root));
        await fs.mkdir(path.join(root, '.tik', 'runs', 'run-corrupt'), { recursive: true });
        await fs.writeFile(path.join(root, '.tik', 'runs', 'run-corrupt', 'proof.json'), '{bad json', 'utf-8');
        await fs.appendFile(path.join(root, '.tik', 'runs', 'run-proofs.jsonl'), `${JSON.stringify({
            id: 'proof-corrupt',
            taskId: 'task-1',
            runId: 'run-corrupt',
        })}\n`, 'utf-8');
        const proofs = await store.listProofsByTask('task-1');
        expect(proofs.map((proof) => proof.runId)).toEqual(['run-1']);
    });
});
function makeProof(root) {
    return {
        id: 'proof-run-1',
        taskId: 'task-1',
        runId: 'run-1',
        attempt: 0,
        status: 'ready_for_review',
        risk: 'low',
        summary: 'Run completed and is ready for review.',
        transcriptArtifactIds: ['transcript-artifact'],
        diff: {
            filesChanged: 1,
            insertions: 3,
            deletions: 1,
            changedFiles: ['src/app.ts'],
            patchArtifactId: 'patch-artifact',
            statArtifactId: 'stat-artifact',
        },
        validationRefs: [],
        producedArtifactIds: ['review-artifact'],
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
    };
}
//# sourceMappingURL=run-proof-store.test.js.map