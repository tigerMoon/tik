/**
 * Agent Registry (Phase 2.7)
 *
 * Manages AgentSpec instances.
 * Does NOT manage runtime state or session binding.
 */
import type { AgentSpec } from './agent-spec.js';
/**
 * Registry for agent specifications.
 * Provides storage and lookup for agent definitions.
 */
export declare class AgentRegistry {
    private specs;
    /**
     * Register an agent specification.
     * Throws if an agent with the same ID already exists.
     */
    register(spec: AgentSpec): void;
    /**
     * Get an agent specification by ID.
     * Throws if not found.
     */
    get(id: string): AgentSpec;
    /**
     * List all registered agent specifications.
     */
    list(): AgentSpec[];
    /**
     * Check if an agent is registered.
     */
    has(id: string): boolean;
    /**
     * Unregister an agent specification.
     * Returns true if the agent was found and removed.
     */
    unregister(id: string): boolean;
}
//# sourceMappingURL=agent-registry.d.ts.map