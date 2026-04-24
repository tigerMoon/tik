/**
 * @tik/sight
 *
 * SIGHT Context Intelligence for Tik.
 */

// Context
export { ContextEngine } from './context/context-engine.js';
export { ContextRanker } from './context/context-ranker.js';
export { ContextBudgeter } from './context/context-budgeter.js';
export type { ContextFragment, ContextCategory, ContextBudget } from './context/types.js';

// Bootstrap (Phase 2.8)
export { BootstrapContextBuilder } from './bootstrap/bootstrap-context.js';

// Compact (Phase 2.8)
export { MicroCompactor } from './compact/micro-compactor.js';
export type { CompactionOptions, CompactionResult } from './compact/micro-compactor.js';

// Renderer (Phase 2.8)
export { ContextRenderer } from './renderer/context-renderer.js';

// Store (Phase 2.8)
export { ToolResultStore } from './store/tool-result-store.js';

// Adaptive
export { AdaptiveContextInjector } from './adaptive/adaptive-context.js';
export type { FeedbackEvent } from './adaptive/adaptive-context.js';

// Graph
export { ContextGraph } from './graph/context-graph.js';

// Memory
export { MemoryEngine } from './memory/memory-engine.js';

// Plugin
export { PluginRegistry } from './plugin/registry.js';
export { LocalContextProvider } from './plugin/local-provider.js';
export type {
  IContextProvider,
  IContextMemoryPlugin,
} from './plugin/types.js';

// Runtime
export { SIGHTRuntime } from './runtime/sight-runtime.js';
export type { SIGHTConfig } from './runtime/sight-runtime.js';
