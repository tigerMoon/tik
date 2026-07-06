#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalOutputHash } from './_generated/questioner-hash.mjs';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const fixturePath = path.join(repoRoot, 'packages', 'shared', 'test-fixtures', 'questioner-hash-vectors.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf-8'));

assert.equal(fixture.schemaVersion, 'questioner-hash-vectors.v1');
assert.ok(fixture.vectors.length >= 10, 'expected at least 10 QuestionerOutput hash vectors');

for (const vector of fixture.vectors) {
  assert.equal(canonicalOutputHash(vector.output), vector.expectedHash, vector.name);
}

const withCreatedAt = fixture.vectors.find((vector) => vector.name === 'base_createdAt_stripped');
const withoutCreatedAt = fixture.vectors.find((vector) => vector.name === 'without_createdAt');
assert.ok(withCreatedAt, 'missing base_createdAt_stripped vector');
assert.ok(withoutCreatedAt, 'missing without_createdAt vector');
assert.equal(
  canonicalOutputHash(withCreatedAt.output),
  canonicalOutputHash(withoutCreatedAt.output),
  'top-level createdAt must not affect QuestionerOutputV2 hash',
);

console.log('canonical QuestionerOutput hash vectors passed');
