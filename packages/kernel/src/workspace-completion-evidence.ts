import type { WorkflowExecutionReadyContract } from '@tik/shared';

export interface CompletionEvidence {
  targetFiles: string[];
  matchedTargets: string[];
  changedFiles: string[];
  changedTests: string[];
  artifacts: string[];
  validationRuns: string[];
  blocker?: string;
  validationSummary: string;
}

export function collectCompletionEvidence(
  changedFiles: Iterable<string>,
  executionContract?: WorkflowExecutionReadyContract,
): CompletionEvidence | null {
  if (!executionContract?.targetFiles?.length) return null;
  const normalizedChanged = Array.from(new Set(changedFiles));
  const matchedTargets = executionContract.targetFiles.filter((targetFile) => normalizedChanged.includes(targetFile));
  if (matchedTargets.length === 0) return null;
  const changedTests = normalizedChanged.filter(isTestLikePath);
  return {
    targetFiles: executionContract.targetFiles,
    matchedTargets,
    changedFiles: normalizedChanged,
    changedTests,
    artifacts: matchedTargets,
    validationRuns: changedTests.map((file) => `changed-test:${file}`),
    validationSummary: changedTests.length > 0
      ? `validation artifacts: ${changedTests.join(', ')}`
      : 'validation still requires environment-backed execution.',
  };
}

export function summarizeCompletionEvidence(evidence: CompletionEvidence): string {
  return `Detected implementation artifacts matching the ACE execution contract. changed: ${evidence.matchedTargets.join(', ')}. ${evidence.validationSummary}`;
}

function isTestLikePath(file: string): boolean {
  return /(^|\/)(src\/test|test|tests|__tests__)\/|\.test\.|\.spec\./i.test(file);
}
