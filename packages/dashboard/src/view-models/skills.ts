import type {
  EnvironmentPackKnowledgeKind,
  EnvironmentPackManifest,
  SkillManifestMutationInput,
  SkillManifestRegistryEntry,
  SkillManifestSnapshot,
} from '@tik/shared';
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

interface SkillManifestBaseline {
  label: string;
  value: SkillManifestMutationInput;
}

export interface SkillVersionEntry {
  id: string;
  version: string;
  detail: string;
}

export type SkillManifestPersistenceStatus = 'changes-unsaved' | 'draft-saved' | 'published';

export function buildSkillManifestRecords(
  packs: EnvironmentPackManifest[],
  tasks: WorkbenchTaskResponse[],
  activePackId?: string | null,
  registryEntries: SkillManifestRegistryEntry[] = [],
): SkillManifestRecord[] {
  const packById = new Map(packs.map((pack) => [pack.id, pack]));
  const registryById = new Map(registryEntries.map((entry) => [entry.skillId, entry]));
  const skillMap = new Map<string, SkillManifestRecord>();

  for (const pack of packs) {
    for (const skillId of pack.skills) {
      const existing = skillMap.get(skillId);
      const bindings = collectSkillBindings(pack, skillId);
      const baseRecord = existing || {
        id: skillId,
        label: labelizeSkillId(skillId),
        scope: 'environment' as const,
        version: pack.version,
        versions: [pack.version],
        ownerPackId: pack.id,
        ownerPackName: pack.name,
        packIds: [],
        packNames: [],
        requiredTools: [],
        requiredKnowledge: [],
        policyHooks: [],
        evaluators: [],
        bindings: [],
        taskCount: 0,
        activeTaskCount: 0,
        selectedTaskCount: 0,
        lastObservedAt: null,
        relatedTasks: [],
        registryEntry: null,
      };

      baseRecord.packIds = uniqueList([...baseRecord.packIds, pack.id]);
      baseRecord.packNames = uniqueList([...baseRecord.packNames, pack.name]);
      baseRecord.versions = uniqueList([...baseRecord.versions, pack.version]).sort(compareVersionsDesc);
      baseRecord.requiredTools = uniqueList([...baseRecord.requiredTools, ...pack.tools]);
      baseRecord.requiredKnowledge = mergeKnowledgeDependencies(baseRecord.requiredKnowledge, pack.knowledge);
      baseRecord.policyHooks = uniqueList([...baseRecord.policyHooks, ...pack.policies]);
      baseRecord.evaluators = uniqueList([...baseRecord.evaluators, ...pack.evaluators]);
      baseRecord.bindings = dedupeBindings([...baseRecord.bindings, ...bindings]);

      const preferredOwner = choosePreferredOwnerPack(baseRecord.packIds, packById, activePackId);
      if (preferredOwner) {
        baseRecord.ownerPackId = preferredOwner.id;
        baseRecord.ownerPackName = preferredOwner.name;
        baseRecord.version = preferredOwner.version;
      }
      baseRecord.scope = baseRecord.packIds.length > 1 ? 'shared' : 'environment';

      skillMap.set(skillId, baseRecord);
    }
  }

  for (const record of skillMap.values()) {
    const relatedTasks = tasks
      .filter((task) => getTaskSelectedSkills(task, packById).includes(record.id))
      .sort((left, right) => getTaskTimestamp(right).localeCompare(getTaskTimestamp(left)));
    record.relatedTasks = relatedTasks.slice(0, 4);
    record.selectedTaskCount = relatedTasks.length;
    record.taskCount = tasks.filter((task) => record.packIds.includes(task.environmentPackSnapshot?.id || '')).length;
    record.activeTaskCount = relatedTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
    record.lastObservedAt = relatedTasks[0] ? getTaskTimestamp(relatedTasks[0]) : null;
    record.registryEntry = registryById.get(record.id) || null;
    const governedVersion = resolveGovernedSkillVersion(record.registryEntry);
    if (governedVersion) {
      record.version = governedVersion;
      record.versions = uniqueList([...record.versions, governedVersion]).sort(compareVersionsDesc);
    }
  }

  return Array.from(skillMap.values()).sort((left, right) => {
    if (right.selectedTaskCount !== left.selectedTaskCount) {
      return right.selectedTaskCount - left.selectedTaskCount;
    }

    if (right.packIds.length !== left.packIds.length) {
      return right.packIds.length - left.packIds.length;
    }

    return left.id.localeCompare(right.id);
  });
}

