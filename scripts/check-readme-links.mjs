import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const readmePath = path.join(repoRoot, 'README.md');
const readme = await readFile(readmePath, 'utf-8');
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
const missing = [];

for (const match of readme.matchAll(linkPattern)) {
  const href = match[1].trim();
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    continue;
  }

  const [withoutAnchor] = href.split('#');
  if (!withoutAnchor) {
    continue;
  }

  const decoded = decodeURIComponent(withoutAnchor);
  const target = path.resolve(path.dirname(readmePath), decoded);
  if (!target.startsWith(repoRoot + path.sep) && target !== repoRoot) {
    missing.push(href);
    continue;
  }

  if (!existsSync(target)) {
    missing.push(href);
    continue;
  }

  const stat = statSync(target);
  if (!stat.isFile() && !stat.isDirectory()) {
    missing.push(href);
  }
}

if (missing.length > 0) {
  console.error('README has broken local links:');
  for (const href of missing) {
    console.error(`- ${href}`);
  }
  process.exit(1);
}
