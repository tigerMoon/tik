import type {
  ArtifactKind,
  WorkbenchArtifactRecord,
  WorkbenchTaskRecord,
  WorkbenchTimelineItem,
} from '@tik/shared';

export type ArtifactTemplateName =
  | 'task-review'
  | 'pr-walkthrough'
  | 'investigation-timeline'
  | 'option-comparison'
  | 'release-checklist'
  | 'tracker-attempt-report';

export interface RenderArtifactTemplateInput {
  template: ArtifactTemplateName;
  task: WorkbenchTaskRecord;
  timeline?: WorkbenchTimelineItem[];
  artifacts?: WorkbenchArtifactRecord[];
}

export interface RenderedArtifactTemplate {
  title: string;
  kind: ArtifactKind;
  contentType: string;
  extension: 'md';
  content: string;
  summary: string;
  tags: string[];
}

export const ARTIFACT_TEMPLATE_NAMES: ArtifactTemplateName[] = [
  'task-review',
  'pr-walkthrough',
  'investigation-timeline',
  'option-comparison',
  'release-checklist',
  'tracker-attempt-report',
];

export function renderArtifactTemplate(input: RenderArtifactTemplateInput): RenderedArtifactTemplate {
  switch (input.template) {
    case 'pr-walkthrough':
      return renderSectionedTemplate(input, 'PR Walkthrough', 'report', [
        'High-level summary',
        'File-by-file diff walkthrough',
        'Why each change was made',
        'Compatibility notes',
        'Tests run',
        'Rollback plan',
      ]);
    case 'investigation-timeline':
      return renderSectionedTemplate(input, 'Investigation Timeline', 'timeline', [
        'Symptoms',
        'Timeline',
        'Hypotheses',
        'Evidence',
        'Root cause',
        'Fix options',
        'Chosen fix',
        'Validation',
        'Follow-up tasks',
      ]);
    case 'option-comparison':
      return renderSectionedTemplate(input, 'Option Comparison', 'comparison', [
        'Options',
        'Trade-offs',
        'Risk matrix',
        'Cost',
        'Recommendation',
        'Decision needed',
      ]);
    case 'release-checklist':
      return renderSectionedTemplate(input, 'Release Checklist', 'checklist', [
        'Release scope',
        'Migration steps',
        'Verification checklist',
        'Monitoring signals',
        'Rollback plan',
        'Owner checklist',
      ]);
    case 'tracker-attempt-report':
      return renderSectionedTemplate(input, 'Tracker Attempt Report', 'report', [
        'Task',
        'Attempt number',
        'Agent / provider / model',
        'Dispatch reason',
        'Worktree path',
        'Events summary',
        'Changed files',
        'Result',
        'Failure / retry reason',
        'Human review notes',
      ]);
    case 'task-review':
    default:
      return renderTaskReviewTemplate(input);
  }
}

function renderTaskReviewTemplate(input: RenderArtifactTemplateInput): RenderedArtifactTemplate {
  const task = input.task;
  const timeline = input.timeline || [];
  const latestRaw = timeline.filter((item) => item.kind === 'raw').slice(-8);
  const latestSummaries = timeline.filter((item) => item.kind === 'summary').slice(-8);
  const existingArtifacts = input.artifacts || [];
  const content = [
    `# Task Review: ${task.title}`,
    '',
    '## Goal',
    task.goal || 'No goal recorded.',
    '',
    '## Scope',
    task.description || 'No explicit non-goals recorded.',
    '',
    '## Changed Files',
    formatList(task.evidenceSummary?.modifiedFileCount
      ? [`${task.evidenceSummary.modifiedFileCount} file(s) modified according to evidence summary.`]
      : []),
    '',
    '## Timeline Summary',
    formatList(latestSummaries.map((item) => `${item.createdAt}: ${item.body}`)),
    '',
    '## Key Decisions',
    task.waitingDecisionId
      ? `Open decision: ${task.waitingDecisionId}`
      : 'No open decisions recorded.',
    '',
    '## Tests / Validation',
    formatList(existingArtifacts.flatMap((artifact) => artifact.validationRefs || [])),
    '',
    '## Risks',
    task.evidenceSummary?.hasErrorEvidence
      ? '- Latest evidence includes an error; review raw evidence before accepting.'
      : '- No explicit risk notes recorded.',
    '',
    '## Follow-up Items',
    '- Confirm the latest artifact status before closing the task.',
    '',
    '## Reviewer Checklist',
    '- [ ] Review changed files',
    '- [ ] Verify validation refs',
    '- [ ] Accept or request changes on this artifact',
    '',
    '## Raw Evidence Digest',
    formatList(latestRaw.map((item) => `${item.createdAt}: ${item.body.split('\n')[0] || 'raw evidence'}`)),
  ].join('\n');

  return {
    title: `Task Review: ${task.title}`,
    kind: 'report',
    contentType: 'text/markdown',
    extension: 'md',
    content,
    summary: `Task review artifact for ${task.id}.`,
    tags: ['task-review'],
  };
}

function renderSectionedTemplate(
  input: RenderArtifactTemplateInput,
  titlePrefix: string,
  kind: ArtifactKind,
  sections: string[],
): RenderedArtifactTemplate {
  const content = [
    `# ${titlePrefix}: ${input.task.title}`,
    '',
    `Task: ${input.task.shortIdentifier || input.task.identifier || input.task.id}`,
    '',
    ...sections.flatMap((section) => [
      `## ${section}`,
      placeholderForSection(section),
      '',
    ]),
  ].join('\n');

  return {
    title: `${titlePrefix}: ${input.task.title}`,
    kind,
    contentType: 'text/markdown',
    extension: 'md',
    content,
    summary: `${titlePrefix} artifact for ${input.task.id}.`,
    tags: [titlePrefix.toLowerCase().replace(/\s+/g, '-')],
  };
}

function formatList(items: string[]): string {
  if (items.length === 0) {
    return '- No entries recorded.';
  }
  return items.map((item) => `- ${item.replace(/\n/g, '\n  ')}`).join('\n');
}

function placeholderForSection(section: string): string {
  return `- ${section} details will be filled from task evidence during review.`;
}
