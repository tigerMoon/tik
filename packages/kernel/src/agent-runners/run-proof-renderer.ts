import type { AgentRunRecord, RunProof } from '@tik/shared';

export interface RunProofRenderTask {
  id: string;
  shortIdentifier?: string;
  title: string;
  goal?: string;
}

export function renderRunReviewArtifact(input: {
  task: RunProofRenderTask;
  run: AgentRunRecord;
  proof: RunProof;
}): string {
  const { task, run, proof } = input;
  const identifier = task.shortIdentifier || run.shortIdentifier || task.id;
  return [
    '# Run Review',
    '',
    '## Task',
    `- Task: ${task.title}`,
    `- Task ID: ${task.id}`,
    `- Identifier: ${identifier}`,
    `- Attempt: ${proof.attempt + 1}`,
    `- Runner: ${run.runner}`,
    `- Mode: ${run.runnerMode}`,
    `- Worktree: ${run.worktreePath || run.projectPath}`,
    '',
    '## Result',
    proof.summary,
    '',
    '## Diff Summary',
    `- Files changed: ${proof.diff.filesChanged}`,
    `- Insertions: ${formatOptionalNumber(proof.diff.insertions)}`,
    `- Deletions: ${formatOptionalNumber(proof.diff.deletions)}`,
    '',
    '### Changed Files',
    formatList(proof.diff.changedFiles),
    '',
    '## Validation',
    proof.validationRefs.length
      ? proof.validationRefs.map((ref) => `- ${ref.command} (${ref.exitCode ?? 'unknown'}): ${ref.summary || 'no summary'}`).join('\n')
      : '- No validation commands recorded.',
    '',
    '## Risks',
    `- Risk: ${proof.risk}`,
    proof.failure ? `- Failure: ${proof.failure.kind}: ${proof.failure.message}` : '- No failure recorded.',
    '',
    '## Artifacts',
    formatList([
      ...proof.transcriptArtifactIds.map((id) => `Transcript: ${id}`),
      proof.diff.patchArtifactId ? `Patch: ${proof.diff.patchArtifactId}` : undefined,
      proof.diff.statArtifactId ? `Diff stat: ${proof.diff.statArtifactId}` : undefined,
    ].filter((item): item is string => Boolean(item))),
    '',
    '## Suggested Decision',
    '- [ ] Accept',
    '- [ ] Reject and retry',
    '- [ ] Mark failed',
    '',
  ].join('\n');
}

function formatOptionalNumber(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : 'unknown';
}

function formatList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- No entries recorded.';
}