export function buildSkillManifestSnippet(skill: SkillManifestRecord): string {
  return [
    `id: ${skill.id}`,
    `scope: ${skill.scope}`,
    `owner_pack: ${skill.ownerPackId}`,
    `entrypoint: skill://${skill.ownerPackId}/${skill.id}`,
    `version: ${skill.version}`,
    '',
    'dependencies:',
    `  tools: [${skill.requiredTools.join(', ') || 'none'}]`,
    `  knowledge: [${skill.requiredKnowledge.map((entry) => entry.id).join(', ') || 'none'}]`,
    `  policies: [${skill.policyHooks.join(', ') || 'none'}]`,
    '',
    'observed_bindings:',
    ...(
      skill.bindings.length > 0
        ? skill.bindings.map((binding) => `  - ${binding.workflow}/${binding.phase} @ ${binding.packId}`)
        : ['  - none']
    ),
  ].join('\n');
}

export function buildSkillDependenciesSnippet(skill: SkillManifestRecord): string {
  return [
    'required_tools:',
    ...(
      skill.requiredTools.length > 0
        ? skill.requiredTools.map((tool) => `  - ${tool}`)
        : ['  - none']
    ),
    '',
    'required_knowledge:',
    ...(
      skill.requiredKnowledge.length > 0
        ? skill.requiredKnowledge.map((entry) => `  - ${entry.id} (${entry.kind})`)
        : ['  - none']
    ),
    '',
    'policy_hooks:',
    ...(
      skill.policyHooks.length > 0
        ? skill.policyHooks.map((policy) => `  - ${policy}`)
        : ['  - none']
    ),
    '',
    'evaluators:',
    ...(
      skill.evaluators.length > 0
        ? skill.evaluators.map((evaluator) => `  - ${evaluator}`)
        : ['  - none']
    ),
  ].join('\n');
}

export function buildSkillBindingsSnippet(skill: SkillManifestRecord): string {
  const allowedAgents = uniqueList(
    skill.bindings.flatMap((binding) => inferAgentsForPhase(binding.phase)),
  );

  return [
    'workflow_bindings:',
    ...(
      skill.bindings.length > 0
        ? skill.bindings.map((binding) => `  - ${binding.workflow}: ${binding.phase} @ ${binding.packId}`)
        : ['  - none']
    ),
    '',
    `allowed_agents: [${allowedAgents.join(', ') || 'supervisor'}]`,
  ].join('\n');
}

export function buildSkillTestHarnessSnippet(skill: SkillManifestRecord): string {
  const latestTask = skill.relatedTasks[0];
  return [
    `skill: ${skill.id}`,
    `owner_pack: ${skill.ownerPackId}`,
    `scope: ${skill.scope}`,
    `sample_task: ${latestTask?.id || 'none'}`,
    'checks:',
    `  - bindings: ${skill.bindings.length}`,
    `  - selected_tasks: ${skill.selectedTaskCount}`,
    `  - policies: ${skill.policyHooks.length}`,
  ].join('\n');
}

export function buildSkillImpactItems(skill: SkillManifestRecord): SkillImpactItem[] {
  return [
    {
      title: 'Workflow impact',
      detail: skill.bindings.length > 0
        ? `${skill.bindings.length} binding${skill.bindings.length === 1 ? '' : 's'} currently route work through this skill`
        : 'No workflow bindings currently reference this skill',
    },
    {
      title: 'Pack impact',
      detail: `${skill.packIds.length} pack${skill.packIds.length === 1 ? '' : 's'} depend on this manifest`,
    },
    {
      title: 'Task impact',
      detail: skill.selectedTaskCount > 0
        ? `${skill.selectedTaskCount} task${skill.selectedTaskCount === 1 ? '' : 's'} selected this skill in recent runs`
        : 'No recent tasks explicitly selected this skill',
    },
  ];
}

