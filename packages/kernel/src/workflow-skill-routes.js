import * as os from 'node:os';
import * as path from 'node:path';
import { getWorkspaceWorkflowPhaseSpec, getWorkspaceWorkflowPhaseSpecByContract, } from './workspace-workflow-spec.js';
const ROUTES = {
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
function resolveAgentSkillPath(skillName) {
    return path.join(os.homedir(), '.agents', 'skills', skillName, 'SKILL.md');
}
function resolveSuperpowersSkillPath(skillName) {
    return path.join(os.homedir(), '.codex', 'skills', skillName, 'SKILL.md');
}
export function getWorkflowSkillRouteByPhase(phase) {
    return ROUTES[phase];
}
export function getWorkflowSkillRouteByContract(contract) {
    const spec = getWorkspaceWorkflowPhaseSpecByContract(contract);
    return ROUTES[spec.phase];
}
//# sourceMappingURL=workflow-skill-routes.js.map