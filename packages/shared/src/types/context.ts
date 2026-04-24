import type { SessionCompactMemory } from './session.js';
import type { EnvironmentPackManifest, EnvironmentPackSelection } from './environment-pack.js';

/**
 * Context Types
 *
 * Re-exports from SIGHT Context Intelligence system.
 * These types define the unified context structure used by the agent loop.
 */

// ─── Agent Context ───────────────────────────────────────────

export interface AgentContext {
  /** Specification context (requirements, plan, tasks) */
  spec?: SpecContext;
  /** Repository context (code structure, patterns, APIs) */
  repo?: RepoContext;
  /** Guardrail context (constraints, compatibility) */
  guardrail?: GuardrailContext;
  /** Run context (history, failures, patterns) */
  run?: RunContext;
  /** Memory context (learned patterns, decisions) */
  memory?: MemoryContext;
  /** Environment pack context (active environment capabilities/policies) */
  environment?: EnvironmentContext;
  /** Metadata */
  meta: ContextMetadata;
}

// ─── Spec Context ────────────────────────────────────────────

export interface SpecContext {
  /** Feature specification */
  spec?: string;
  /** Technical plan */
  plan?: string;
  /** Task breakdown (raw markdown content) */
  tasks?: string;
  /** Checklist items (raw markdown content) */
  checklist?: string;
}

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  dependencies?: string[];
}

export interface ChecklistItem {
  id: string;
  category: string;
  description: string;
  checked: boolean;
}

// ─── Repo Context ────────────────────────────────────────────

export interface RepoContext {
  /** Module structure */
  modules?: ModuleInfo[];
  /** Architecture patterns */
  patterns?: ArchitecturePattern[];
  /** High-probability repository paths inferred from the current task */
  candidates?: RepoCandidateHint[];
  /** Public APIs */
  publicAPIs?: APIInfo[];
  /** SPI extension points */
  spiPoints?: SPIInfo[];
}

export interface RepoCandidateHint {
  path: string;
  kind: 'directory' | 'file';
  score: number;
  reason: string;
}

export interface ModuleInfo {
  name: string;
  path: string;
  type: 'application' | 'domain' | 'infrastructure' | 'api';
  dependencies: string[];
}

export interface ArchitecturePattern {
  type: 'dto' | 'query' | 'service' | 'controller' | 'repository';
  examples: string[];
  conventions: string[];
}

export interface APIInfo {
  path: string;
  method: string;
  description: string;
}

export interface SPIInfo {
  interface: string;
  implementations: string[];
}

// ─── Guardrail Context ───────────────────────────────────────

export interface GuardrailContext {
  /** Compatibility constraints */
  constraints?: ConstraintInfo[];
  /** Breaking changes detected */
  breakingChanges?: BreakingChange[];
}

export interface ConstraintInfo {
  type: 'interface' | 'dto' | 'enum' | 'dependency';
  severity: 'hard' | 'soft';
  description: string;
}

export interface BreakingChange {
  type: string;
  location: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
}

// ─── Run Context ─────────────────────────────────────────────

export interface RunContext {
  /** Previous iterations */
  history?: IterationHistory[];
  /** Recent failures */
  failures?: FailureInfo[];
  /** Learned patterns */
  patterns?: LearnedPattern[];
}

export interface IterationHistory {
  iteration: number;
  fitness: number;
  drift: number;
  entropy: number;
  timestamp: number;
}

export interface FailureInfo {
  type: 'test' | 'build' | 'constraint' | 'review';
  message: string;
  location?: string;
  timestamp: number;
}

export interface LearnedPattern {
  type: 'architecture' | 'coding' | 'dependency' | 'design';
  description: string;
  confidence: number;
}

// ─── Memory Context ──────────────────────────────────────────

export interface MemoryContext {
  /** Memory blocks (Letta-style) */
  blocks?: MemoryBlock[];
  /** Archival passages */
  archival?: ArchivalPassage[];
}

