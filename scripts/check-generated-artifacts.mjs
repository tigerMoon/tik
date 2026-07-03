#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }

  return result.stdout;
}

const trackedFiles = git(['ls-files', '-z', '--', 'packages'])
  .split('\0')
  .filter(Boolean);

const offenders = trackedFiles.filter(
  (file) =>
    /^packages\/[^/]+\/(?:src|tests)\//.test(file) &&
    (file.endsWith('.js') || file.endsWith('.d.ts') || file.endsWith('.map')),
);

if (offenders.length > 0) {
  console.error('Generated artifacts must not be tracked under packages/*/src or packages/*/tests:');
  for (const file of offenders) {
    console.error(`  - ${file}`);
  }
  console.error('Remove these files from source trees; package builds should emit generated output to dist.');
  process.exit(1);
}

console.log('No tracked generated package source/test artifacts found.');
