import { z } from 'zod';
export const EnvironmentPackKnowledgeKindSchema = z.enum([
    'repo-index',
    'docs',
    'runbook',
    'incident-history',
    'decision-log',
    'glossary',
    'api-spec',
    'design-system',
    'artifact-store',
]);
export const EnvironmentPackWorkflowBindingSchema = z.object({
    workflow: z.string().min(1),
    phases: z.record(z.array(z.string().min(1))).default({}),
});
export const EnvironmentPackTaskLabelActionSchema = z.enum([
    'codex_dispatch',
    'codex_fix',
    'claude_code_review',
    'human_review',
    'maintenance_manual',
    'loop_complete',
    'metadata',
]);
export const EnvironmentPackTaskLabelSchema = z.object({
    value: z.string().min(1),
    label: z.string().min(1),
    action: EnvironmentPackTaskLabelActionSchema,
    description: z.string().min(1),
    workflow: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]),
});
export const EnvironmentPackManifestSchema = z.object({
    kind: z.literal('EnvironmentPack'),
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    tools: z.array(z.string().min(1)).default([]),
    skills: z.array(z.string().min(1)).default([]),
    knowledge: z.array(z.object({
        id: z.string().min(1),
        kind: EnvironmentPackKnowledgeKindSchema,
        label: z.string().min(1),
    })).default([]),
    policies: z.array(z.string().min(1)).default([]),
    workflowBindings: z.array(EnvironmentPackWorkflowBindingSchema).default([]),
    taskLabels: z.array(EnvironmentPackTaskLabelSchema).default([]),
    evaluators: z.array(z.string().min(1)).default([]),
});
export function toEnvironmentPackSnapshot(pack) {
    const taskLabels = (pack.taskLabels || []).length > 0
        ? { taskLabels: pack.taskLabels }
        : {};
    return {
        id: pack.id,
        name: pack.name,
        version: pack.version,
        ...taskLabels,
    };
}
export function createEnvironmentPackSelection(pack, selection) {
    const selectedSkills = normalizeSelection(selection?.selectedSkills, pack.skills, pack.skills);
    const selectedKnowledgeIds = normalizeSelection(selection?.selectedKnowledgeIds, pack.knowledge.map((entry) => entry.id), pack.knowledge.map((entry) => entry.id));
    return {
        selectedSkills,
        selectedKnowledgeIds,
    };
}
export function applyEnvironmentPackSelection(pack, selection) {
    const resolved = createEnvironmentPackSelection(pack, selection);
    const selectedSkills = new Set(resolved.selectedSkills);
    const selectedKnowledgeIds = new Set(resolved.selectedKnowledgeIds);
    return {
        ...pack,
        skills: pack.skills.filter((skill) => selectedSkills.has(skill)),
        knowledge: pack.knowledge.filter((entry) => selectedKnowledgeIds.has(entry.id)),
        workflowBindings: pack.workflowBindings.map((binding) => ({
            ...binding,
            phases: Object.fromEntries(Object.entries(binding.phases).map(([phase, requirements]) => [
                phase,
                requirements.filter((requirement) => {
                    const source = getEnvironmentPackCapabilitySource(pack, requirement);
                    if (!source) {
                        return false;
                    }
                    if (source !== 'skill') {
                        return true;
                    }
                    return selectedSkills.has(requirement);
                }),
            ])),
        })),
    };
}
export function getEnvironmentPackCapabilitySource(pack, capability) {
    if (pack.skills.includes(capability)) {
        return 'skill';
    }
    if (pack.tools.includes(capability)) {
        return 'tool';
    }
    if (pack.evaluators.includes(capability)) {
        return 'evaluator';
    }
    return null;
}
export function buildEnvironmentPackWorkflowCoverage(pack) {
    return pack.workflowBindings.map((binding) => {
        const phases = Object.entries(binding.phases).map(([phase, requirements]) => {
            const requirementCoverage = requirements.map((capability) => {
                const source = getEnvironmentPackCapabilitySource(pack, capability);
                return {
                    capability,
                    source: source || 'missing',
                };
            });
            const missingCapabilities = requirementCoverage
                .filter((entry) => entry.source === 'missing')
                .map((entry) => entry.capability);
            return {
                phase,
                covered: missingCapabilities.length === 0,
                missingCapabilities,
                requirements: requirementCoverage,
            };
        });
        return {
            workflow: binding.workflow,
            coveredPhaseCount: phases.filter((phase) => phase.covered).length,
            totalPhaseCount: phases.length,
            missingCapabilities: phases.flatMap((phase) => phase.missingCapabilities),
            phases,
        };
    });
}
export function buildEnvironmentPackPromotionQueue(pack, options) {
    const items = new Map();
    for (const workflow of buildEnvironmentPackWorkflowCoverage(pack)) {
        for (const phase of workflow.phases) {
            for (const capability of phase.missingCapabilities) {
                const id = `missing-capability:${workflow.workflow}:${phase.phase}:${capability}`;
                items.set(id, {
                    id,
                    kind: 'capability proposal',
                    detail: `Promote "${capability}" into ${workflow.workflow} / ${phase.phase} so this pack can satisfy its declared workflow binding.`,
                });
            }
        }
    }
    if (pack.evaluators.length === 0) {
        items.set('missing-evaluators', {
            id: 'missing-evaluators',
            kind: 'coverage review',
            detail: 'Add at least one evaluator so this environment can verify task outcomes before release.',
        });
    }
    const queue = Array.from(items.values());
    return typeof options?.limit === 'number'
        ? queue.slice(0, options.limit)
        : queue;
}
function normalizeSelection(selected, allowed, fallback) {
    if (!selected) {
        return [...fallback];
    }
    const allowedSet = new Set(allowed);
    const uniqueSelected = selected.filter((value, index) => selected.indexOf(value) === index);
    return uniqueSelected.filter((value) => allowedSet.has(value));
}
//# sourceMappingURL=environment-pack.js.map