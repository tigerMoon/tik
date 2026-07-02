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
import type { BootstrapContext } from '@tik/shared';
export declare class BootstrapContextBuilder {
    /**
     * Build a complete bootstrap context snapshot.
     */
    build(projectPath: string): Promise<BootstrapContext>;
    private getGitStatus;
    private getGitDiff;
    /**
     * Walk up directory tree from projectPath to root,
     * looking for instruction files at each level.
     * Deduplicates by content hash.
     */
    private discoverInstructionFiles;
}
//# sourceMappingURL=bootstrap-context.d.ts.map