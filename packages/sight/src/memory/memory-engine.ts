/**
 * Memory Engine
 *
 * Records and queries runs, failures, decisions, and patterns.
 * Persistent storage in .ace/memory/ directory.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateId, now } from '@tik/shared';

// ─── Memory Types ────────────────────────────────────────────

export interface RunMemoryEntry {
  id: string;
  taskId: string;
  featureName?: string;
  iterations: number;
  finalState: 'CONVERGED' | 'FAILED' | 'MAX_ITERATIONS' | 'BLOCKED' | 'NOT_CONVERGED';
  finalFitness: number;
  startedAt: number;
  completedAt: number;
}

export interface FailureMemoryEntry {
  id: string;
  taskId: string;
  runId: string;
  type: 'test' | 'build' | 'review' | 'constraint' | 'drift' | 'entropy';
  target: string;
  message: string;
  resolution?: string;
  timestamp: number;
}

export interface DecisionMemoryEntry {
  id: string;
  taskId: string;
  type: 'architecture' | 'refactoring' | 'complexity' | 'api';
  description: string;
  rationale: string;
  impact: {
    fitnessChange: number;
    driftChange: number;
    entropyChange: number;
  };
  timestamp: number;
}

export interface PatternEntry {
  id: string;
  type: 'architecture' | 'coding' | 'dependency' | 'design';
  description: string;
  confidence: number;
  occurrences: number;
  lastSeen: number;
}

export interface LearningInsights {
  commonFailures: Array<{ type: string; count: number; resolution?: string }>;
  successfulStrategies: Array<{ strategy: string; successRate: number }>;
  patterns: PatternEntry[];
}

// ─── Memory Engine ───────────────────────────────────────────

export class MemoryEngine {
  private basePath: string;
  private runs: RunMemoryEntry[] = [];
  private failures: FailureMemoryEntry[] = [];
  private decisions: DecisionMemoryEntry[] = [];
  private patterns: PatternEntry[] = [];
  private loaded = false;

  constructor(projectPath: string) {
    this.basePath = path.join(projectPath, '.ace', 'memory');
  }

  // ── Record Operations ─────────────────────────────────────

  async recordRun(entry: Omit<RunMemoryEntry, 'id'>): Promise<RunMemoryEntry> {
    await this.ensureLoaded();
    const run: RunMemoryEntry = { id: generateId(), ...entry };
    this.runs.push(run);
    await this.persist('runs.json', this.runs);
    return run;
  }

  async recordFailure(entry: Omit<FailureMemoryEntry, 'id'>): Promise<FailureMemoryEntry> {
    await this.ensureLoaded();
    const failure: FailureMemoryEntry = { id: generateId(), ...entry };
    this.failures.push(failure);
    await this.persist('failures.json', this.failures);

    // Auto-learn patterns from repeated failures
    await this.learnFromFailure(failure);
    return failure;
  }

  async recordDecision(entry: Omit<DecisionMemoryEntry, 'id'>): Promise<DecisionMemoryEntry> {
    await this.ensureLoaded();
    const decision: DecisionMemoryEntry = { id: generateId(), ...entry };
    this.decisions.push(decision);
    await this.persist('decisions.json', this.decisions);
    return decision;
  }

  // ── Query Operations ──────────────────────────────────────

  async getRuns(filter?: { taskId?: string; finalState?: string }): Promise<RunMemoryEntry[]> {
    await this.ensureLoaded();
    let results = this.runs;
    if (filter?.taskId) results = results.filter(r => r.taskId === filter.taskId);
    if (filter?.finalState) results = results.filter(r => r.finalState === filter.finalState);
    return results;
  }

  async getFailures(filter?: { type?: string; target?: string }): Promise<FailureMemoryEntry[]> {
    await this.ensureLoaded();
    let results = this.failures;
    if (filter?.type) results = results.filter(f => f.type === filter.type);
    if (filter?.target) results = results.filter(f => f.target === filter.target);
    return results;
  }

  async getDecisions(filter?: { type?: string }): Promise<DecisionMemoryEntry[]> {
    await this.ensureLoaded();
    let results = this.decisions;
    if (filter?.type) results = results.filter(d => d.type === filter.type);
    return results;
  }

  async getInsights(): Promise<LearningInsights> {
    await this.ensureLoaded();

    // Common failures
    const failureCounts = new Map<string, { count: number; resolution?: string }>();
    for (const f of this.failures) {
      const key = `${f.type}:${f.target}`;
      const existing = failureCounts.get(key) || { count: 0 };
      existing.count++;
      if (f.resolution) existing.resolution = f.resolution;
      failureCounts.set(key, existing);
    }

    // Successful strategies
    const strategyCounts = new Map<string, { success: number; total: number }>();
    for (const r of this.runs) {
      const key = r.finalState === 'CONVERGED' ? 'converged' : 'other';
      const existing = strategyCounts.get(key) || { success: 0, total: 0 };
      existing.total++;
      if (r.finalState === 'CONVERGED') existing.success++;
      strategyCounts.set(key, existing);
    }

    return {
      commonFailures: Array.from(failureCounts.entries()).map(([type, data]) => ({
        type,
        count: data.count,
        resolution: data.resolution,
      })).sort((a, b) => b.count - a.count).slice(0, 10),

      successfulStrategies: Array.from(strategyCounts.entries()).map(([strategy, data]) => ({
        strategy,
        successRate: data.total > 0 ? data.success / data.total : 0,
      })),

      patterns: this.patterns,
    };
  }

  // ── Pattern Learning ──────────────────────────────────────

  async getPatterns(): Promise<PatternEntry[]> {
    await this.ensureLoaded();
    return this.patterns;
  }

  // ── Private Methods ───────────────────────────────────────

  private async learnFromFailure(failure: FailureMemoryEntry): Promise<void> {
    // Find similar failures (same type + target)
    const similar = this.failures.filter(
      f => f.type === failure.type && f.target === failure.target && f.id !== failure.id,
    );

    // If 3+ similar failures, create a pattern
    if (similar.length >= 2) {
      const existingPattern = this.patterns.find(
        p => p.description.includes(failure.type) && p.description.includes(failure.target),
      );

      if (existingPattern) {
        existingPattern.occurrences++;
        existingPattern.confidence = Math.min(1, existingPattern.confidence + 0.1);
        existingPattern.lastSeen = now();
      } else {
        this.patterns.push({
          id: generateId(),
          type: this.mapFailureToPatternType(failure.type),
          description: `Recurring ${failure.type} failure in ${failure.target}`,
          confidence: 0.5,
          occurrences: similar.length + 1,
          lastSeen: now(),
        });
      }

      await this.persist('patterns.json', this.patterns);
    }
  }

  private mapFailureToPatternType(failureType: string): PatternEntry['type'] {
    switch (failureType) {
      case 'build':
      case 'constraint': return 'dependency';
      case 'review': return 'coding';
      case 'drift': return 'architecture';
      default: return 'design';
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.runs = await this.load('runs.json') || [];
    this.failures = await this.load('failures.json') || [];
    this.decisions = await this.load('decisions.json') || [];
    this.patterns = await this.load('patterns.json') || [];
    this.loaded = true;
  }

  private async load<T>(filename: string): Promise<T | null> {
    try {
      const filePath = path.join(this.basePath, filename);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  private async persist(filename: string, data: unknown): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    const filePath = path.join(this.basePath, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
