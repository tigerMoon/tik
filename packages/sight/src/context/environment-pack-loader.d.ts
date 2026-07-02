import { type EnvironmentContext, type EnvironmentPackSelection } from '@tik/shared';
export declare class EnvironmentPackLoader {
    private readonly projectPath;
    constructor(projectPath: string);
    load(preferredPackId?: string, selection?: EnvironmentPackSelection): Promise<EnvironmentContext | undefined>;
    private listPacks;
    private readActiveState;
}
//# sourceMappingURL=environment-pack-loader.d.ts.map