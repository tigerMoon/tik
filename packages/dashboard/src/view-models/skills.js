export function buildSkillManifestRecords(packs, tasks, activePackId, registryEntries = []) {
    const packById = new Map(packs.map((pack) => [pack.id, pack]));
    const registryById = new Map(registryEntries.map((entry) => [entry.skillId, entry]));
    const skillMap = new Map();
    for (const pack of packs) {
        for (const skillId of pack.skills) {
            const existing = skillMap.get(skillId);
            const bindings = collectSkillBindings(pack, skillId);
            const baseRecord = existing || {
                id: skillId,
                label: labelizeSkillId(skillId),
                scope: 'environment',
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
export function buildSkillManifestSnippet(skill) {
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
        ...(skill.bindings.length > 0
            ? skill.bindings.map((binding) => `  - ${binding.workflow}/${binding.phase} @ ${binding.packId}`)
            : ['  - none']),
    ].join('\n');
}
export function buildSkillDependenciesSnippet(skill) {
    return [
        'required_tools:',
        ...(skill.requiredTools.length > 0
            ? skill.requiredTools.map((tool) => `  - ${tool}`)
            : ['  - none']),
        '',
        'required_knowledge:',
        ...(skill.requiredKnowledge.length > 0
            ? skill.requiredKnowledge.map((entry) => `  - ${entry.id} (${entry.kind})`)
            : ['  - none']),
        '',
        'policy_hooks:',
        ...(skill.policyHooks.length > 0
            ? skill.policyHooks.map((policy) => `  - ${policy}`)
            : ['  - none']),
        '',
        'evaluators:',
        ...(skill.evaluators.length > 0
            ? skill.evaluators.map((evaluator) => `  - ${evaluator}`)
            : ['  - none']),
    ].join('\n');
}
export function buildSkillBindingsSnippet(skill) {
    const allowedAgents = uniqueList(skill.bindings.flatMap((binding) => inferAgentsForPhase(binding.phase)));
    return [
        'workflow_bindings:',
        ...(skill.bindings.length > 0
            ? skill.bindings.map((binding) => `  - ${binding.workflow}: ${binding.phase} @ ${binding.packId}`)
            : ['  - none']),
        '',
        `allowed_agents: [${allowedAgents.join(', ') || 'supervisor'}]`,
    ].join('\n');
}
export function buildSkillTestHarnessSnippet(skill) {
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
export function buildSkillImpactItems(skill) {
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
export function buildSkillChecklist(skill) {
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
export function buildSkillVersionEntries(skill) {
    const entries = [];
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
export function buildSkillManifestSnapshot(skill) {
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
export function buildSkillManifestMutationInput(skill, notes) {
    return {
        notes: notes.trim(),
        snapshot: buildSkillManifestSnapshot(skill),
    };
}
export function resolveSkillManifestPersistenceStatus(skill, notes) {
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
export function buildSkillManifestDiff(skill, notes) {
    const current = buildSkillManifestMutationInput(skill, notes);
    return buildSkillManifestDiffFromBaseline(current, resolvePreferredSkillBaseline(skill));
}
export function buildSkillChangeItems(skill, notes) {
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
    const items = [];
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
export function buildSkillPublishRecommendation(skill, notes) {
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
    if (diff.scopeChanged
        || diff.ownerChanged
        || diff.removedTools.length > 0
        || diff.removedKnowledge.length > 0
        || diff.removedPolicies.length > 0
        || diff.removedEvaluators.length > 0
        || diff.removedBindings.length > 0) {
        return {
            currentVersion,
            nextVersion: bumpSemver(currentVersion, 'major'),
            strategy: 'major',
            rationale: 'Scope/owner changes or removed capabilities affect compatibility and should force a major bump.',
            canPublish: true,
        };
    }
    if (diff.addedTools.length > 0
        || diff.addedKnowledge.length > 0
        || diff.addedPolicies.length > 0
        || diff.addedEvaluators.length > 0
        || diff.addedBindings.length > 0) {
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
export function buildSkillPublishMutationInput(skill, notes) {
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
export function labelizeSkillId(id) {
    return id
        .split(/[-_]/g)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}
function collectSkillBindings(pack, skillId) {
    return pack.workflowBindings.flatMap((binding) => Object.entries(binding.phases)
        .filter(([, skills]) => skills.includes(skillId))
        .map(([phase]) => ({
        workflow: binding.workflow,
        phase,
        packId: pack.id,
    })));
}
function mergeKnowledgeDependencies(current, next) {
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
function dedupeBindings(bindings) {
    const seen = new Set();
    return bindings.filter((binding) => {
        const key = `${binding.packId}:${binding.workflow}:${binding.phase}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function choosePreferredOwnerPack(packIds, packById, activePackId) {
    if (activePackId && packIds.includes(activePackId)) {
        return packById.get(activePackId) || null;
    }
    return packById.get(packIds[0] || '') || null;
}
function getTaskSelectedSkills(task, packById) {
    if (task.environmentPackSelection?.selectedSkills?.length) {
        return task.environmentPackSelection.selectedSkills;
    }
    return packById.get(task.environmentPackSnapshot?.id || '')?.skills || [];
}
function getTaskTimestamp(task) {
    return task.lastProgressAt || task.updatedAt;
}
function inferAgentsForPhase(phase) {
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
function uniqueList(values) {
    return values.filter((value, index) => values.indexOf(value) === index);
}
function compareVersionsDesc(left, right) {
    return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' });
}
function resolvePreferredSkillBaseline(skill) {
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
function resolvePublishedSkillBaseline(skill) {
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
function resolveGovernedSkillVersion(entry) {
    if (!entry) {
        return null;
    }
    return entry.published?.snapshot.version
        || entry.draft?.snapshot.version
        || entry.revisions[entry.revisions.length - 1]?.snapshot.version
        || null;
}
function buildSkillManifestDiffFromBaseline(current, baseline) {
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
    const addedKnowledge = diffAdded(baseline.value.snapshot.requiredKnowledge.map((entry) => entry.id), current.snapshot.requiredKnowledge.map((entry) => entry.id));
    const removedKnowledge = diffRemoved(baseline.value.snapshot.requiredKnowledge.map((entry) => entry.id), current.snapshot.requiredKnowledge.map((entry) => entry.id));
    const addedPolicies = diffAdded(baseline.value.snapshot.policyHooks, current.snapshot.policyHooks);
    const removedPolicies = diffRemoved(baseline.value.snapshot.policyHooks, current.snapshot.policyHooks);
    const addedEvaluators = diffAdded(baseline.value.snapshot.evaluators, current.snapshot.evaluators);
    const removedEvaluators = diffRemoved(baseline.value.snapshot.evaluators, current.snapshot.evaluators);
    const addedBindings = diffAdded(baseline.value.snapshot.bindings.map(formatBindingKey), current.snapshot.bindings.map(formatBindingKey));
    const removedBindings = diffRemoved(baseline.value.snapshot.bindings.map(formatBindingKey), current.snapshot.bindings.map(formatBindingKey));
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
function skillManifestMutationEquals(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function collectChangeParts(items, id, title, added, removed) {
    if (added.length === 0 && removed.length === 0) {
        return;
    }
    const parts = [];
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
function formatBindingKey(binding) {
    return `${binding.workflow}/${binding.phase}@${binding.packId}`;
}
function diffAdded(previous, current) {
    return current.filter((value) => !previous.includes(value));
}
function diffRemoved(previous, current) {
    return previous.filter((value) => !current.includes(value));
}
function bumpSemver(version, strategy) {
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
const ACTIVE_TASK_STATUSES = new Set([
    'new',
    'running',
    'verifying',
    'waiting_for_user',
    'paused',
]);
//# sourceMappingURL=skills.js.map