export function buildSkillChecklist(skill: SkillManifestRecord): SkillChecklistItem[] {
  return [
    {
      label: 'Manifest has an owner pack',
      tone: 'green',
    },
    {
      label: skill.bindings.length > 0 ? 'Bindings discovered' : 'Bindings still need review',
      tone: skill.bindings.length > 0 ? 'green' : 'yellow',
    },
    {
      label: skill.selectedTaskCount > 0 ? 'Observed in live task setup' : 'No live task selection recorded yet',
      tone: skill.selectedTaskCount > 0 ? 'green' : 'yellow',
    },
    {
      label: skill.scope === 'environment' ? 'Promotion review needed' : 'Shared scope already established',
      tone: skill.scope === 'environment' ? 'yellow' : 'green',
    },
  ];
}

export function buildSkillVersionEntries(skill: SkillManifestRecord): SkillVersionEntry[] {
  const entries: SkillVersionEntry[] = [];

  const revisions = [...(skill.registryEntry?.revisions || [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  revisions.forEach((revision) => {
    entries.push({
      id: revision.id,
      version: revision.snapshot.version,
      detail: `${revision.kind === 'published' ? 'Published' : 'Draft saved'} · ${revision.createdAt}`,
    });
  });

  if (revisions.length === 0 && skill.registryEntry?.published) {
    entries.push({
      id: 'published-fallback',
      version: skill.registryEntry.published.snapshot.version,
      detail: `Published · ${skill.registryEntry.published.publishedAt}`,
    });
  }

  if (revisions.length === 0 && skill.registryEntry?.draft) {
    entries.push({
      id: 'draft-fallback',
      version: skill.registryEntry.draft.snapshot.version,
      detail: `Draft saved · ${skill.registryEntry.draft.savedAt}`,
    });
  }

  skill.versions.forEach((version, index) => {
    entries.push({
      id: `observed-${version}-${index}`,
      version,
      detail: index === 0
        ? `Current manifest observed in ${skill.packIds.length} pack${skill.packIds.length === 1 ? '' : 's'}`
        : 'Observed in related pack variants',
    });
  });

  return entries.filter((entry, index, list) => list.findIndex((item) => item.id === entry.id) === index);
}

export function buildSkillCommandSnippet(skill: SkillManifestRecord): string {
  return `@skill/${skill.id} #show-impact review ${skill.bindings.length} bindings, ${skill.requiredTools.length} tools, and ${skill.selectedTaskCount} selected tasks`;
}

export function buildSkillManifestSnapshot(skill: SkillManifestRecord): SkillManifestSnapshot {
  return {
    skillId: skill.id,
    label: skill.label,
    scope: skill.scope,
    version: skill.version,
    ownerPackId: skill.ownerPackId,
    ownerPackName: skill.ownerPackName,
    packIds: [...skill.packIds],
    packNames: [...skill.packNames],
    requiredTools: [...skill.requiredTools],
    requiredKnowledge: skill.requiredKnowledge.map((entry) => ({ ...entry })),
    policyHooks: [...skill.policyHooks],
    evaluators: [...skill.evaluators],
    bindings: skill.bindings.map((binding) => ({ ...binding })),
    taskCount: skill.taskCount,
    activeTaskCount: skill.activeTaskCount,
    selectedTaskCount: skill.selectedTaskCount,
  };
}

export function buildSkillManifestMutationInput(
  skill: SkillManifestRecord,
  notes: string,
): SkillManifestMutationInput {
  return {
    notes: notes.trim(),
    snapshot: buildSkillManifestSnapshot(skill),
  };
}

export function resolveSkillManifestPersistenceStatus(
  skill: SkillManifestRecord,
  notes: string,
): SkillManifestPersistenceStatus {
  const current = buildSkillManifestMutationInput(skill, notes);
  const matchesDraft = skill.registryEntry?.draft
    ? skillManifestMutationEquals(current, {
      notes: skill.registryEntry.draft.notes,
      snapshot: skill.registryEntry.draft.snapshot,
    })
    : false;
  const matchesPublished = skill.registryEntry?.published
    ? skillManifestMutationEquals(current, {
      notes: skill.registryEntry.published.notes,
      snapshot: skill.registryEntry.published.snapshot,
    })
    : false;

  if (matchesPublished) {
    return 'published';
  }

  if (matchesDraft) {
    return 'draft-saved';
  }

  return 'changes-unsaved';
}

export function buildSkillManifestDiff(
  skill: SkillManifestRecord,
  notes: string,
): SkillManifestDiff {
  const current = buildSkillManifestMutationInput(skill, notes);
  return buildSkillManifestDiffFromBaseline(current, resolvePreferredSkillBaseline(skill));
}

export function buildSkillChangeItems(
  skill: SkillManifestRecord,
  notes: string,
): SkillChangeItem[] {
  const diff = buildSkillManifestDiff(skill, notes);

  if (!diff.hasBaseline) {
    return [
      {
        id: 'no-baseline',
        title: 'First release',
        detail: 'No saved draft or published baseline exists yet. This publish will establish the first governed version.',
        tone: 'yellow',
      },
    ];
  }

  const items: SkillChangeItem[] = [];
  collectChangeParts(items, 'requiredTools', 'Tool changes', diff.addedTools, diff.removedTools);
  collectChangeParts(items, 'requiredKnowledge', 'Knowledge changes', diff.addedKnowledge, diff.removedKnowledge);
  collectChangeParts(items, 'policyHooks', 'Policy hook changes', diff.addedPolicies, diff.removedPolicies);
  collectChangeParts(items, 'evaluators', 'Evaluator changes', diff.addedEvaluators, diff.removedEvaluators);
  collectChangeParts(items, 'bindings', 'Binding changes', diff.addedBindings, diff.removedBindings);

  if (diff.scopeChanged || diff.ownerChanged) {
    items.push({
      id: 'scope',
      title: 'Scope or ownership changed',
      detail: 'This manifest now targets a different scope or owner pack than the current baseline.',
      tone: 'blue',
    });
  }

  if (diff.notesChanged) {
    items.push({
      id: 'notes',
      title: 'Manifest notes updated',
      detail: `Review notes changed relative to the ${diff.baselineLabel}.`,
      tone: 'blue',
    });
  }

  if (items.length === 0) {
    items.push({
      id: 'no-change',
      title: 'No material manifest diff',
      detail: `Current snapshot matches the ${diff.baselineLabel}.`,
      tone: 'green',
    });
  }

  return items;
}

export function buildSkillPublishRecommendation(
  skill: SkillManifestRecord,
  notes: string,
): SkillPublishRecommendation {
  const current = buildSkillManifestMutationInput(skill, notes);
  const publishedBaseline = resolvePublishedSkillBaseline(skill);
  const diff = buildSkillManifestDiffFromBaseline(current, publishedBaseline);
  const currentVersion = publishedBaseline?.value.snapshot.version || current.snapshot.version;

  if (!diff.hasBaseline) {
    return {
      currentVersion,
      nextVersion: current.snapshot.version,
      strategy: 'initial',
      rationale: 'First publish keeps the current observed version as the initial governed manifest.',
      canPublish: true,
    };
  }

  if (!diff.hasMaterialChange) {
    return {
      currentVersion,
      nextVersion: currentVersion,
      strategy: 'none',
      rationale: `No material diff remains relative to the ${diff.baselineLabel}.`,
      canPublish: false,
    };
  }

  if (
    diff.scopeChanged
    || diff.ownerChanged
    || diff.removedTools.length > 0
    || diff.removedKnowledge.length > 0
    || diff.removedPolicies.length > 0
    || diff.removedEvaluators.length > 0
    || diff.removedBindings.length > 0
  ) {
    return {
      currentVersion,
      nextVersion: bumpSemver(currentVersion, 'major'),
      strategy: 'major',
      rationale: 'Scope/owner changes or removed capabilities affect compatibility and should force a major bump.',
      canPublish: true,
    };
  }

  if (
    diff.addedTools.length > 0
    || diff.addedKnowledge.length > 0
    || diff.addedPolicies.length > 0
    || diff.addedEvaluators.length > 0
    || diff.addedBindings.length > 0
  ) {
    return {
      currentVersion,
      nextVersion: bumpSemver(currentVersion, 'minor'),
      strategy: 'minor',
      rationale: 'New dependencies or bindings broaden behavior and should create a minor version.',
      canPublish: true,
    };
  }

  return {
    currentVersion,
    nextVersion: bumpSemver(currentVersion, 'patch'),
    strategy: 'patch',
    rationale: 'Non-structural manifest changes should use a patch bump.',
    canPublish: true,
  };
}

export function buildSkillPublishMutationInput(
  skill: SkillManifestRecord,
  notes: string,
): SkillManifestMutationInput {
  const recommendation = buildSkillPublishRecommendation(skill, notes);
  const mutation = buildSkillManifestMutationInput(skill, notes);
  return {
    ...mutation,
    snapshot: {
      ...mutation.snapshot,
      version: recommendation.nextVersion,
    },
  };
}

export function labelizeSkillId(id: string): string {
  return id
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function collectSkillBindings(pack: EnvironmentPackManifest, skillId: string): SkillWorkflowBinding[] {
  return pack.workflowBindings.flatMap((binding) => Object.entries(binding.phases)
    .filter(([, skills]) => skills.includes(skillId))
    .map(([phase]) => ({
      workflow: binding.workflow,
      phase,
      packId: pack.id,
    })));
}

function mergeKnowledgeDependencies(
  current: SkillKnowledgeDependency[],
  next: EnvironmentPackManifest['knowledge'],
): SkillKnowledgeDependency[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of next) {
    merged.set(entry.id, {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
    });
  }
  return Array.from(merged.values());
}

function dedupeBindings(bindings: SkillWorkflowBinding[]): SkillWorkflowBinding[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.packId}:${binding.workflow}:${binding.phase}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function choosePreferredOwnerPack(
  packIds: string[],
  packById: Map<string, EnvironmentPackManifest>,
  activePackId?: string | null,
): EnvironmentPackManifest | null {
  if (activePackId && packIds.includes(activePackId)) {
    return packById.get(activePackId) || null;
  }

  return packById.get(packIds[0] || '') || null;
}

function getTaskSelectedSkills(
  task: WorkbenchTaskResponse,
  packById: Map<string, EnvironmentPackManifest>,
): string[] {
  if (task.environmentPackSelection?.selectedSkills?.length) {
    return task.environmentPackSelection.selectedSkills;
  }

  return packById.get(task.environmentPackSnapshot?.id || '')?.skills || [];
}

function getTaskTimestamp(task: Pick<WorkbenchTaskResponse, 'updatedAt' | 'lastProgressAt'>): string {
  return task.lastProgressAt || task.updatedAt;
}

function inferAgentsForPhase(phase: string): string[] {
  switch (phase) {
    case 'clarify':
    case 'plan':
      return ['planner'];
    case 'implement':
      return ['coder'];
    case 'review':
      return ['reviewer'];
    case 'verify':
      return ['reviewer', 'evaluator'];
    default:
      return ['supervisor'];
  }
}

function uniqueList<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function compareVersionsDesc(left: string, right: string): number {
  return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' });
}

function resolvePreferredSkillBaseline(skill: SkillManifestRecord): SkillManifestBaseline | null {
  if (skill.registryEntry?.published) {
    return {
      label: 'published manifest',
      value: {
        notes: skill.registryEntry.published.notes,
        snapshot: skill.registryEntry.published.snapshot,
      },
    };
  }

  if (skill.registryEntry?.draft) {
    return {
      label: 'saved draft',
      value: {
        notes: skill.registryEntry.draft.notes,
        snapshot: skill.registryEntry.draft.snapshot,
      },
    };
  }

  return null;
}

function resolvePublishedSkillBaseline(skill: SkillManifestRecord): SkillManifestBaseline | null {
  if (!skill.registryEntry?.published) {
    return null;
  }

  return {
    label: 'published manifest',
    value: {
      notes: skill.registryEntry.published.notes,
      snapshot: skill.registryEntry.published.snapshot,
    },
  };
}

function resolveGovernedSkillVersion(entry: SkillManifestRegistryEntry | null): string | null {
  if (!entry) {
    return null;
  }

  return entry.published?.snapshot.version
    || entry.draft?.snapshot.version
    || entry.revisions[entry.revisions.length - 1]?.snapshot.version
    || null;
}

function buildSkillManifestDiffFromBaseline(
  current: SkillManifestMutationInput,
  baseline: SkillManifestBaseline | null,
): SkillManifestDiff {
  if (!baseline) {
    return {
      baselineLabel: null,
      addedTools: [],
      removedTools: [],
      addedKnowledge: [],
      removedKnowledge: [],
      addedPolicies: [],
      removedPolicies: [],
      addedEvaluators: [],
      removedEvaluators: [],
      addedBindings: [],
      removedBindings: [],
      notesChanged: false,
      scopeChanged: false,
      ownerChanged: false,
      hasBaseline: false,
      hasMaterialChange: true,
    };
  }

  const addedTools = diffAdded(baseline.value.snapshot.requiredTools, current.snapshot.requiredTools);
  const removedTools = diffRemoved(baseline.value.snapshot.requiredTools, current.snapshot.requiredTools);
  const addedKnowledge = diffAdded(
    baseline.value.snapshot.requiredKnowledge.map((entry) => entry.id),
    current.snapshot.requiredKnowledge.map((entry) => entry.id),
  );
  const removedKnowledge = diffRemoved(
    baseline.value.snapshot.requiredKnowledge.map((entry) => entry.id),
    current.snapshot.requiredKnowledge.map((entry) => entry.id),
  );
  const addedPolicies = diffAdded(baseline.value.snapshot.policyHooks, current.snapshot.policyHooks);
  const removedPolicies = diffRemoved(baseline.value.snapshot.policyHooks, current.snapshot.policyHooks);
  const addedEvaluators = diffAdded(baseline.value.snapshot.evaluators, current.snapshot.evaluators);
  const removedEvaluators = diffRemoved(baseline.value.snapshot.evaluators, current.snapshot.evaluators);
  const addedBindings = diffAdded(
    baseline.value.snapshot.bindings.map(formatBindingKey),
    current.snapshot.bindings.map(formatBindingKey),
  );
  const removedBindings = diffRemoved(
    baseline.value.snapshot.bindings.map(formatBindingKey),
    current.snapshot.bindings.map(formatBindingKey),
  );
  const notesChanged = baseline.value.notes !== current.notes;
  const scopeChanged = baseline.value.snapshot.scope !== current.snapshot.scope;
  const ownerChanged = baseline.value.snapshot.ownerPackId !== current.snapshot.ownerPackId;

  return {
    baselineLabel: baseline.label,
    addedTools,
    removedTools,
    addedKnowledge,
    removedKnowledge,
    addedPolicies,
    removedPolicies,
    addedEvaluators,
    removedEvaluators,
    addedBindings,
    removedBindings,
    notesChanged,
    scopeChanged,
    ownerChanged,
    hasBaseline: true,
    hasMaterialChange: notesChanged
      || scopeChanged
      || ownerChanged
      || addedTools.length > 0
      || removedTools.length > 0
      || addedKnowledge.length > 0
      || removedKnowledge.length > 0
      || addedPolicies.length > 0
      || removedPolicies.length > 0
      || addedEvaluators.length > 0
      || removedEvaluators.length > 0
      || addedBindings.length > 0
      || removedBindings.length > 0,
  };
}

function skillManifestMutationEquals(left: SkillManifestMutationInput, right: SkillManifestMutationInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectChangeParts(
  items: SkillChangeItem[],
  id: string,
  title: string,
  added: string[],
  removed: string[],
): void {
  if (added.length === 0 && removed.length === 0) {
    return;
  }

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`added ${added.join(', ')}`);
  }
  if (removed.length > 0) {
    parts.push(`removed ${removed.join(', ')}`);
  }

  items.push({
    id,
    title,
    detail: parts.join(' · '),
    tone: added.length > 0 && removed.length === 0 ? 'blue' : 'yellow',
  });
}

function formatBindingKey(binding: SkillManifestSnapshot['bindings'][number]): string {
  return `${binding.workflow}/${binding.phase}@${binding.packId}`;
}

function diffAdded(previous: string[], current: string[]): string[] {
  return current.filter((value) => !previous.includes(value));
}

function diffRemoved(previous: string[], current: string[]): string[] {
  return previous.filter((value) => !current.includes(value));
}

function bumpSemver(version: string, strategy: 'patch' | 'minor' | 'major'): string {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const [major = 0, minor = 0, patch = 0] = parts.map((value) => (Number.isFinite(value) ? value : 0));

  if (strategy === 'major') {
    return `${major + 1}.0.0`;
  }

  if (strategy === 'minor') {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

const ACTIVE_TASK_STATUSES = new Set<WorkbenchTaskResponse['status']>([
  'new',
  'running',
  'verifying',
  'waiting_for_user',
  'paused',
]);
