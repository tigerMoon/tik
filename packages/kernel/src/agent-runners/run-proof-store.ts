import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunProof } from '@tik/shared';

interface RunProofIndexRecord {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  status: RunProof['status'];
  createdAt: string;
  updatedAt: string;
}

export class FileRunProofStore {
  private readonly runsRoot: string;
  private readonly indexPath: string;

  constructor(workspaceRoot: string) {
    this.runsRoot = path.join(workspaceRoot, '.tik', 'runs');
    this.indexPath = path.join(this.runsRoot, 'run-proofs.jsonl');
  }

  async saveProof(proof: RunProof): Promise<RunProof> {
    await fs.mkdir(this.runDir(proof.runId), { recursive: true });
    await fs.mkdir(this.runsRoot, { recursive: true });
    await fs.writeFile(this.proofPath(proof.runId), `${JSON.stringify(proof, null, 2)}\n`, 'utf-8');
    await this.upsertIndex(proof);
    return proof;
  }

  async readProof(runId: string): Promise<RunProof> {
    return JSON.parse(await fs.readFile(this.proofPath(runId), 'utf-8')) as RunProof;
  }

  async listProofsByTask(taskId: string): Promise<RunProof[]> {
    const index = await readJsonl<RunProofIndexRecord>(this.indexPath).catch(() => []);
    const runIds = Array.from(new Set(index
      .filter((item) => item.taskId === taskId)
      .map((item) => item.runId)
      .filter(Boolean)));
    const proofs: RunProof[] = [];
    for (const runId of runIds) {
      const proof = await this.readProof(runId).catch(() => null);
      if (proof) proofs.push(proof);
    }
    return proofs.sort((left, right) => left.attempt - right.attempt || left.createdAt.localeCompare(right.createdAt));
  }

  private async upsertIndex(proof: RunProof): Promise<void> {
    const current = await readJsonl<RunProofIndexRecord>(this.indexPath).catch(() => []);
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

  private runDir(runId: string): string {
    return path.join(this.runsRoot, runId);
  }

  private proofPath(runId: string): string {
    return path.join(this.runDir(runId), 'proof.json');
  }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
