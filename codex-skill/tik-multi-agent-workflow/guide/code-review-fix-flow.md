# Code Review Fix Flow

When the user invokes this skill to fix review findings and provides no workflow id:

1. Select the Tik API bound to the correct workspace root, then run `init --goal "<fix the listed review findings>" --workspace-root <workspace-root> --path <repo-or-worktree> --repo <project>` and capture the `workflowId`. If discovery reuses a workflow, use that one instead of creating a new one.
2. Create or obtain a TaskGraph that maps the findings to subtasks, then run `accept-plan`.
3. Implement the fix in the current Codex session.
4. Run `execute --workflow <workflowId> --subtask <id> --summary "<what changed>"`.
5. Run `validate --workflow <workflowId> --subtask <id> --command "<targeted tests>"` for the proof commands.
6. Use `evaluate`, then `start-questioner`; Tik launches the background Questioner. Complete the subtask only after Tik records the callback `QuestionerOutputV2`.
7. Complete the workflow through the final evaluator/questioner path, then confirm `status`.

If you cannot create or accept a TaskGraph because Tik is unavailable, state that blocker before making local-only edits.

## Commit-to-Closure

Every `init` must be followed by either:

- `complete-workflow` — the workflow finished and was signed off, **or**
- `abandon-workflow --workflow <id> --reason <text>` — the workflow will not be finished; sets status to `aborted` and clears it from discovery, **or**
- `pause-workflow --workflow <id> --reason <text>` — the workflow is paused for later; writes `metadata.pausedAt` so future `init` discovery skips it but the workflow can still be resumed by passing `--workflow <id>` explicitly.

An `init` that never closes accumulates as an orphan and inflates every future `init`'s discovery result. Don't leave workflows open across turns without a documented reason.
