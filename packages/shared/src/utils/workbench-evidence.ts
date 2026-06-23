const GIT_STATUS_PATH_PATTERN = /^([ MADRCUD?]{2})\s+(.+)$/;
const GIT_DIFF_PATH_PATTERN = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/;

export function extractModifiedFilesFromEvidenceBody(body: string): string[] {
  const searchableText = [body, ...extractJsonTextSections(body)].join('\n');

  return uniquePaths([
    ...extractBulletSection(searchableText, 'Files modified'),
    ...extractGitModifiedPaths(searchableText),
  ]);
}

function extractJsonTextSections(body: string): string[] {
  return ['Output', 'Error']
    .map((sectionName) => extractNamedSection(body, sectionName))
    .flatMap((section) => extractJsonTextValues(section));
}

function extractJsonTextValues(value: string): string[] {
  if (!value.trim().startsWith('{') && !value.trim().startsWith('[')) {
    return [];
  }

  try {
    return collectTextValues(JSON.parse(value));
  } catch {
    return [];
  }
}

function collectTextValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextValues(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((item) => collectTextValues(item));
  }

  return [];
}

function extractGitModifiedPaths(body: string): string[] {
  return body
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trimEnd();
      const statusPath = parseGitStatusPath(trimmed);
      if (statusPath) {
        return [statusPath];
      }

      const diffPath = parseGitDiffPath(trimmed);
      return diffPath ? [diffPath] : [];
    });
}

function parseGitStatusPath(line: string): string | null {
  const match = line.match(GIT_STATUS_PATH_PATTERN);
  if (!match?.[1] || !match[2] || match[1] === '  ') {
    return null;
  }

  const pathPart = match[2].trim();
  if (!pathPart) {
    return null;
  }

  return stripGitRenamePrefix(pathPart);
}

function parseGitDiffPath(line: string): string | null {
  const match = line.match(GIT_DIFF_PATH_PATTERN);
  if (!match?.[2]) {
    return null;
  }

  return normalizeGitPath(match[2]);
}

function stripGitRenamePrefix(pathPart: string): string {
  const renameSeparator = ' -> ';
  const renameIndex = pathPart.lastIndexOf(renameSeparator);
  return normalizeGitPath(renameIndex >= 0 ? pathPart.slice(renameIndex + renameSeparator.length) : pathPart);
}

function normalizeGitPath(pathPart: string): string {
  return pathPart.trim().replace(/^"|"$/g, '');
}

function extractBulletSection(body: string, sectionName: string): string[] {
  const content = extractNamedSection(body, sectionName);
  if (!content) {
    return [];
  }

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function extractNamedSection(body: string, sectionName: string): string {
  const match = body.match(new RegExp(`${escapeForRegex(sectionName)}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^\\n]*:|$)`));
  return match?.[1]?.trim() || '';
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  paths.forEach((filePath) => {
    if (!filePath || seen.has(filePath)) {
      return;
    }
    seen.add(filePath);
    unique.push(filePath);
  });

  return unique;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
