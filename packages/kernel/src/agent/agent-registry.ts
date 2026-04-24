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
export class AgentRegistry {
  private specs = new Map<string, AgentSpec>();

  /**
   * Register an agent specification.
   * Throws if an agent with the same ID already exists.
   */
  register(spec: AgentSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`Agent already registered: ${spec.id}`);
    }
    this.specs.set(spec.id, spec);
  }

  /**
   * Get an agent specification by ID.
   * Throws if not found.
   */
  get(id: string): AgentSpec {
    const spec = this.specs.get(id);
    if (!spec) {
      throw new Error(`Agent not found: ${id}`);
    }
    return spec;
  }

  /**
   * List all registered agent specifications.
   */
  list(): AgentSpec[] {
    return Array.from(this.specs.values());
  }

  /**
   * Check if an agent is registered.
   */
  has(id: string): boolean {
    return this.specs.has(id);
  }

  /**
   * Unregister an agent specification.
   * Returns true if the agent was found and removed.
   */
  unregister(id: string): boolean {
    return this.specs.delete(id);
  }
}
