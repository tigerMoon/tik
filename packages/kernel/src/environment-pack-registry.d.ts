import { type EnvironmentPackManifest } from '@tik/shared';
export declare class EnvironmentPackRegistry {
    private readonly rootPath;
    constructor(rootPath: string);
    listPacks(): Promise<EnvironmentPackManifest[]>;
    getActivePack(): Promise<EnvironmentPackManifest | null>;
    switchActivePack(packId: string): Promise<EnvironmentPackManifest>;
    private packRoot;
    private statePath;
    private readPackDirectories;
    private readActiveState;
    private writeActiveState;
}
//# sourceMappingURL=environment-pack-registry.d.ts.map