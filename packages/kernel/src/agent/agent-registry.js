/**
 * Agent Registry (Phase 2.7)
 *
 * Manages AgentSpec instances.
 * Does NOT manage runtime state or session binding.
 */
/**
 * Registry for agent specifications.
 * Provides storage and lookup for agent definitions.
 */
export class AgentRegistry {
    specs = new Map();
    /**
     * Register an agent specification.
     * Throws if an agent with the same ID already exists.
     */
    register(spec) {
        if (this.specs.has(spec.id)) {
            throw new Error(`Agent already registered: ${spec.id}`);
        }
        this.specs.set(spec.id, spec);
    }
    /**
     * Get an agent specification by ID.
     * Throws if not found.
     */
    get(id) {
        const spec = this.specs.get(id);
        if (!spec) {
            throw new Error(`Agent not found: ${id}`);
        }
        return spec;
    }
    /**
     * List all registered agent specifications.
     */
    list() {
        return Array.from(this.specs.values());
    }
    /**
     * Check if an agent is registered.
     */
    has(id) {
        return this.specs.has(id);
    }
    /**
     * Unregister an agent specification.
     * Returns true if the agent was found and removed.
     */
    unregister(id) {
        return this.specs.delete(id);
    }
}
//# sourceMappingURL=agent-registry.js.map