import { describe, expect, it } from 'vitest';
import * as AgentApi from '../src/agent-api.js';
import * as CodexApi from '../src/codex-api.js';
import * as RootApi from '../src/index.js';
import * as RuntimeApi from '../src/runtime-api.js';
import * as ToolsApi from '../src/tools-api.js';
import * as TrackerApi from '../src/tracker-api.js';
import * as WorkbenchApi from '../src/workbench-api.js';
import * as WorkspaceApi from '../src/workspace-api.js';
describe('kernel public API layers', () => {
    it('keeps the root barrel backward-compatible while exposing focused layers', () => {
        expect(RuntimeApi.ExecutionKernel).toBe(RootApi.ExecutionKernel);
        expect(RuntimeApi.AgentLoop).toBe(RootApi.AgentLoop);
        expect(ToolsApi.ToolScheduler).toBe(RootApi.ToolScheduler);
        expect(WorkbenchApi.WorkbenchService).toBe(RootApi.WorkbenchService);
        expect(WorkspaceApi.WorkspaceWorkflowEngine).toBe(RootApi.WorkspaceWorkflowEngine);
        expect(TrackerApi.TrackerDaemon).toBe(RootApi.TrackerDaemon);
        expect(CodexApi.CodexHarnessAdapter).toBe(RootApi.CodexHarnessAdapter);
        expect(AgentApi.AgentRegistry).toBe(RootApi.AgentRegistry);
    });
    it('keeps runtime exports free of workspace/server implementation details', () => {
        expect(Object.keys(RuntimeApi).sort()).toEqual([
            'AgentLoop',
            'EventBus',
            'ExecutionKernel',
            'TaskManager',
            'ToolRegistry',
            'ToolScheduler',
        ].sort());
    });
});
//# sourceMappingURL=public-api.test.js.map