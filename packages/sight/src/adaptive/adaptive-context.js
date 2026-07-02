/**
 * Adaptive Context
 *
 * Feedback loop that injects failure context into the next iteration.
 * Automatically extracts relevant code snippets and error information
 * from previous failures to help the agent fix issues.
 */
import { generateId } from '@tik/shared';
// ─── Feedback Collector ──────────────────────────────────────
export class FeedbackCollector {
    events = [];
    collect(event) {
        this.events.push(event);
    }
    getEvents(iteration) {
        if (iteration !== undefined) {
            return this.events.filter(e => e.iteration === iteration);
        }
        return [...this.events];
    }
    clear() {
        this.events = [];
    }
}
// ─── Adaptive Fragment Generator ─────────────────────────────
export class AdaptiveFragmentGenerator {
    /**
     * Generate adaptive context fragments from feedback events.
     * These fragments get priority injection (max 50% of run budget).
     */
    generate(events) {
        if (events.length === 0)
            return [];
        const fragments = [];
        // Group events by type
        const byType = new Map();
        for (const event of events) {
            if (!byType.has(event.type)) {
                byType.set(event.type, []);
            }
            byType.get(event.type).push(event);
        }
        // Generate focused fragments for each failure type
        for (const [type, typeEvents] of byType) {
            const priority = this.getPriority(type);
            const content = this.formatEvents(type, typeEvents);
            fragments.push({
                id: generateId(),
                category: 'adaptive',
                content,
                tokenCount: Math.ceil(content.length / 4),
                relevance: 1.0, // Always highly relevant
                recency: 1.0, // Always fresh
                importance: priority / 10,
                priority: 0, // Computed by ranker
                source: `adaptive:${type}`,
                tags: ['adaptive', type],
            });
        }
        return fragments;
    }
    getPriority(type) {
        switch (type) {
            case 'test_failure': return 10;
            case 'build_error': return 10;
            case 'integration_failure': return 9;
            case 'constraint_violation': return 8;
            case 'architecture_violation': return 8;
            case 'review_issue': return 7;
            case 'drift_regression': return 7;
            default: return 5;
        }
    }
    formatEvents(type, events) {
        const lines = [];
        lines.push(`## Previous Failures: ${type} (${events.length} occurrences)`);
        lines.push('');
        for (const event of events.slice(0, 5)) { // Max 5 per type
            lines.push(`### ${event.message}`);
            if (event.location)
                lines.push(`Location: ${event.location}`);
            if (event.codeSnippet) {
                lines.push('```');
                lines.push(event.codeSnippet);
                lines.push('```');
            }
            if (event.stackTrace) {
                lines.push('Stack trace (truncated):');
                lines.push('```');
                lines.push(event.stackTrace.split('\n').slice(0, 5).join('\n'));
                lines.push('```');
            }
            lines.push('');
        }
        return lines.join('\n');
    }
}
// ─── Adaptive Context Injector ───────────────────────────────
export class AdaptiveContextInjector {
    collector;
    generator;
    constructor() {
        this.collector = new FeedbackCollector();
        this.generator = new AdaptiveFragmentGenerator();
    }
    /** Record a feedback event */
    recordFeedback(event) {
        this.collector.collect(event);
    }
    /** Get adaptive fragments for the next iteration */
    getAdaptiveFragments(lastIteration) {
        const events = this.collector.getEvents(lastIteration);
        return this.generator.generate(events);
    }
    /** Get all collected feedback */
    getAllFeedback() {
        return this.collector.getEvents();
    }
}
//# sourceMappingURL=adaptive-context.js.map