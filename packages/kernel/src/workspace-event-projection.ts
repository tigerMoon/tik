import type { WorkflowSubtaskSpec } from '@tik/shared';
import type { WorkspaceEventKind, WorkspaceEventRecord } from './workspace-event-store.js';

export interface WorkspaceDisplayEventProjection {
  phase: WorkflowSubtaskSpec['phase'];
  kind: WorkspaceEventKind;
  projectName?: string;
  message: string;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

export interface WorkspacePhaseEventProjection {
  phase: WorkflowSubtaskSpec['phase'];
  eventCount: number;
  lastMessage?: string;
}

export interface WorkspaceProjectEventProjection {
  projectName: string;
  eventCount: number;
  feedbackCount: number;
  recoveryCount: number;
  completionCount: number;
  lastKind?: WorkspaceEventKind;
  lastMessage?: string;
}

export interface WorkspaceEventProjection {
  totalEvents: number;
  phases: WorkspacePhaseEventProjection[];
  projects: WorkspaceProjectEventProjection[];
  recent: WorkspaceEventRecord[];
  recentDisplay: WorkspaceDisplayEventProjection[];
}

export function buildWorkspaceEventProjection(records: WorkspaceEventRecord[]): WorkspaceEventProjection {
  const byPhase = new Map<WorkflowSubtaskSpec['phase'], WorkspaceEventRecord[]>();
  const byProject = new Map<string, WorkspaceEventRecord[]>();

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

function collapseWorkspaceDisplayEvents(records: WorkspaceEventRecord[]): WorkspaceDisplayEventProjection[] {
  const collapsed = new Map<string, WorkspaceDisplayEventProjection>();
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