export interface MemoryBlock {
  label: string;
  value: string;
  updatedAt: number;
}

export interface ArchivalPassage {
  id: string;
  text: string;
  tags: string[];
  source: string;
  timestamp: number;
}

// ─── Environment Pack Context ──────────────────────────────

export interface EnvironmentContext {
  activePackId: string;
  activePack: EnvironmentPackManifest;
  taskSelection?: EnvironmentPackSelection;
  availablePackIds: string[];
  source: string;
  updatedAt: string;
}

// ─── Context Metadata ────────────────────────────────────────

export interface ContextMetadata {
  /** Project path */
  projectPath: string;
  /** Task ID */
  taskId: string;
  /** Current iteration */
  iteration: number;
  /** Token budget used */
  tokensUsed: number;
  /** Timestamp */
  timestamp: number;
}

// ─── Bootstrap Context (Phase 2.8) ──────────────────────────

export interface BootstrapContext {
  /** Working directory */
  cwd: string;
  /** Current date */
  currentDate: string;
  /** OS info */
  os?: string;
  /** Git working tree status */
  gitStatus?: string;
  /** Git diff (staged + unstaged) */
  gitDiff?: string;
  /** Discovered instruction files */
  instructionFiles?: ContextFile[];
}

export interface ContextFile {
  /** File path */
  path: string;
  /** File content */
  content: string;
  /** Scope: project, parent, workspace */
  scope: string;
}

// ─── Conversation Context (Phase 2.8) ───────────────────────

export interface ConversationContext {
  /** Recent messages (post-compaction) */
  recentMessages: Array<{ role: string; content: string; name?: string }>;
  /** Summary of compacted older messages */
  compactSummary?: string;
  /** Structured continuation memory */
  sessionMemory?: SessionCompactMemory;
  /** Token usage snapshot */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ─── Tool Result Reference (Phase 2.8) ──────────────────────

export interface ToolResultRef {
  /** Tool call ID */
  toolCallId: string;
  /** Tool name */
  toolName: string;
  /** Preview text (first N bytes) */
  preview: string;
  /** Full result size in bytes */
  byteSize: number;
  /** Whether the result was truncated */
  truncated: boolean;
  /** Whether the tool execution failed */
  isError: boolean;
}

// ─── Runtime Context Envelope (Phase 2.8) ───────────────────

export interface RuntimeContextEnvelope {
  /** Runtime environment snapshot */
  bootstrap: BootstrapContext;
  /** Structured domain context from SIGHT */
  execution: AgentContext;
  /** Conversation state */
  conversation: ConversationContext;
  /** Envelope metadata */
  meta: {
    taskId: string;
    sessionId: string;
    iteration: number;
    agent: string;
    strategy: string;
  };
}

// ─── Context Builder Interface ───────────────────────────────

export interface BuildContextOptions {
  /** Current agent role */
  agent: string;
  /** Max tokens for context */
  maxTokens?: number;
  /** Include git diff in bootstrap */
  includeGitDiff?: boolean;
  /** Include instruction files */
  includeInstructionFiles?: boolean;
  /** Prefer a task-bound environment pack over the global active pack */
  environmentPackId?: string;
  /** Narrow the selected skills and knowledge sources within the chosen pack */
  environmentPackSelection?: EnvironmentPackSelection;
}

export interface IContextBuilder {
  /** Build unified context for a task (legacy, Phase 1) */
  buildContext(taskId: string, iteration: number, options?: BuildContextOptions): Promise<AgentContext>;

  /** Build session-aware context returning RuntimeContextEnvelope (Phase 2.8+) */
  buildFromSession?(task: any, session: any, options?: BuildContextOptions): Promise<RuntimeContextEnvelope>;

  /** Update context with new information */
  updateContext(taskId: string, updates: Partial<AgentContext>): Promise<void>;
}
