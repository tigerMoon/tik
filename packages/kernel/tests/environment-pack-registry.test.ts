import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentPackRegistry } from '../src/environment-pack-registry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createPack(root: string, id: string, name: string): Promise<void> {
  const packDir = path.join(root, 'env-packs', id);
  await fs.mkdir(packDir, { recursive: true });
  await fs.writeFile(path.join(packDir, 'pack.json'), JSON.stringify({
    kind: 'EnvironmentPack',
    id,
    name,
    version: '0.1.0',
    description: `${name} description`,
    tools: ['shell'],
    skills: ['coder'],
    knowledge: [],
    policies: [],
    workflowBindings: [],
    evaluators: [],
  }, null, 2), 'utf-8');
}

describe('EnvironmentPackRegistry', () => {
  it('lists pack manifests and falls back to base-engineering as the active pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-env-pack-registry-'));
    tempDirs.push(root);
    await createPack(root, 'commerce-ops', 'Commerce Ops');
    await createPack(root, 'base-engineering', 'Base Engineering');

    const registry = new EnvironmentPackRegistry(root);
    const packs = await registry.listPacks();
    const active = await registry.getActivePack();

    expect(packs.map((pack) => pack.id)).toEqual(['base-engineering', 'commerce-ops']);
    expect(active?.id).toBe('base-engineering');
  });

  it('persists the switched active pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-env-pack-registry-'));
    tempDirs.push(root);
    await createPack(root, 'base-engineering', 'Base Engineering');
    await createPack(root, 'design-to-code', 'Design To Code');

    const registry = new EnvironmentPackRegistry(root);
    await registry.switchActivePack('design-to-code');

    const reloaded = new EnvironmentPackRegistry(root);
    const active = await reloaded.getActivePack();

    expect(active?.id).toBe('design-to-code');
  });
});
