/**
 * Adaptive Context
 *
 * Feedback loop that injects failure context into the next iteration.
 * Automatically extracts relevant code snippets and error information
 * from previous failures to help the agent fix issues.
 */
import type { ContextFragment } from '../context/types.js';
export type FeedbackEventType = 'test_failure' | 'build_error' | 'architecture_violation' | 'constraint_violation' | 'integration_failure' | 'review_issue' | 'drift_regression';
export interface FeedbackEvent {
    type: FeedbackEventType;
    message: string;
    location?: string;
    stackTrace?: string;
    codeSnippet?: string;
    iteration: number;
    timestamp: number;
}
export declare class FeedbackCollector {
    private events;
    collect(event: FeedbackEvent): void;
    getEvents(iteration?: number): FeedbackEvent[];
    clear(): void;
}
export declare class AdaptiveFragmentGenerator {
    /**
     * Generate adaptive context fragments from feedback events.
     * These fragments get priority injection (max 50% of run budget).
     */
    generate(events: FeedbackEvent[]): ContextFragment[];
    private getPriority;
    private formatEvents;
}
export declare class AdaptiveContextInjector {
    private collector;
    private generator;
    constructor();
    /** Record a feedback event */
    recordFeedback(event: FeedbackEvent): void;
    /** Get adaptive fragments for the next iteration */
    getAdaptiveFragments(lastIteration: number): ContextFragment[];
    /** Get all collected feedback */
    getAllFeedback(): FeedbackEvent[];
}
//# sourceMappingURL=adaptive-context.d.ts.map