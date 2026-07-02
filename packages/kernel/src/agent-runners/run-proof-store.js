import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class FileRunProofStore {
    runsRoot;
    indexPath;
    constructor(workspaceRoot) {
        this.runsRoot = path.join(workspaceRoot, '.tik', 'runs');
        this.indexPath = path.join(this.runsRoot, 'run-proofs.jsonl');
    }
    async saveProof(proof) {
        await fs.mkdir(this.runDir(proof.runId), { recursive: true });
        await fs.mkdir(this.runsRoot, { recursive: true });
        await fs.writeFile(this.proofPath(proof.runId), `${JSON.stringify(proof, null, 2)}\n`, 'utf-8');
        await this.upsertIndex(proof);
        return proof;
    }
    async readProof(runId) {
        return JSON.parse(await fs.readFile(this.proofPath(runId), 'utf-8'));
    }
    async listProofsByTask(taskId) {
        const index = await readJsonl(this.indexPath).catch(() => []);
        const runIds = Array.from(new Set(index
            .filter((item) => item.taskId === taskId)
            .map((item) => item.runId)
            .filter(Boolean)));
        const proofs = [];
        for (const runId of runIds) {
            const proof = await this.readProof(runId).catch(() => null);
            if (proof)
                proofs.push(proof);
        }
        return proofs.sort((left, right) => left.attempt - right.attempt || left.createdAt.localeCompare(right.createdAt));
    }
    async upsertIndex(proof) {
        const current = await readJsonl(this.indexPath).catch(() => []);
        const next = [
            ...current.filter((item) => item.runId !== proof.runId),
            {
                id: proof.id,
                taskId: proof.taskId,
                runId: proof.runId,
                attempt: proof.attempt,
                status: proof.status,
                createdAt: proof.createdAt,
                updatedAt: proof.updatedAt,
            },
        ];
        await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
        await fs.writeFile(this.indexPath, next.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
    }
    runDir(runId) {
        return path.join(this.runsRoot, runId);
    }
    proofPath(runId) {
        return path.join(this.runDir(runId), 'proof.json');
    }
}
async function readJsonl(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
//# sourceMappingURL=run-proof-store.js.map