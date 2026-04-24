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
  evaluators: z.array(z.string().min(1)).default([]),
});

export type EnvironmentPackKnowledgeKind = z.infer<typeof EnvironmentPackKnowledgeKindSchema>;
export type EnvironmentPackWorkflowBinding = z.infer<typeof EnvironmentPackWorkflowBindingSchema>;
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

export interface EnvironmentPackSelection {
  selectedSkills: string[];
  selectedKnowledgeIds: string[];
}

export interface EnvironmentPackSnapshot {
  id: string;
  name: string;
  version: string;
}

export function toEnvironmentPackSnapshot(
  pack: EnvironmentPackManifest,
): EnvironmentPackSnapshot {
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
  };
}

export interface ActiveEnvironmentPackState {
  activePackId: string | null;
  updatedAt: string;
}

export function createEnvironmentPackSelection(
  pack: EnvironmentPackManifest,
  selection?: Partial<EnvironmentPackSelection>,
): EnvironmentPackSelection {
  const selectedSkills = normalizeSelection(
    selection?.selectedSkills,
    pack.skills,
    pack.skills,
  );
  const selectedKnowledgeIds = normalizeSelection(
    selection?.selectedKnowledgeIds,
    pack.knowledge.map((entry) => entry.id),
    pack.knowledge.map((entry) => entry.id),
  );

  return {
    selectedSkills,
    selectedKnowledgeIds,
  };
}

export function applyEnvironmentPackSelection(
  pack: EnvironmentPackManifest,
  selection?: Partial<EnvironmentPackSelection>,
): EnvironmentPackManifest {
  const resolved = createEnvironmentPackSelection(pack, selection);
  const selectedSkills = new Set(resolved.selectedSkills);
  const selectedKnowledgeIds = new Set(resolved.selectedKnowledgeIds);

  return {
    ...pack,
    skills: pack.skills.filter((skill) => selectedSkills.has(skill)),
    knowledge: pack.knowledge.filter((entry) => selectedKnowledgeIds.has(entry.id)),
    workflowBindings: pack.workflowBindings.map((binding) => ({
      ...binding,
      phases: Object.fromEntries(
        Object.entries(binding.phases).map(([phase, requirements]) => [
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
        ]),
      ),
    })),
  };
}

export function getEnvironmentPackCapabilitySource(
  pack: EnvironmentPackManifest,
  capability: string,
): EnvironmentPackCapabilitySource | null {
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

export function buildEnvironmentPackWorkflowCoverage(
  pack: EnvironmentPackManifest,
): EnvironmentPackWorkflowCoverage[] {
  return pack.workflowBindings.map((binding) => {
    const phases = Object.entries(binding.phases).map(([phase, requirements]) => {
      const requirementCoverage: EnvironmentPackWorkflowRequirementCoverage[] = requirements.map((capability) => {
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

function normalizeSelection(
  selected: string[] | undefined,
  allowed: string[],
  fallback: string[],
): string[] {
  if (!selected) {
    return [...fallback];
  }

  const allowedSet = new Set(allowed);
  const uniqueSelected = selected.filter((value, index) => selected.indexOf(value) === index);
  return uniqueSelected.filter((value) => allowedSet.has(value));
}
