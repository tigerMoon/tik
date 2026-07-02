/**
 * Context Renderer (Phase 2.8)
 *
 * Replaces JSON.stringify(context) with section-based, role-aware rendering.
 * Each agent role gets a different "evidence pack" tailored to its decision.
 *
 * Section ordering follows claw-code-main's prompt.rs pattern:
 * 1. Environment (always)
 * 2. Instructions (if any)
 * 3. Spec (strong for planner)
 * 4. Repo (strong for planner)
 * 5. Git diff (strong for coder/reviewer)
 * 6. Run context (strong for reviewer)
 * 7. Strategy/constraints
 * 8. Conversation summary (if compacted)
 */
import type { RuntimeContextEnvelope } from '@tik/shared';
export declare class ContextRenderer {
    /**
     * Render a RuntimeContextEnvelope into a formatted string for LLM consumption.
     */
    render(envelope: RuntimeContextEnvelope): string;
    private renderEnvironment;
    private renderInstructions;
    private renderMeta;
    private renderEnvironmentPack;
    private renderSpec;
    private renderRepo;
    private renderSearchGuidance;
    private renderRun;
    private renderConversation;
    private renderOperatorGuidance;
    private truncate;
}
//# sourceMappingURL=context-renderer.d.ts.map