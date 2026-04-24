import * as os from 'node:os';
import * as path from 'node:path';
import type {
  WorkflowAgentRole,
  WorkflowSkillName,
  WorkflowSkillSourceKind,
  WorkspacePhase,
  WorkflowSubtaskContract,
} from '@tik/shared';
import {
  getWorkspaceWorkflowPhaseSpec,
  getWorkspaceWorkflowPhaseSpecByContract,
} from './workspace-workflow-spec.js';

export interface WorkflowSkillRouteBinding {
  phase: Extract<WorkspacePhase, 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'>;
  contract: WorkflowSubtaskContract;
  role: WorkflowAgentRole;
  skillName: WorkflowSkillName;
  skillSourceKind: WorkflowSkillSourceKind;
  skillPath: string;
  completionPromise: string;
  expectedOutput: string;
  summaryGoal: string;
}

const ROUTES: Record<WorkflowSkillRouteBinding['phase'], WorkflowSkillRouteBinding> = {
  PARALLEL_CLARIFY: {
    ...getWorkspaceWorkflowPhaseSpec('PARALLEL_CLARIFY'),
    skillSourceKind: 'superpowers',
    skillPath: resolveSuperpowersSkillPath('deep-interview'),
  },
  PARALLEL_SPECIFY: {
    ...getWorkspaceWorkflowPhaseSpec('PARALLEL_SPECIFY'),
    skillSourceKind: 'agents',
    skillPath: resolveAgentSkillPath('sdd-specify'),
  },
  PARALLEL_PLAN: {
    ...getWorkspaceWorkflowPhaseSpec('PARALLEL_PLAN'),
    skillSourceKind: 'agents',
    skillPath: resolveAgentSkillPath('sdd-plan'),
  },
  PARALLEL_ACE: {
    ...getWorkspaceWorkflowPhaseSpec('PARALLEL_ACE'),
    skillSourceKind: 'agents',
    skillPath: resolveAgentSkillPath('ace-sdd-workflow'),
  },
};

function resolveAgentSkillPath(skillName: Extract<WorkflowSkillName, 'sdd-specify' | 'sdd-plan' | 'ace-sdd-workflow'>): string {
  return path.join(os.homedir(), '.agents', 'skills', skillName, 'SKILL.md');
}

function resolveSuperpowersSkillPath(skillName: 'deep-interview' | 'ralplan'): string {
  return path.join(os.homedir(), '.codex', 'skills', skillName, 'SKILL.md');
}

export function getWorkflowSkillRouteByPhase(
  phase: WorkflowSkillRouteBinding['phase'],
): WorkflowSkillRouteBinding {
  return ROUTES[phase];
}

export function getWorkflowSkillRouteByContract(
  contract: WorkflowSubtaskContract,
): WorkflowSkillRouteBinding {
  const spec = getWorkspaceWorkflowPhaseSpecByContract(contract);
  return ROUTES[spec.phase];
}
