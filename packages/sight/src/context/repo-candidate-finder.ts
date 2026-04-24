import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

export interface RepoCandidateMatch {
  path: string;
  kind: 'directory' | 'file';
  score: number;
  reason: string;
}

type CandidateEntry = {
  relativePath: string;
  baseName: string;
  kind: 'directory' | 'file';
};

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.tik',
  '.ace',
  '.repo-aware',
]);

export class RepoCandidateFinder {
  async find(
    projectPath: string,
    input: {
      taskDescription: string;
      recentText?: string[];
      sessionSummary?: string;
    },
  ): Promise<RepoCandidateMatch[]> {
    const queryTokens = this.extractQueryTokens([
      input.taskDescription,
      ...(input.recentText || []),
      input.sessionSummary || '',
    ]);

    if (queryTokens.length === 0) {
      return [];
    }

    const entries = await this.collectEntries(projectPath, 4);
    const scored = entries
      .map((entry) => this.scoreEntry(entry, queryTokens))
      .filter((candidate): candidate is RepoCandidateMatch => candidate !== null)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const deduped: RepoCandidateMatch[] = [];
    const seen = new Set<string>();
    for (const candidate of scored) {
      const key = `${candidate.kind}:${candidate.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
      if (deduped.length >= 8) break;
    }

    return deduped;
  }

  private extractQueryTokens(chunks: string[]): string[] {
    const rawTokens = chunks
      .flatMap((chunk) => chunk.match(/[A-Za-z0-9][A-Za-z0-9._-]{1,}/g) || [])
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3);

    const expanded = new Set<string>();
    for (const token of rawTokens) {
      expanded.add(token);
      for (const part of token.split(/[-_.]/)) {
        if (part.length >= 3) expanded.add(part);
      }
    }

    return Array.from(expanded);
  }

  private async collectEntries(projectPath: string, maxDepth: number): Promise<CandidateEntry[]> {
    const results: CandidateEntry[] = [];

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;

      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') && !entry.name.startsWith('.spec')) {
          if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
        }
        if (EXCLUDED_DIRS.has(entry.name)) continue;

        const absolutePath = path.join(dir, entry.name);
        const relativePath = path.relative(projectPath, absolutePath) || entry.name;

        if (entry.isDirectory()) {
          results.push({
            relativePath,
            baseName: entry.name.toLowerCase(),
            kind: 'directory',
          });
          await visit(absolutePath, depth + 1);
        } else if (entry.isFile()) {
          results.push({
            relativePath,
            baseName: entry.name.toLowerCase(),
            kind: 'file',
          });
        }
      }
    };

    await visit(projectPath, 0);
    return results;
  }

  private scoreEntry(entry: CandidateEntry, queryTokens: string[]): RepoCandidateMatch | null {
    let score = 0;
    const reasons: string[] = [];
    const entryPath = entry.relativePath.toLowerCase();
    const matched = new Set<string>();

    for (const token of queryTokens) {
      if (entry.baseName === token) {
        score += 1.0;
        matched.add(token);
        reasons.push(`basename matches "${token}"`);
        continue;
      }
      if (entry.baseName.includes(token)) {
        score += 0.85;
        matched.add(token);
        reasons.push(`basename contains "${token}"`);
        continue;
      }
      if (entryPath.includes(token)) {
        score += 0.65;
        matched.add(token);
        reasons.push(`path contains "${token}"`);
        continue;
      }
    }

    const basenameParts = entry.baseName.split(/[-_.]/).filter(Boolean);
    const overlap = basenameParts.filter((part) => queryTokens.includes(part)).length;
    if (overlap > 1) {
      score += overlap * 0.2;
      reasons.push(`multiple token overlap (${overlap})`);
    }

    if (entry.kind === 'directory') {
      score += 0.05;
    }

    if (matched.size === 0 || score < 0.8) {
      return null;
    }

    return {
      path: entry.relativePath,
      kind: entry.kind,
      score: Number(score.toFixed(2)),
      reason: reasons.slice(0, 2).join('; '),
    };
  }
}
