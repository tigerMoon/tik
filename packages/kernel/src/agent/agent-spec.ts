/**
 * Agent Specification (Phase 2.7)
 *
 * Defines what an agent is, without coupling to runtime execution.
 * This is the minimal version - model/tools overrides deferred to Phase 2.8.
 */

import type { AgentRole } from '@tik/shared';

/**
 * AgentSpec describes an agent's identity and behavior.
 * Phase 2.7 minimal version - only essential fields.
 */
export interface AgentSpec {
  /** Unique identifier for this agent */
  id: string;

  /** Role in the multi-agent system */
  role: AgentRole;

  /** System instructions/prompt for this agent */
  instructions: string;

  /** Optional allowlist of tools exposed to this agent */
  allowedTools?: string[];

  /** Optional tool names the agent should prefer using first */
  preferredTools?: string[];

  /** Optional installed skill name to append as methodology guidance */
  skillName?: string;

  /** Optional explicit installed skill path */
  skillPath?: string;

  /** Whether missing installed skill should silently fall back to base prompt */
  skillOptional?: boolean;

  /** Optional metadata */
  metadata?: {
    description?: string;
    version?: string;
    capabilityProfile?: 'default' | 'frontend';
  };
}
