/**
 * API Server
 *
 * Fastify-based HTTP server for Tik.
 * Provides REST API + SSE for CLI and Dashboard.
 */
import type { ExecutionKernel } from './execution-kernel.js';
import type { AgentRuntimeName } from './tracker-daemon/types.js';
import type { AgentRuntimeRunner } from './agent-runners/agent-runtime-runner.js';
export interface ServerConfig {
    port: number;
    host: string;
}
export interface WorkspaceServerOptions {
    workspaceRoot?: string;
    apiToken?: string;
    dashboardOrigin?: string;
    allowUnauthenticatedRemote?: boolean;
    enableLegacyPathArtifactPreview?: boolean;
    runtimeRunners?: Partial<Record<AgentRuntimeName, AgentRuntimeRunner>>;
}
export declare function createServer(kernel: ExecutionKernel, config?: ServerConfig, options?: WorkspaceServerOptions): Promise<import("fastify").FastifyInstance<import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, import("fastify").FastifyBaseLogger, import("fastify").FastifyTypeProviderDefault>>;
//# sourceMappingURL=server.d.ts.map