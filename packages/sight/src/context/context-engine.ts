/**
 * Context Engine (Phase 2.8)
 *
 * Unified context builder for Tik.
 * Pipeline: Raw Fragments → Ranker → Budgeter → Packager → AgentContext
 *
 * Phase 2.8 additions:
 * - buildFromSession returns RuntimeContextEnvelope
 * - BootstrapContextBuilder for environment snapshot
 * - MicroCompactor for session message cleanup
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentContext,
  IContextBuilder,
  IEventBus,
  RepoContext,
  RunContext,
  RuntimeContextEnvelope,
  ConversationContext,
  BuildContextOptions,
} from '@tik/shared';
import { EventType, generateId, now } from '@tik/shared';
import type { ContextFragment, ContextCategory } from './types.js';
import { ContextRanker } from './context-ranker.js';
import { ContextBudgeter } from './context-budgeter.js';
import type { IContextProvider } from '../plugin/types.js';
import { BootstrapContextBuilder } from '../bootstrap/bootstrap-context.js';
import { MicroCompactor } from '../compact/micro-compactor.js';
import { RepoCandidateFinder, type RepoCandidateMatch } from './repo-candidate-finder.js';
import { EnvironmentPackLoader } from './environment-pack-loader.js';

// ─── Context Engine ──────────────────────────────────────────

export class ContextEngine implements IContextBuilder {
  private ranker: ContextRanker;
  private budgeter: ContextBudgeter;
  private providers: IContextProvider[] = [];
  private eventBus?: IEventBus;
  private projectPath: string;
  private bootstrapBuilder: BootstrapContextBuilder;
  private compactor: MicroCompactor;
  private candidateFinder: RepoCandidateFinder;
  private environmentPackLoader: EnvironmentPackLoader;

  constructor(projectPath: string, eventBus?: IEventBus) {
    this.ranker = new ContextRanker();
    this.budgeter = new ContextBudgeter();
    this.projectPath = projectPath;
    this.eventBus = eventBus;
    this.bootstrapBuilder = new BootstrapContextBuilder();
    this.compactor = new MicroCompactor();
    this.candidateFinder = new RepoCandidateFinder();
    this.environmentPackLoader = new EnvironmentPackLoader(projectPath);
  }

  /** Register a context provider */
  addProvider(provider: IContextProvider): void {
    this.providers.push(provider);
  }

  /** Build unified context for a task */
  async buildContext(taskId: string, iteration: number, options?: BuildContextOptions): Promise<AgentContext> {
    const startTime = now();

    // Step 1: Collect fragments from all providers
    const allFragments: ContextFragment[] = [];
    for (const provider of this.providers) {
      const fragments = await provider.getFragments(this.projectPath, taskId, iteration);
      allFragments.push(...fragments);
    }

    // Step 2: Rank fragments by priority
    const ranked = this.ranker.rank(allFragments);

    // Step 3: Budget allocation
    const selected = this.budgeter.allocate(ranked);

    // Step 4: Package into AgentContext
    const context = this.packageContext(selected, taskId, iteration);
    context.environment = await this.environmentPackLoader.load(
      options?.environmentPackId,
      options?.environmentPackSelection,
    );

    return context;
  }

  /** Build session-aware context returning RuntimeContextEnvelope (Phase 2.8) */
  async buildFromSession(task: any, session: any, options?: BuildContextOptions): Promise<RuntimeContextEnvelope> {
    const startTime = now();

    // 1. Build bootstrap context (cwd, date, os, git, instructions)
    const bootstrap = await this.bootstrapBuilder.build(this.projectPath);

    // 2. Compact session messages
    const compacted = this.compactor.compact(session.messages || [], {
      keepRecent: 5,
      maxTokens: 4000,
    });

    // 3. Build execution context (existing SIGHT pipeline)
    const execution = await this.buildContext(task.id, session.step || 1, {
      agent: options?.agent || session.currentAgent || 'coder',
      maxTokens: options?.maxTokens,
      includeGitDiff: options?.includeGitDiff,
      includeInstructionFiles: options?.includeInstructionFiles,
      environmentPackId: task.environmentPackSnapshot?.id,
      environmentPackSelection: task.environmentPackSelection,
    });

    const repoCandidates = await this.candidateFinder.find(this.projectPath, {
      taskDescription: task.description || '',
      recentText: compacted.messages
        .slice(-5)
        .map((message: any) => String(message.content || ''))
        .filter(Boolean),
      sessionSummary: session.contextSummary,
    });

    if (repoCandidates.length > 0) {
      execution.repo = {
        ...(execution.repo || {}),
        candidates: repoCandidates,
      } as RepoContextWithCandidates;
    }

    // 4. Build conversation context
    const conversation: ConversationContext = {
      recentMessages: compacted.messages.slice(-5).map((m: any) => ({
        role: m.role,
        content: m.content,
        name: m.name,
      })),
      compactSummary: session.contextSummary || compacted.summary,
      sessionMemory: session.compactMemory,
    };

    // 5. Package envelope
    const envelope: RuntimeContextEnvelope = {
      bootstrap,
      execution,
      conversation,
      meta: {
        taskId: task.id,
        sessionId: session.sessionId || '',
        iteration: session.step || 1,
        agent: options?.agent || session.currentAgent || 'coder',
        strategy: task.strategy || 'incremental',
      },
    };

    // Event emission handled by AgentLoop (single source)

    return envelope;
  }

  async updateContext(_taskId: string, _updates: Partial<AgentContext>): Promise<void> {
    // Context updates will be reflected in next buildContext call
    // via providers returning updated fragments
  }

  // ─── Private Methods ──────────────────────────────────────

  private packageContext(
    fragments: ContextFragment[],
    taskId: string,
    iteration: number,
  ): AgentContext {
    const byCategory = new Map<ContextCategory, ContextFragment[]>();
    let totalTokens = 0;

    for (const f of fragments) {
      if (!byCategory.has(f.category)) {
        byCategory.set(f.category, []);
      }
      byCategory.get(f.category)!.push(f);
      totalTokens += f.tokenCount;
    }

    return {
      spec: this.extractSpecContext(byCategory.get('spec') || []),
      repo: this.extractRepoContext(byCategory.get('repo') || []),
      guardrail: this.extractGuardrailContext(byCategory.get('guardrail') || []),
      run: this.extractRunContext(byCategory.get('run') || []),
      memory: this.extractMemoryContext(byCategory.get('memory') || []),
      meta: {
        projectPath: this.projectPath,
        taskId,
        iteration,
        tokensUsed: totalTokens,
        timestamp: now(),
      },
    };
  }

  private extractSpecContext(fragments: ContextFragment[]) {
    if (fragments.length === 0) return undefined;
    const spec = fragments.find(f => f.tags.includes('spec'))?.content;
    const plan = fragments.find(f => f.tags.includes('plan'))?.content;
    const tasks = fragments.find(f => f.tags.includes('tasks'))?.content;
    const checklist = fragments.find(f => f.tags.includes('checklist'))?.content;
    return { spec, plan, tasks, checklist };
  }

  private extractRepoContext(fragments: ContextFragment[]): RepoContext | undefined {
    if (fragments.length === 0) return undefined;

    const modules: RepoContext['modules'] = [];
    const patterns: RepoContext['patterns'] = [];

    // Parse metadata fragment for module info
    const metaFrag = fragments.find(f => f.source === 'project-metadata');
    if (metaFrag) {
      try {
        const lines = metaFrag.content.split('\n');
        const projectFile = lines[0]?.replace('# Project: ', '') || '';
        // Extract name from common project files
        if (projectFile === 'package.json') {
          const json = JSON.parse(lines.slice(1).join('\n'));
          modules.push({ name: json.name || 'root', path: '.', type: 'application', dependencies: Object.keys(json.dependencies || {}) });
        } else if (projectFile === 'pom.xml') {
          const artifactMatch = metaFrag.content.match(/<artifactId>([^<]+)/);
          if (artifactMatch) modules.push({ name: artifactMatch[1], path: '.', type: 'application', dependencies: [] });
        }
      } catch {}
    }

    // Parse file tree for structure patterns
    const treeFrag = fragments.find(f => f.source === 'file-tree');
    if (treeFrag) {
      const lines = treeFrag.content.split('\n').filter(l => !l.startsWith('#'));
      const dirs = lines.filter(l => !l.includes('.')).map(l => l.trim());
      const srcDirs = dirs.filter(d => d.includes('/src') || d.includes('/lib') || d.includes('/app'));
      if (srcDirs.length > 0) {
        patterns.push({ type: 'repository' as const, examples: srcDirs.slice(0, 5), conventions: [] });
      }
    }

    return { modules, patterns, publicAPIs: [], spiPoints: [] };
  }

  private extractGuardrailContext(fragments: ContextFragment[]) {
    if (fragments.length === 0) return undefined;
    // Guardrail context will be enriched via MCP in Phase 3
    return { constraints: [], breakingChanges: [] };
  }

  private extractRunContext(fragments: ContextFragment[]): RunContext | undefined {
    if (fragments.length === 0) return undefined;

    const history: Array<{ iteration: number; fitness: number; drift: number; entropy: number; timestamp: number }> = [];
    const failures: RunContext['failures'] = [];

    // Parse run state
    const stateFrag = fragments.find(f => f.source === 'run-state');
    if (stateFrag) {
      try {
        const state = JSON.parse(stateFrag.content);
        if (Array.isArray(state.iterations)) {
          for (const iter of state.iterations) {
            history.push({
              iteration: iter.number || 0,
              fitness: iter.evaluation?.fitness || 0,
              drift: iter.evaluation?.drift || 0,
              entropy: iter.evaluation?.entropy || 0,
              timestamp: iter.timestamp || 0,
            });
          }
        }
      } catch {}
    }

    // Parse failures
    const failFrag = fragments.find(f => f.source === 'failures');
    if (failFrag) {
      try {
        const parsed = JSON.parse(failFrag.content);
        if (Array.isArray(parsed)) {
          for (const f of parsed.slice(-10)) {
            failures.push({ type: (f.type || 'build') as 'test' | 'build' | 'constraint' | 'review', message: f.message || '', timestamp: f.timestamp || 0 });
          }
        }
      } catch {}
    }

    return { history, failures, patterns: [] };
  }

  private extractMemoryContext(fragments: ContextFragment[]) {
    if (fragments.length === 0) return undefined;
    return {
      blocks: [],
      archival: [],
    };
  }
}

type RepoContextWithCandidates = RepoContext & {
  candidates?: RepoCandidateMatch[];
};
