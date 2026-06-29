export interface WorkbenchTaskGoalAttachment {
  id: string;
  kind: 'image' | 'markdown';
  name: string;
  markdown: string;
}

export interface WorkbenchTaskLaunchAttachmentValidation {
  valid: boolean;
  titleError: string | null;
  goalError: string | null;
}

export function validateWorkbenchTaskLaunchDraftWithAttachments(input: {
  title: string;
  goal: string;
  attachmentCount?: number;
}): WorkbenchTaskLaunchAttachmentValidation {
  const titleError = input.title.trim() ? null : 'Task title is required.';
  const goalError = input.goal.trim() || (input.attachmentCount || 0) > 0
    ? null
    : 'Task goal is required.';

  return {
    valid: !titleError && !goalError,
    titleError,
    goalError,
  };
}

export function buildWorkbenchTaskGoalImageMarkdown(input: {
  name: string;
  type: string;
  dataUrl: string;
}): string {
  return `![${sanitizeMarkdownAltText(input.name) || 'pasted image'}](${input.dataUrl})`;
}

export function buildWorkbenchTaskGoalMarkdownFileSection(input: {
  name: string;
  text: string;
}): string {
  const filename = input.name.trim() || 'pasted markdown';
  return [`### ${filename}`, '', input.text.trim()].join('\n');
}

export function appendWorkbenchTaskGoalAttachments(
  goal: string,
  attachments: WorkbenchTaskGoalAttachment[],
): string {
  const attachmentMarkdown = attachments
    .map((attachment) => attachment.markdown.trim())
    .filter(Boolean)
    .join('\n\n');

  if (!attachmentMarkdown) {
    return goal.trim();
  }

  return [
    goal.trim(),
    '### Attached context',
    attachmentMarkdown,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function isSupportedWorkbenchTaskGoalFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isWorkbenchTaskGoalImage(file) || isWorkbenchTaskGoalMarkdown(file);
}

export function isWorkbenchTaskGoalImage(file: Pick<File, 'type'>): boolean {
  return /^image\//i.test(file.type);
}

export function isWorkbenchTaskGoalMarkdown(file: Pick<File, 'name' | 'type'>): boolean {
  return /^text\/markdown\b/i.test(file.type)
    || /\bmarkdown\b/i.test(file.type)
    || /\.md(?:own|arkdown)?$/i.test(file.name);
}

function sanitizeMarkdownAltText(value: string): string {
  return value.replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
