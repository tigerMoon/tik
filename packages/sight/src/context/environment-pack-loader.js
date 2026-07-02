import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyEnvironmentPackSelection, EnvironmentPackManifestSchema, } from '@tik/shared';
export class EnvironmentPackLoader {
    projectPath;
    constructor(projectPath) {
        this.projectPath = projectPath;
    }
    async load(preferredPackId, selection) {
        const packs = await this.listPacks();
        if (packs.length === 0) {
            return undefined;
        }
        const activeState = await this.readActiveState();
        const preferredPack = preferredPackId
            ? packs.find((pack) => pack.id === preferredPackId)
            : undefined;
        if (preferredPackId && !preferredPack) {
            return undefined;
        }
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
    async listPacks() {
        try {
            const entries = await fs.readdir(path.join(this.projectPath, 'env-packs'), { withFileTypes: true });
            const packs = await Promise.all(entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                const manifestPath = path.join(this.projectPath, 'env-packs', entry.name, 'pack.json');
                const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
                return EnvironmentPackManifestSchema.parse(raw);
            }));
            return packs.sort((left, right) => left.name.localeCompare(right.name));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }
    async readActiveState() {
        try {
            return JSON.parse(await fs.readFile(path.join(this.projectPath, '.tik', 'environment-pack.json'), 'utf-8'));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return {
                    activePackId: null,
                    updatedAt: new Date(0).toISOString(),
                };
            }
            throw error;
        }
    }
}
//# sourceMappingURL=environment-pack-loader.js.map