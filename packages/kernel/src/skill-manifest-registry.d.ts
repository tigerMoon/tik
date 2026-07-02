import { type SkillManifestMutationInput, type SkillManifestRegistryEntry } from '@tik/shared';
export declare class SkillManifestRegistry {
    private readonly rootPath;
    private operationQueue;
    constructor(rootPath: string);
    listSkills(): Promise<SkillManifestRegistryEntry[]>;
    readSkill(skillId: string): Promise<SkillManifestRegistryEntry | null>;
    saveDraft(skillId: string, input: SkillManifestMutationInput): Promise<SkillManifestRegistryEntry>;
    publish(skillId: string, input: SkillManifestMutationInput): Promise<SkillManifestRegistryEntry>;
    private rootDir;
    private indexPath;
    private readIndex;
    private writeIndex;
    private withLock;
}
//# sourceMappingURL=skill-manifest-registry.d.ts.map