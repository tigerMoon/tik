import React from 'react';
interface MarkdownViewProps {
    source: string;
    /** Tighter typography for compact surfaces (rail, timeline). */
    compact?: boolean;
}
/**
 * Renders a markdown string with the small subset of elements we care about
 * for task comments and timeline summaries. Raw HTML is silently dropped, so
 * an operator who pastes `<script>` or `<iframe>` into a comment doesn't get
 * to escape the sandbox. Links open in a new tab.
 */
export declare function MarkdownView({ source, compact }: MarkdownViewProps): React.JSX.Element;
export {};
//# sourceMappingURL=MarkdownView.d.ts.map