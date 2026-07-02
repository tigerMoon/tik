/**
 * Memory Engine
 *
 * Records and queries runs, failures, decisions, and patterns.
 * Persistent storage in .ace/memory/ directory.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateId, now } from '@tik/shared';
// ─── Memory Engine ───────────────────────────────────────────
export class MemoryEngine {
    basePath;
    runs = [];
    failures = [];
    decisions = [];
    patterns = [];
    loaded = false;
    constructor(projectPath) {
        this.basePath = path.join(projectPath, '.ace', 'memory');
    }
    // ── Record Operations ─────────────────────────────────────
    async recordRun(entry) {
        await this.ensureLoaded();
        const run = { id: generateId(), ...entry };
        this.runs.push(run);
        await this.persist('runs.json', this.runs);
        return run;
    }
    async recordFailure(entry) {
        await this.ensureLoaded();
        const failure = { id: generateId(), ...entry };
        this.failures.push(failure);
        await this.persist('failures.json', this.failures);
        // Auto-learn patterns from repeated failures
        await this.learnFromFailure(failure);
        return failure;
    }
    async recordDecision(entry) {
        await this.ensureLoaded();
        const decision = { id: generateId(), ...entry };
        this.decisions.push(decision);
        await this.persist('decisions.json', this.decisions);
        return decision;
    }
    // ── Query Operations ──────────────────────────────────────
    async getRuns(filter) {
        await this.ensureLoaded();
        let results = this.runs;
        if (filter?.taskId)
            results = results.filter(r => r.taskId === filter.taskId);
        if (filter?.finalState)
            results = results.filter(r => r.finalState === filter.finalState);
        return results;
    }
    async getFailures(filter) {
        await this.ensureLoaded();
        let results = this.failures;
        if (filter?.type)
            results = results.filter(f => f.type === filter.type);
        if (filter?.target)
            results = results.filter(f => f.target === filter.target);
        return results;
    }
    async getDecisions(filter) {
        await this.ensureLoaded();
        let results = this.decisions;
        if (filter?.type)
            results = results.filter(d => d.type === filter.type);
        return results;
    }
    async getInsights() {
        await this.ensureLoaded();
        // Common failures
        const failureCounts = new Map();
        for (const f of this.failures) {
            const key = `${f.type}:${f.target}`;
            const existing = failureCounts.get(key) || { count: 0 };
            existing.count++;
            if (f.resolution)
                existing.resolution = f.resolution;
            failureCounts.set(key, existing);
        }
        // Successful strategies
        const strategyCounts = new Map();
        for (const r of this.runs) {
            const key = r.finalState === 'CONVERGED' ? 'converged' : 'other';
            const existing = strategyCounts.get(key) || { success: 0, total: 0 };
            existing.total++;
            if (r.finalState === 'CONVERGED')
                existing.success++;
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
    async getPatterns() {
        await this.ensureLoaded();
        return this.patterns;
    }
    // ── Private Methods ───────────────────────────────────────
    async learnFromFailure(failure) {
        // Find similar failures (same type + target)
        const similar = this.failures.filter(f => f.type === failure.type && f.target === failure.target && f.id !== failure.id);
        // If 3+ similar failures, create a pattern
        if (similar.length >= 2) {
            const existingPattern = this.patterns.find(p => p.description.includes(failure.type) && p.description.includes(failure.target));
            if (existingPattern) {
                existingPattern.occurrences++;
                existingPattern.confidence = Math.min(1, existingPattern.confidence + 0.1);
                existingPattern.lastSeen = now();
            }
            else {
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
    mapFailureToPatternType(failureType) {
        switch (failureType) {
            case 'build':
            case 'constraint': return 'dependency';
            case 'review': return 'coding';
            case 'drift': return 'architecture';
            default: return 'design';
        }
    }
    async ensureLoaded() {
        if (this.loaded)
            return;
        this.runs = await this.load('runs.json') || [];
        this.failures = await this.load('failures.json') || [];
        this.decisions = await this.load('decisions.json') || [];
        this.patterns = await this.load('patterns.json') || [];
        this.loaded = true;
    }
    async load(filename) {
        try {
            const filePath = path.join(this.basePath, filename);
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return null;
        }
    }
    async persist(filename, data) {
        await fs.mkdir(this.basePath, { recursive: true });
        const filePath = path.join(this.basePath, filename);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
}
//# sourceMappingURL=memory-engine.js.map