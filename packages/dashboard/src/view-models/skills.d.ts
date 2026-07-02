import type { EnvironmentPackKnowledgeKind, EnvironmentPackManifest, SkillManifestMutationInput, SkillManifestRegistryEntry, SkillManifestSnapshot } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
export interface SkillKnowledgeDependency {
    id: string;
    label: string;
    kind: EnvironmentPackKnowledgeKind;
}
export interface SkillWorkflowBinding {
    workflow: string;
    phase: string;
    packId: string;
}
export interface SkillManifestRecord {
    id: string;
    label: string;
    scope: 'environment' | 'shared';
    version: string;
    versions: string[];
    ownerPackId: string;
    ownerPackName: string;
    packIds: string[];
    packNames: string[];
    requiredTools: string[];
    requiredKnowledge: SkillKnowledgeDependency[];
    policyHooks: string[];
    evaluators: string[];
    bindings: SkillWorkflowBinding[];
    taskCount: number;
    activeTaskCount: number;
    selectedTaskCount: number;
    lastObservedAt: string | null;
    relatedTasks: WorkbenchTaskResponse[];
    registryEntry: SkillManifestRegistryEntry | null;
}
export interface SkillChecklistItem {
    label: string;
    tone: 'green' | 'yellow';
}
export interface SkillImpactItem {
    title: string;
    detail: string;
}
export interface SkillChangeItem {
    id: string;
    title: string;
    detail: string;
    tone: 'blue' | 'green' | 'yellow';
}
export interface SkillManifestDiff {
    baselineLabel: string | null;
    addedTools: string[];
    removedTools: string[];
    addedKnowledge: string[];
    removedKnowledge: string[];
    addedPolicies: string[];
    removedPolicies: string[];
    addedEvaluators: string[];
    removedEvaluators: string[];
    addedBindings: string[];
    removedBindings: string[];
    notesChanged: boolean;
    scopeChanged: boolean;
    ownerChanged: boolean;
    hasBaseline: boolean;
    hasMaterialChange: boolean;
}
export interface SkillPublishRecommendation {
    currentVersion: string;
    nextVersion: string;
    strategy: 'initial' | 'none' | 'patch' | 'minor' | 'major';
    rationale: string;
    canPublish: boolean;
}
export interface SkillVersionEntry {
    id: string;
    version: string;
    detail: string;
}
export type SkillManifestPersistenceStatus = 'changes-unsaved' | 'draft-saved' | 'published';
export declare function buildSkillManifestRecords(packs: EnvironmentPackManifest[], tasks: WorkbenchTaskResponse[], activePackId?: string | null, registryEntries?: SkillManifestRegistryEntry[]): SkillManifestRecord[];
export declare function buildSkillManifestSnippet(skill: SkillManifestRecord): string;
export declare function buildSkillDependenciesSnippet(skill: SkillManifestRecord): string;
export declare function buildSkillBindingsSnippet(skill: SkillManifestRecord): string;
export declare function buildSkillTestHarnessSnippet(skill: SkillManifestRecord): string;
export declare function buildSkillImpactItems(skill: SkillManifestRecord): SkillImpactItem[];
export declare function buildSkillChecklist(skill: SkillManifestRecord): SkillChecklistItem[];
export declare function buildSkillVersionEntries(skill: SkillManifestRecord): SkillVersionEntry[];
export declare function buildSkillManifestSnapshot(skill: SkillManifestRecord): SkillManifestSnapshot;
export declare function buildSkillManifestMutationInput(skill: SkillManifestRecord, notes: string): SkillManifestMutationInput;
export declare function resolveSkillManifestPersistenceStatus(skill: SkillManifestRecord, notes: string): SkillManifestPersistenceStatus;
export declare function buildSkillManifestDiff(skill: SkillManifestRecord, notes: string): SkillManifestDiff;
export declare function buildSkillChangeItems(skill: SkillManifestRecord, notes: string): SkillChangeItem[];
export declare function buildSkillPublishRecommendation(skill: SkillManifestRecord, notes: string): SkillPublishRecommendation;
export declare function buildSkillPublishMutationInput(skill: SkillManifestRecord, notes: string): SkillManifestMutationInput;
export declare function labelizeSkillId(id: string): string;
//# sourceMappingURL=skills.d.ts.map