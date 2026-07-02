import { z } from 'zod';
import { EnvironmentPackKnowledgeKindSchema } from './environment-pack.js';
export const SkillManifestScopeSchema = z.enum(['environment', 'shared']);
export const SkillManifestRevisionKindSchema = z.enum(['draft_saved', 'published']);
export const SkillManifestBindingSchema = z.object({
    workflow: z.string().min(1),
    phase: z.string().min(1),
    packId: z.string().min(1),
});
export const SkillManifestKnowledgeDependencySchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: EnvironmentPackKnowledgeKindSchema,
});
export const SkillManifestSnapshotSchema = z.object({
    skillId: z.string().min(1),
    label: z.string().min(1),
    scope: SkillManifestScopeSchema,
    version: z.string().min(1),
    ownerPackId: z.string().min(1),
    ownerPackName: z.string().min(1),
    packIds: z.array(z.string().min(1)).default([]),
    packNames: z.array(z.string().min(1)).default([]),
    requiredTools: z.array(z.string().min(1)).default([]),
    requiredKnowledge: z.array(SkillManifestKnowledgeDependencySchema).default([]),
    policyHooks: z.array(z.string().min(1)).default([]),
    evaluators: z.array(z.string().min(1)).default([]),
    bindings: z.array(SkillManifestBindingSchema).default([]),
    taskCount: z.number().int().nonnegative().default(0),
    activeTaskCount: z.number().int().nonnegative().default(0),
    selectedTaskCount: z.number().int().nonnegative().default(0),
});
export const SkillManifestDraftRecordSchema = z.object({
    notes: z.string().default(''),
    savedAt: z.string().min(1),
    snapshot: SkillManifestSnapshotSchema,
});
export const SkillManifestPublishedRecordSchema = z.object({
    notes: z.string().default(''),
    publishedAt: z.string().min(1),
    snapshot: SkillManifestSnapshotSchema,
});
export const SkillManifestRevisionSchema = z.object({
    id: z.string().min(1),
    kind: SkillManifestRevisionKindSchema,
    createdAt: z.string().min(1),
    notes: z.string().default(''),
    snapshot: SkillManifestSnapshotSchema,
});
export const SkillManifestRegistryEntrySchema = z.object({
    skillId: z.string().min(1),
    ownerPackId: z.string().min(1),
    scope: SkillManifestScopeSchema,
    draft: SkillManifestDraftRecordSchema.nullable().default(null),
    published: SkillManifestPublishedRecordSchema.nullable().default(null),
    revisions: z.array(SkillManifestRevisionSchema).default([]),
});
export const SkillManifestMutationInputSchema = z.object({
    notes: z.string().default(''),
    snapshot: SkillManifestSnapshotSchema,
});
//# sourceMappingURL=skill-manifest.js.map