/**
 * Bootstrap Context Builder (Phase 2.8)
 *
 * Collects runtime environment snapshot (claw-style):
 * - cwd, date, os
 * - git status, git diff
 * - Instruction files (CLAUDE.md / AGENTS.md families, etc.)
 *
 * This is NOT repo knowledge or memory — it's an "environment snapshot"
 * that should not be mixed into SIGHT's structured context categories.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { BootstrapContext, ContextFile } from '@tik/shared';

const execFileAsync = promisify(execFile);

const MAX_INSTRUCTION_FILE_CHARS = 4_000;
const MAX_TOTAL_INSTRUCTION_CHARS = 12_000;
const MAX_GIT_DIFF_CHARS = 8_000;

/**
 * Instruction file names to search for at each directory level.
 */
const INSTRUCTION_FILENAMES = [
  'CLAUDE.md',
  'claude.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'agents.md',
  '.agents/AGENTS.md',
  '.agents/agents.md',
  '.agents/instructions.md',
  '.claude/CLAUDE.md',
  '.claude/claude.md',
  '.claude/instructions.md',
];

export class BootstrapContextBuilder {
  /**
   * Build a complete bootstrap context snapshot.
   */
  async build(projectPath: string): Promise<BootstrapContext> {
    const [gitStatus, gitDiff, instructionFiles] = await Promise.all([
      this.getGitStatus(projectPath),
      this.getGitDiff(projectPath),
      this.discoverInstructionFiles(projectPath),
    ]);

    return {
      cwd: projectPath,
      currentDate: new Date().toISOString().split('T')[0],
      os: `${process.platform} ${process.arch}`,
      gitStatus: gitStatus || undefined,
      gitDiff: gitDiff || undefined,
      instructionFiles: instructionFiles.length > 0 ? instructionFiles : undefined,
    };
  }

  // ─── Git ──────────────────────────────────────────────────

  private async getGitStatus(projectPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'],
        { cwd: projectPath, timeout: 5_000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async getGitDiff(projectPath: string): Promise<string | null> {
    try {
      // Staged + unstaged
      const { stdout: staged } = await execFileAsync('git', ['diff', '--cached', '--stat'],
        { cwd: projectPath, timeout: 5_000 });
      const { stdout: unstaged } = await execFileAsync('git', ['diff', '--stat'],
        { cwd: projectPath, timeout: 5_000 });

      const combined = [staged.trim(), unstaged.trim()].filter(Boolean).join('\n');
      if (!combined) return null;

      return combined.slice(0, MAX_GIT_DIFF_CHARS);
    } catch {
      return null;
    }
  }

  // ─── Instruction Files ────────────────────────────────────

  /**
   * Walk up directory tree from projectPath to root,
   * looking for instruction files at each level.
   * Deduplicates by content hash.
   */
  private async discoverInstructionFiles(projectPath: string): Promise<ContextFile[]> {
    const directories: string[] = [];
    let current: string | null = path.resolve(projectPath);

    // Walk up to root (max 10 levels to avoid infinite loops)
    for (let i = 0; i < 10 && current; i++) {
      directories.push(current);
      const parent = path.dirname(current);
      if (parent === current) break; // reached root
      current = parent;
    }

    // Reverse so we go from root → project (parent files first)
    directories.reverse();

    const files: ContextFile[] = [];
    const seenHashes = new Set<string>();
    let totalChars = 0;

    for (const dir of directories) {
      for (const filename of INSTRUCTION_FILENAMES) {
        const filePath = path.join(dir, filename);
        try {
          let content = await fs.readFile(filePath, 'utf-8');

          // Per-file size limit
          if (content.length > MAX_INSTRUCTION_FILE_CHARS) {
            content = content.slice(0, MAX_INSTRUCTION_FILE_CHARS) + '\n[... truncated]';
          }

          // Dedup by content hash
          const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);

          // Total budget check
          if (totalChars + content.length > MAX_TOTAL_INSTRUCTION_CHARS) break;

          const scope = dir === projectPath ? 'project'
            : dir === path.dirname(projectPath) ? 'parent'
            : 'workspace';

          files.push({
            path: path.relative(projectPath, filePath) || filePath,
            content,
            scope,
          });

          totalChars += content.length;
        } catch {
          // File doesn't exist at this level
        }
      }
    }

    return files;
  }
}
