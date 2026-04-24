import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  applyEnvironmentPackSelection,
  EnvironmentPackManifestSchema,
  type ActiveEnvironmentPackState,
  type EnvironmentContext,
  type EnvironmentPackSelection,
} from '@tik/shared';

export class EnvironmentPackLoader {
  constructor(private readonly projectPath: string) {}

  async load(preferredPackId?: string, selection?: EnvironmentPackSelection): Promise<EnvironmentContext | undefined> {
    const packs = await this.listPacks();
    if (packs.length === 0) {
      return undefined;
    }

    const activeState = await this.readActiveState();
    const preferredPack = preferredPackId
      ? packs.find((pack) => pack.id === preferredPackId)
      : undefined;
    const activePack = activeState.activePackId
      ? packs.find((pack) => pack.id === activeState.activePackId)
      : undefined;
    const fallbackPack = preferredPack || activePack || packs.find((pack) => pack.id === 'base-engineering') || packs[0];

    if (!fallbackPack) {
      return undefined;
    }

    return {
      activePackId: fallbackPack.id,
      activePack: applyEnvironmentPackSelection(fallbackPack, selection),
      taskSelection: selection,
      availablePackIds: packs.map((pack) => pack.id),
      source: path.join(this.projectPath, 'env-packs'),
      updatedAt: activeState.updatedAt,
    };
  }

  private async listPacks() {
    try {
      const entries = await fs.readdir(path.join(this.projectPath, 'env-packs'), { withFileTypes: true });
      const packs = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const manifestPath = path.join(this.projectPath, 'env-packs', entry.name, 'pack.json');
          const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as unknown;
          return EnvironmentPackManifestSchema.parse(raw);
        }));
      return packs.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readActiveState(): Promise<ActiveEnvironmentPackState> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.projectPath, '.tik', 'environment-pack.json'), 'utf-8'),
      ) as ActiveEnvironmentPackState;
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
}
