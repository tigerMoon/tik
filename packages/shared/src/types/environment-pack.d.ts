import { z } from 'zod';
export declare const EnvironmentPackKnowledgeKindSchema: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
export declare const EnvironmentPackWorkflowBindingSchema: z.ZodObject<{
    workflow: z.ZodString;
    phases: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString, "many">>>;
}, "strip", z.ZodTypeAny, {
    workflow: string;
    phases: Record<string, string[]>;
}, {
    workflow: string;
    phases?: Record<string, string[]> | undefined;
}>;
export declare const EnvironmentPackTaskLabelActionSchema: z.ZodEnum<["codex_dispatch", "codex_fix", "claude_code_review", "human_review", "maintenance_manual", "loop_complete", "metadata"]>;
export declare const EnvironmentPackTaskLabelSchema: z.ZodObject<{
    value: z.ZodString;
    label: z.ZodString;
    action: z.ZodEnum<["codex_dispatch", "codex_fix", "claude_code_review", "human_review", "maintenance_manual", "loop_complete", "metadata"]>;
    description: z.ZodString;
    workflow: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodString>;
    aliases: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    description: string;
    value: string;
    label: string;
    action: "metadata" | "claude_code_review" | "codex_dispatch" | "codex_fix" | "human_review" | "maintenance_manual" | "loop_complete";
    aliases: string[];
    phase?: string | undefined;
    workflow?: string | undefined;
}, {
    description: string;
    value: string;
    label: string;
    action: "metadata" | "claude_code_review" | "codex_dispatch" | "codex_fix" | "human_review" | "maintenance_manual" | "loop_complete";
    phase?: string | undefined;
    workflow?: string | undefined;
    aliases?: string[] | undefined;
}>;
export declare const EnvironmentPackManifestSchema: z.ZodObject<{
    kind: z.ZodLiteral<"EnvironmentPack">;
    id: z.ZodString;
    name: z.ZodString;
    version: z.ZodString;
    description: z.ZodString;
    tools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    skills: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    knowledge: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["repo-index", "docs", "runbook", "incident-history", "decision-log", "glossary", "api-spec", "design-system", "artifact-store"]>;
        label: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }, {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }>, "many">>;
    policies: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    workflowBindings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        workflow: z.ZodString;
        phases: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString, "many">>>;
    }, "strip", z.ZodTypeAny, {
        workflow: string;
        phases: Record<string, string[]>;
    }, {
        workflow: string;
        phases?: Record<string, string[]> | undefined;
    }>, "many">>;
    taskLabels: z.ZodDefault<z.ZodArray<z.ZodObject<{
        value: z.ZodString;
        label: z.ZodString;
        action: z.ZodEnum<["codex_dispatch", "codex_fix", "claude_code_review", "human_review", "maintenance_manual", "loop_complete", "metadata"]>;
        description: z.ZodString;
        workflow: z.ZodOptional<z.ZodString>;
        phase: z.ZodOptional<z.ZodString>;
        aliases: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        value: string;
        label: string;
        action: "metadata" | "claude_code_review" | "codex_dispatch" | "codex_fix" | "human_review" | "maintenance_manual" | "loop_complete";
        aliases: string[];
        phase?: string | undefined;
        workflow?: string | undefined;
    }, {
        description: string;
        value: string;
        label: string;
        action: "metadata" | "claude_code_review" | "codex_dispatch" | "codex_fix" | "human_review" | "maintenance_manual" | "loop_complete";
        phase?: string | undefined;
        workflow?: string | undefined;
        aliases?: string[] | undefined;
    }>, "many">>;
    evaluators: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    name: string;
    version: string;
    id: string;
    description: string;
    tools: string[];
    kind: "EnvironmentPack";
    skills: string[];
    taskLabels: {
        description: string;
        value: string;
        label: string;
        action: "metadata" | "claude_code_review" | "codex_dispatch" | "codex_fix" | "human_review" | "maintenance_manual" | "loop_complete";
        aliases: string[];
        phase?: string | undefined;
        workflow?: string | undefined;
    }[];
    workflowBindings: {
        workflow: string;
        phases: Record<string, string[]>;
    }[];
    knowledge: {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }[];
    policies: string[];
    evaluators: string[];
}, {
    name: string;
    version: string;
    id: string;
    description: string;
    kind: "EnvironmentPack";
    tools?: string[] | undefined;
    skills?: string[] | undefined;
    taskLabels?: {
        description: string;
        value: string;
        label: string;
        action: "metadata" | "claude_code_review" | "codex_dispatch" | "codex_fix" | "human_review" | "maintenance_manual" | "loop_complete";
        phase?: string | undefined;
        workflow?: string | undefined;
        aliases?: string[] | undefined;
    }[] | undefined;
    workflowBindings?: {
        workflow: string;
        phases?: Record<string, string[]> | undefined;
    }[] | undefined;
    knowledge?: {
        id: string;
        kind: "repo-index" | "docs" | "runbook" | "incident-history" | "decision-log" | "glossary" | "api-spec" | "design-system" | "artifact-store";
        label: string;
    }[] | undefined;
    policies?: string[] | undefined;
    evaluators?: string[] | undefined;
}>;
export type EnvironmentPackKnowledgeKind = z.infer<typeof EnvironmentPackKnowledgeKindSchema>;
export type EnvironmentPackWorkflowBinding = z.infer<typeof EnvironmentPackWorkflowBindingSchema>;
export type EnvironmentPackTaskLabelAction = z.infer<typeof EnvironmentPackTaskLabelActionSchema>;
export type EnvironmentPackTaskLabel = z.infer<typeof EnvironmentPackTaskLabelSchema>;
export type EnvironmentPackManifest = z.infer<typeof EnvironmentPackManifestSchema>;
export type EnvironmentPackCapabilitySource = 'skill' | 'tool' | 'evaluator';
export interface EnvironmentPackWorkflowRequirementCoverage {
    capability: string;
    source: EnvironmentPackCapabilitySource | 'missing';
}
export interface EnvironmentPackWorkflowPhaseCoverage {
    phase: string;
    covered: boolean;
    missingCapabilities: string[];
    requirements: EnvironmentPackWorkflowRequirementCoverage[];
}
export interface EnvironmentPackWorkflowCoverage {
    workflow: string;
    coveredPhaseCount: number;
    totalPhaseCount: number;
    missingCapabilities: string[];
    phases: EnvironmentPackWorkflowPhaseCoverage[];
}
export interface EnvironmentPackPromotionQueueItem {
    id: string;
    kind: string;
    detail: string;
}
export interface EnvironmentPackSelection {
    selectedSkills: string[];
    selectedKnowledgeIds: string[];
}
export interface EnvironmentPackSnapshot {
    id: string;
    name: string;
    version: string;
    taskLabels?: EnvironmentPackTaskLabel[];
}
export declare function toEnvironmentPackSnapshot(pack: EnvironmentPackManifest): EnvironmentPackSnapshot;
export interface ActiveEnvironmentPackState {
    activePackId: string | null;
    updatedAt: string;
}
export declare function createEnvironmentPackSelection(pack: EnvironmentPackManifest, selection?: Partial<EnvironmentPackSelection>): EnvironmentPackSelection;
export declare function applyEnvironmentPackSelection(pack: EnvironmentPackManifest, selection?: Partial<EnvironmentPackSelection>): EnvironmentPackManifest;
export declare function getEnvironmentPackCapabilitySource(pack: EnvironmentPackManifest, capability: string): EnvironmentPackCapabilitySource | null;
export declare function buildEnvironmentPackWorkflowCoverage(pack: EnvironmentPackManifest): EnvironmentPackWorkflowCoverage[];
export declare function buildEnvironmentPackPromotionQueue(pack: EnvironmentPackManifest, options?: {
    limit?: number;
}): EnvironmentPackPromotionQueueItem[];
//# sourceMappingURL=environment-pack.d.ts.map