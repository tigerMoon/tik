import type { WorkbenchArtifactRecord } from '@tik/shared';

export type ArtifactPreviewMode = 'document' | 'diff' | 'diff-stat' | 'log' | 'text' | 'embed';

export interface ArtifactDiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'remove' | 'context';
  text: string;
}

export interface ArtifactDiffFile {
  path: string;
  lines: ArtifactDiffLine[];
}

export interface ArtifactDiffModel {
  files: ArtifactDiffFile[];
}

export interface ArtifactDiffStatRow {
  filePath: string;
  changes: number;
  additions: number;
  deletions: number;
}

export interface ArtifactDiffStatModel {
  rows: ArtifactDiffStatRow[];
  summary?: string;
  rawLines: string[];
}

export interface ArtifactLogSection {
  title: string;
  lines: Array<{ number: number; text: string }>;
}

export function classifyArtifactPreviewMode(artifact: WorkbenchArtifactRecord): ArtifactPreviewMode {
  const contentType = artifact.contentType.toLowerCase();
  const template = artifact.producedBy.template || '';
  const tags = artifact.tags || [];

  if (template === 'run-diff-stat' || tags.includes('run-diff-stat')) {
    return 'diff-stat';
  }
  if (artifact.kind === 'diff' || contentType.includes('x-diff') || contentType.includes('patch')) {
    return 'diff';
  }
  if (artifact.kind === 'transcript' || template === 'run-transcript') {
    return 'log';
  }
  if (contentType.includes('markdown') || artifact.kind === 'run_review' || artifact.kind === 'report') {
    return 'document';
  }
  if (contentType.startsWith('text/') || contentType.includes('json')) {
    return 'text';
  }
  return 'embed';
}

export function shouldFetchArtifactPreviewText(mode: ArtifactPreviewMode): boolean {
  return mode === 'diff' || mode === 'diff-stat' || mode === 'log' || mode === 'text';
}

export function parseArtifactDiff(content: string): ArtifactDiffModel {
  const files: ArtifactDiffFile[] = [];
  let current: ArtifactDiffFile | null = null;

  for (const line of splitLines(content)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = { path: fileMatch[2] || fileMatch[1] || 'Patch', lines: [] };
      files.push(current);
      continue;
    }

    if (!current) {
      current = { path: 'Patch', lines: [] };
      files.push(current);
    }
    current.lines.push({
      kind: classifyDiffLine(line),
      text: line,
    });
  }

  return { files };
}

export function parseArtifactDiffStat(content: string): ArtifactDiffStatModel {
  const rows: ArtifactDiffStatRow[] = [];
  let summary: string | undefined;
  const rawLines = splitLines(content).filter((line) => line.trim().length > 0);

  for (const line of rawLines) {
    if (/\bfiles? changed\b/.test(line)) {
      summary = line.trim();
      continue;
    }

    const match = /^\s*(.+?)\s+\|\s+(\d+)(?:\s+([+\-]+))?/.exec(line);
    if (!match) continue;
    const glyphs = match[3] || '';
    rows.push({
      filePath: match[1]?.trim() || 'unknown',
      changes: Number(match[2] || 0),
      additions: countChars(glyphs, '+'),
      deletions: countChars(glyphs, '-'),
    });
  }

  return { rows, summary, rawLines };
}

export function parseArtifactLogSections(content: string): ArtifactLogSection[] {
  const sections: Array<{ title: string; rawLines: string[] }> = [];
  let current: { title: string; rawLines: string[] } | null = null;

  for (const line of splitLines(content)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1] || 'Log', rawLines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: 'Log', rawLines: [] };
      sections.push(current);
    }
    current.rawLines.push(line);
  }

  return sections
    .map((section) => {
      const lines = trimBlankEdges(section.rawLines);
      return {
        title: section.title,
        lines: lines.map((text, index) => ({ number: index + 1, text })),
      };
    })
    .filter((section) => section.lines.length > 0);
}

function classifyDiffLine(line: string): ArtifactDiffLine['kind'] {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  if (/^(index|new file|deleted file|similarity|rename from|rename to)\b/.test(line)) return 'meta';
  return 'context';
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(start, end);
}

function countChars(value: string, char: string): number {
  return Array.from(value).filter((item) => item === char).length;
}
