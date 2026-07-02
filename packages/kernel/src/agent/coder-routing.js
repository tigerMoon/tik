import { inspectFrontendProject, isLikelyFrontendTask } from '../frontend-project.js';
export const FRONTEND_CODER_AGENT_ID = 'frontend-coder';
export const DEFAULT_CODER_AGENT_ID = 'coder';
export function selectCoderAgentId(taskDescription, projectPath) {
    const report = projectPath ? inspectFrontendProject(projectPath) : undefined;
    return isLikelyFrontendTask(taskDescription, report)
        ? FRONTEND_CODER_AGENT_ID
        : DEFAULT_CODER_AGENT_ID;
}
//# sourceMappingURL=coder-routing.js.map