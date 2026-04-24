import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  EnvironmentPackManifestSchema,
  type ActiveEnvironmentPackState,
  type EnvironmentPackManifest,
} from '@tik/shared';

export class EnvironmentPackRegistry {
  constructor(private readonly rootPath: string) {}

  async listPacks(): Promise<EnvironmentPackManifest[]> {
    const packDirs = await this.readPackDirectories();
    const packs = await Promise.all(packDirs.map(async (dirName) => {
      const manifestPath = path.join(this.packRoot(), dirName, 'pack.json');
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as unknown;
      return EnvironmentPackManifestSchema.parse(raw);
    }));

    return packs.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getActivePack(): Promise<EnvironmentPackManifest | null> {
    const packs = await this.listPacks();
    if (packs.length === 0) {
      return null;
    }

    const state = await this.readActiveState();
    const persisted = state.activePackId
      ? packs.find((pack) => pack.id === state.activePackId)
      : undefined;
    if (persisted) {
      return persisted;
    }

    const fallback = packs.find((pack) => pack.id === 'base-engineering') || packs[0] || null;
    if (fallback) {
      await this.writeActiveState({
        activePackId: fallback.id,
        updatedAt: new Date().toISOString(),
      });
    }
    return fallback;
  }

  async switchActivePack(packId: string): Promise<EnvironmentPackManifest> {
    const packs = await this.listPacks();
    const pack = packs.find((item) => item.id === packId);
    if (!pack) {
      throw new Error(`Environment pack not found: ${packId}`);
    }

    await this.writeActiveState({
      activePackId: pack.id,
      updatedAt: new Date().toISOString(),
    });

    return pack;
  }

  private packRoot(): string {
    return path.join(this.rootPath, 'env-packs');
  }

  private statePath(): string {
    return path.join(this.rootPath, '.tik', 'environment-pack.json');
  }

  private async readPackDirectories(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.packRoot(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readActiveState(): Promise<ActiveEnvironmentPackState> {
    try {
      return JSON.parse(await fs.readFile(this.statePath(), 'utf-8')) as ActiveEnvironmentPackState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          activePackId: null,
          updatedAt: new Date(0).toISOString(),
        };
      }
      throw error;
    }
  }

  private async writeActiveState(state: ActiveEnvironmentPackState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath()), { recursive: true });
    await fs.writeFile(this.statePath(), JSON.stringify(state, null, 2), 'utf-8');
  }
}
