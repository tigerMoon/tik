import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EnvironmentPackManifestSchema, } from '@tik/shared';
export class EnvironmentPackRegistry {
    rootPath;
    constructor(rootPath) {
        this.rootPath = rootPath;
    }
    async listPacks() {
        const packDirs = await this.readPackDirectories();
        const packs = await Promise.all(packDirs.map(async (dirName) => {
            const manifestPath = path.join(this.packRoot(), dirName, 'pack.json');
            const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
            return EnvironmentPackManifestSchema.parse(raw);
        }));
        return packs.sort((left, right) => left.name.localeCompare(right.name));
    }
    async getActivePack() {
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
    async switchActivePack(packId) {
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
    packRoot() {
        return path.join(this.rootPath, 'env-packs');
    }
    statePath() {
        return path.join(this.rootPath, '.tik', 'environment-pack.json');
    }
    async readPackDirectories() {
        try {
            const entries = await fs.readdir(this.packRoot(), { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
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
            return JSON.parse(await fs.readFile(this.statePath(), 'utf-8'));
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
    async writeActiveState(state) {
        await fs.mkdir(path.dirname(this.statePath()), { recursive: true });
        await fs.writeFile(this.statePath(), JSON.stringify(state, null, 2), 'utf-8');
    }
}
//# sourceMappingURL=environment-pack-registry.js.map