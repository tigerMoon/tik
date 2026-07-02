export function buildWorkspaceEventProjection(records) {
    const byPhase = new Map();
    const byProject = new Map();
    for (const record of records) {
        const phaseGroup = byPhase.get(record.phase) || [];
        phaseGroup.push(record);
        byPhase.set(record.phase, phaseGroup);
        if (record.projectName) {
            const projectGroup = byProject.get(record.projectName) || [];
            projectGroup.push(record);
            byProject.set(record.projectName, projectGroup);
        }
    }
    return {
        totalEvents: records.length,
        phases: Array.from(byPhase.entries()).map(([phase, phaseRecords]) => ({
            phase,
            eventCount: phaseRecords.length,
            lastMessage: phaseRecords.at(-1)?.message,
        })),
        projects: Array.from(byProject.entries()).map(([projectName, projectRecords]) => ({
            projectName,
            eventCount: projectRecords.length,
            feedbackCount: projectRecords.filter((record) => record.kind === 'feedback.recorded').length,
            recoveryCount: projectRecords.filter((record) => record.kind === 'phase.recovered').length,
            completionCount: projectRecords.filter((record) => record.kind === 'phase.completed').length,
            lastKind: projectRecords.at(-1)?.kind,
            lastMessage: projectRecords.at(-1)?.message,
        })),
        recent: records.slice(-10),
        recentDisplay: collapseWorkspaceDisplayEvents(records.slice(-20)),
    };
}
function collapseWorkspaceDisplayEvents(records) {
    const collapsed = new Map();
    for (const record of records) {
        const key = [record.phase, record.kind, record.projectName || '', record.message].join('::');
        const existing = collapsed.get(key);
        if (existing) {
            existing.count += 1;
            existing.lastTimestamp = record.timestamp;
            continue;
        }
        collapsed.set(key, {
            phase: record.phase,
            kind: record.kind,
            projectName: record.projectName,
            message: record.message,
            count: 1,
            firstTimestamp: record.timestamp,
            lastTimestamp: record.timestamp,
        });
    }
    return Array.from(collapsed.values());
}
//# sourceMappingURL=workspace-event-projection.js.map