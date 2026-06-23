import React from 'react';
import ReactMarkdown from 'react-markdown';

interface MarkdownViewProps {
  source: string;
  /** Tighter typography for compact surfaces (rail, timeline). */
  compact?: boolean;
}

const ALLOWED_ELEMENTS = [
  'p', 'br', 'hr',
  'strong', 'em', 'del',
  'a',
  'ul', 'ol', 'li',
  'code', 'pre',
  'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
];

/**
 * Renders a markdown string with the small subset of elements we care about
 * for task comments and timeline summaries. Raw HTML is silently dropped, so
 * an operator who pastes `<script>` or `<iframe>` into a comment doesn't get
 * to escape the sandbox. Links open in a new tab.
 */
export function MarkdownView({ source, compact }: MarkdownViewProps) {
  return (
    <div className={`md-view ${compact ? 'md-view-compact' : ''}`}>
      <ReactMarkdown
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        skipHtml
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
