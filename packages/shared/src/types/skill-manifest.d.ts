import { z } from 'zod';
export declare const SkillManifestScopeSchema: z.ZodEnum<["environment", "shared"]>;
export declare const SkillManifestRevisionKindSchema: z.ZodEnum<["draft_saved", "published"]>;
export declare const SkillManifestBindingSchema: z.ZodObject<{
    workflow: z.ZodString;
    phase: z.ZodString;
    packId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    phase: string;
    workflow: string;
    packId: string;
}, {
    phase: string;
    workflow: string;
    packId: string;
}>;
export declare const SkillManifestKnowledgeDependencySchema: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
    label: string;
}, {
    id: string;
    kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
    label: string;
}>;
export declare const SkillManifestSnapshotSchema: z.ZodObject<{
    skillId: z.ZodString;
    label: z.ZodString;
    scope: z.ZodEnum<["environment", "shared"]>;
    version: z.ZodString;
    ownerPackId: z.ZodString;
    ownerPackName: z.ZodString;
    packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }, {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }>, "many">>;
    policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        workflow: z.ZodString;
        phase: z.ZodString;
        packId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        phase: string;
        workflow: string;
        packId: string;
    }, {
        phase: string;
        workflow: string;
        packId: string;
    }>, "many">>;
    taskCount: z.ZodDefault<z.ZodNumber>;
    activeTaskCount: z.ZodDefault<z.ZodNumber>;
    selectedTaskCount: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    version: string;
    label: string;
    bindings: {
        phase: string;
        workflow: string;
        packId: string;
    }[];
    evaluators: string[];
    ownerPackId: string;
    ownerPackName: string;
    taskCount: number;
    activeTaskCount: number;
    selectedTaskCount: number;
    requiredTools: string[];
    requiredKnowledge: {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }[];
    policyHooks: string[];
    scope: "shared" | "environment";
    packIds: string[];
    skillId: string;
    packNames: string[];
}, {
    version: string;
    label: string;
    ownerPackId: string;
    ownerPackName: string;
    scope: "shared" | "environment";
    skillId: string;
    bindings?: {
        phase: string;
        workflow: string;
        packId: string;
    }[] | undefined;
    evaluators?: string[] | undefined;
    taskCount?: number | undefined;
    activeTaskCount?: number | undefined;
    selectedTaskCount?: number | undefined;
    requiredTools?: string[] | undefined;
    requiredKnowledge?: {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }[] | undefined;
    policyHooks?: string[] | undefined;
    packIds?: string[] | undefined;
    packNames?: string[] | undefined;
}>;
export declare const SkillManifestDraftRecordSchema: z.ZodObject<{
    notes: z.ZodDefault<z.ZodString>;
    savedAt: z.ZodString;
    snapshot: z.ZodObject<{
        skillId: z.ZodString;
        label: z.ZodString;
        scope: z.ZodEnum<["environment", "shared"]>;
        version: z.ZodString;
        ownerPackId: z.ZodString;
        ownerPackName: z.ZodString;
        packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }>, "many">>;
        policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
            workflow: z.ZodString;
            phase: z.ZodString;
            packId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            phase: string;
            workflow: string;
            packId: string;
        }, {
            phase: string;
            workflow: string;
            packId: string;
        }>, "many">>;
        taskCount: z.ZodDefault<z.ZodNumber>;
        activeTaskCount: z.ZodDefault<z.ZodNumber>;
        selectedTaskCount: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    }, {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    notes: string;
    savedAt: string;
    snapshot: {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    };
}, {
    savedAt: string;
    snapshot: {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    };
    notes?: string | undefined;
}>;
export declare const SkillManifestPublishedRecordSchema: z.ZodObject<{
    notes: z.ZodDefault<z.ZodString>;
    publishedAt: z.ZodString;
    snapshot: z.ZodObject<{
        skillId: z.ZodString;
        label: z.ZodString;
        scope: z.ZodEnum<["environment", "shared"]>;
        version: z.ZodString;
        ownerPackId: z.ZodString;
        ownerPackName: z.ZodString;
        packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }>, "many">>;
        policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
            workflow: z.ZodString;
            phase: z.ZodString;
            packId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            phase: string;
            workflow: string;
            packId: string;
        }, {
            phase: string;
            workflow: string;
            packId: string;
        }>, "many">>;
        taskCount: z.ZodDefault<z.ZodNumber>;
        activeTaskCount: z.ZodDefault<z.ZodNumber>;
        selectedTaskCount: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    }, {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    notes: string;
    snapshot: {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    };
    publishedAt: string;
}, {
    snapshot: {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    };
    publishedAt: string;
    notes?: string | undefined;
}>;
export declare const SkillManifestRevisionSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<["draft_saved", "published"]>;
    createdAt: z.ZodString;
    notes: z.ZodDefault<z.ZodString>;
    snapshot: z.ZodObject<{
        skillId: z.ZodString;
        label: z.ZodString;
        scope: z.ZodEnum<["environment", "shared"]>;
        version: z.ZodString;
        ownerPackId: z.ZodString;
        ownerPackName: z.ZodString;
        packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }>, "many">>;
        policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
            workflow: z.ZodString;
            phase: z.ZodString;
            packId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            phase: string;
            workflow: string;
            packId: string;
        }, {
            phase: string;
            workflow: string;
            packId: string;
        }>, "many">>;
        taskCount: z.ZodDefault<z.ZodNumber>;
        activeTaskCount: z.ZodDefault<z.ZodNumber>;
        selectedTaskCount: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    }, {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    createdAt: string;
    id: string;
    kind: "published" | "draft_saved";
    notes: string;
    snapshot: {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    };
}, {
    createdAt: string;
    id: string;
    kind: "published" | "draft_saved";
    snapshot: {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    };
    notes?: string | undefined;
}>;
export declare const SkillManifestRegistryEntrySchema: z.ZodObject<{
    skillId: z.ZodString;
    ownerPackId: z.ZodString;
    scope: z.ZodEnum<["environment", "shared"]>;
    draft: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        notes: z.ZodDefault<z.ZodString>;
        savedAt: z.ZodString;
        snapshot: z.ZodObject<{
            skillId: z.ZodString;
            label: z.ZodString;
            scope: z.ZodEnum<["environment", "shared"]>;
            version: z.ZodString;
            ownerPackId: z.ZodString;
            ownerPackName: z.ZodString;
            packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                label: z.ZodString;
                kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
            }, "strip", z.ZodTypeAny, {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }, {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }>, "many">>;
            policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
                workflow: z.ZodString;
                phase: z.ZodString;
                packId: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                phase: string;
                workflow: string;
                packId: string;
            }, {
                phase: string;
                workflow: string;
                packId: string;
            }>, "many">>;
            taskCount: z.ZodDefault<z.ZodNumber>;
            activeTaskCount: z.ZodDefault<z.ZodNumber>;
            selectedTaskCount: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        }, {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        notes: string;
        savedAt: string;
        snapshot: {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        };
    }, {
        savedAt: string;
        snapshot: {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        };
        notes?: string | undefined;
    }>>>;
    published: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        notes: z.ZodDefault<z.ZodString>;
        publishedAt: z.ZodString;
        snapshot: z.ZodObject<{
            skillId: z.ZodString;
            label: z.ZodString;
            scope: z.ZodEnum<["environment", "shared"]>;
            version: z.ZodString;
            ownerPackId: z.ZodString;
            ownerPackName: z.ZodString;
            packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                label: z.ZodString;
                kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
            }, "strip", z.ZodTypeAny, {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }, {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }>, "many">>;
            policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
                workflow: z.ZodString;
                phase: z.ZodString;
                packId: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                phase: string;
                workflow: string;
                packId: string;
            }, {
                phase: string;
                workflow: string;
                packId: string;
            }>, "many">>;
            taskCount: z.ZodDefault<z.ZodNumber>;
            activeTaskCount: z.ZodDefault<z.ZodNumber>;
            selectedTaskCount: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        }, {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        notes: string;
        snapshot: {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        };
        publishedAt: string;
    }, {
        snapshot: {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        };
        publishedAt: string;
        notes?: string | undefined;
    }>>>;
    revisions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["draft_saved", "published"]>;
        createdAt: z.ZodString;
        notes: z.ZodDefault<z.ZodString>;
        snapshot: z.ZodObject<{
            skillId: z.ZodString;
            label: z.ZodString;
            scope: z.ZodEnum<["environment", "shared"]>;
            version: z.ZodString;
            ownerPackId: z.ZodString;
            ownerPackName: z.ZodString;
            packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                label: z.ZodString;
                kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
            }, "strip", z.ZodTypeAny, {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }, {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }>, "many">>;
            policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
                workflow: z.ZodString;
                phase: z.ZodString;
                packId: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                phase: string;
                workflow: string;
                packId: string;
            }, {
                phase: string;
                workflow: string;
                packId: string;
            }>, "many">>;
            taskCount: z.ZodDefault<z.ZodNumber>;
            activeTaskCount: z.ZodDefault<z.ZodNumber>;
            selectedTaskCount: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        }, {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        createdAt: string;
        id: string;
        kind: "published" | "draft_saved";
        notes: string;
        snapshot: {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        };
    }, {
        createdAt: string;
        id: string;
        kind: "published" | "draft_saved";
        snapshot: {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        };
        notes?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    draft: {
        notes: string;
        savedAt: string;
        snapshot: {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        };
    } | null;
    published: {
        notes: string;
        snapshot: {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        };
        publishedAt: string;
    } | null;
    ownerPackId: string;
    scope: "shared" | "environment";
    skillId: string;
    revisions: {
        createdAt: string;
        id: string;
        kind: "published" | "draft_saved";
        notes: string;
        snapshot: {
            version: string;
            label: string;
            bindings: {
                phase: string;
                workflow: string;
                packId: string;
            }[];
            evaluators: string[];
            ownerPackId: string;
            ownerPackName: string;
            taskCount: number;
            activeTaskCount: number;
            selectedTaskCount: number;
            requiredTools: string[];
            requiredKnowledge: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[];
            policyHooks: string[];
            scope: "shared" | "environment";
            packIds: string[];
            skillId: string;
            packNames: string[];
        };
    }[];
}, {
    ownerPackId: string;
    scope: "shared" | "environment";
    skillId: string;
    draft?: {
        savedAt: string;
        snapshot: {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        };
        notes?: string | undefined;
    } | null | undefined;
    published?: {
        snapshot: {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        };
        publishedAt: string;
        notes?: string | undefined;
    } | null | undefined;
    revisions?: {
        createdAt: string;
        id: string;
        kind: "published" | "draft_saved";
        snapshot: {
            version: string;
            label: string;
            ownerPackId: string;
            ownerPackName: string;
            scope: "shared" | "environment";
            skillId: string;
            bindings?: {
                phase: string;
                workflow: string;
                packId: string;
            }[] | undefined;
            evaluators?: string[] | undefined;
            taskCount?: number | undefined;
            activeTaskCount?: number | undefined;
            selectedTaskCount?: number | undefined;
            requiredTools?: string[] | undefined;
            requiredKnowledge?: {
                id: string;
                kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
                label: string;
            }[] | undefined;
            policyHooks?: string[] | undefined;
            packIds?: string[] | undefined;
            packNames?: string[] | undefined;
        };
        notes?: string | undefined;
    }[] | undefined;
}>;
export declare const SkillManifestMutationInputSchema: z.ZodObject<{
    notes: z.ZodDefault<z.ZodString>;
    snapshot: z.ZodObject<{
        skillId: z.ZodString;
        label: z.ZodString;
        scope: z.ZodEnum<["environment", "shared"]>;
        version: z.ZodString;
        ownerPackId: z.ZodString;
        ownerPackName: z.ZodString;
        packIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        packNames: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredTools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requiredKnowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }, {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }>, "many">>;
        policyHooks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        bindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
            workflow: z.ZodString;
            phase: z.ZodString;
            packId: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            phase: string;
            workflow: string;
            packId: string;
        }, {
            phase: string;
            workflow: string;
            packId: string;
        }>, "many">>;
        taskCount: z.ZodDefault<z.ZodNumber>;
        activeTaskCount: z.ZodDefault<z.ZodNumber>;
        selectedTaskCount: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    }, {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    notes: string;
    snapshot: {
        version: string;
        label: string;
        bindings: {
            phase: string;
            workflow: string;
            packId: string;
        }[];
        evaluators: string[];
        ownerPackId: string;
        ownerPackName: string;
        taskCount: number;
        activeTaskCount: number;
        selectedTaskCount: number;
        requiredTools: string[];
        requiredKnowledge: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[];
        policyHooks: string[];
        scope: "shared" | "environment";
        packIds: string[];
        skillId: string;
        packNames: string[];
    };
}, {
    snapshot: {
        version: string;
        label: string;
        ownerPackId: string;
        ownerPackName: string;
        scope: "shared" | "environment";
        skillId: string;
        bindings?: {
            phase: string;
            workflow: string;
            packId: string;
        }[] | undefined;
        evaluators?: string[] | undefined;
        taskCount?: number | undefined;
        activeTaskCount?: number | undefined;
        selectedTaskCount?: number | undefined;
        requiredTools?: string[] | undefined;
        requiredKnowledge?: {
            id: string;
            kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
            label: string;
        }[] | undefined;
        policyHooks?: string[] | undefined;
        packIds?: string[] | undefined;
        packNames?: string[] | undefined;
    };
    notes?: string | undefined;
}>;
export type SkillManifestScope = z.infer<typeof SkillManifestScopeSchema>;
export type SkillManifestRevisionKind = z.infer<typeof SkillManifestRevisionKindSchema>;
export type SkillManifestBinding = z.infer<typeof SkillManifestBindingSchema>;
export type SkillManifestKnowledgeDependency = z.infer<typeof SkillManifestKnowledgeDependencySchema>;
export type SkillManifestSnapshot = z.infer<typeof SkillManifestSnapshotSchema>;
export type SkillManifestDraftRecord = z.infer<typeof SkillManifestDraftRecordSchema>;
export type SkillManifestPublishedRecord = z.infer<typeof SkillManifestPublishedRecordSchema>;
export type SkillManifestRevision = z.infer<typeof SkillManifestRevisionSchema>;
export type SkillManifestRegistryEntry = z.infer<typeof SkillManifestRegistryEntrySchema>;
export type SkillManifestMutationInput = z.infer<typeof SkillManifestMutationInputSchema>;
//# sourceMappingURL=skill-manifest.d.ts.map