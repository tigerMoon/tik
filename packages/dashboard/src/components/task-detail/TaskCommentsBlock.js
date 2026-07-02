import React, { useEffect, useState } from 'react';
import { MarkdownView } from '../markdown/MarkdownView';
const COMPOSER_PLACEHOLDER = 'Add a comment. Slash commands: /approve /done /retry /block /cancel';
export function TaskCommentsBlock({ task, timeline, onAddTaskComment }) {
    const [draft, setDraft] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    // Reset composer state when switching to a different task.
    useEffect(() => {
        setDraft('');
        setError(null);
        setSubmitting(false);
    }, [task.id]);
    const comments = task.comments || [];
    const reverseChronological = [...comments].reverse();
    const latestHumanComment = reverseChronological.find((comment) => (comment.authorKind === 'human' && comment.body.trim()));
    const hasRunError = task.status !== 'archived' && Boolean(task.evidenceSummary?.hasErrorEvidence);
    const commentStates = buildCommentProcessingStates(comments, timeline);
    return (<section className="task-detail-comments">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Comments</span>
        <span className="task-detail-block-meta">{comments.length}</span>
      </div>

      {hasRunError ? (<div className="task-detail-comment-run-alert">
          <div>
            <strong>Run had errors</strong>
            <span>
              {latestHumanComment
                ? 'The latest execution recorded tool errors after this comment.'
                : 'The latest execution recorded tool errors.'}
            </span>
          </div>
          {latestHumanComment ? (<blockquote>{latestHumanComment.body}</blockquote>) : null}
        </div>) : null}

      <form className="task-detail-comments-form" onSubmit={async (event) => {
            event.preventDefault();
            const body = draft.trim();
            if (!body) {
                return;
            }
            setSubmitting(true);
            setError(null);
            try {
                await onAddTaskComment(task, body);
                setDraft('');
            }
            catch (err) {
                setError(err.message || 'Unable to post comment.');
            }
            finally {
                setSubmitting(false);
            }
        }}>
        <textarea className="task-launch-field task-launch-textarea" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={COMPOSER_PLACEHOLDER} disabled={submitting}/>
        <div className="task-detail-comments-actions">
          <span className="task-detail-comments-hint">
            Markdown supported. Use a slash command on its own line to auto-transition status.
          </span>
          <button type="submit" className="task-launch-button" disabled={submitting || !draft.trim()}>
            {submitting ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </form>

      {error ? <div className="task-detail-brief-feedback">{error}</div> : null}

      {reverseChronological.length === 0 ? (<div className="task-detail-comments-empty">
          No comments yet. The first one starts the audit trail.
        </div>) : (<ul className="task-detail-comments-list">
          {reverseChronological.map((comment) => (<li key={comment.id} className="task-detail-comments-row">
              <header className="task-detail-comments-row-head">
                <div>
                  <strong>{comment.authorId || comment.authorKind}</strong>
                  <span>{formatRelativeTimestamp(comment.createdAt)}</span>
                </div>
                <span className={`task-detail-comment-state tone-${commentStates[comment.id]?.tone || 'yellow'}`}>
                  {commentStates[comment.id]?.label || 'Pending'}
                </span>
              </header>
              {commentStates[comment.id]?.detail ? (<div className="task-detail-comment-state-detail">
                  {commentStates[comment.id].detail}
                </div>) : null}
              <MarkdownView source={comment.body} compact/>
            </li>))}
        </ul>)}
    </section>);
}
export function buildCommentProcessingStates(comments = [], timeline) {
    return comments.reduce((states, comment) => {
        const subsequentItems = timeline.filter((item) => (item.createdAt > comment.createdAt && !isCommentTimelineItem(item)));
        const hasQueuedFollowUp = subsequentItems.some((item) => (item.body.includes('Task state changed: completed -> todo')
            || item.body.includes('Human comment requested a follow-up run.')));
        const hasProcessedEvidence = subsequentItems.some((item) => (item.kind === 'raw'
            || item.body.includes('Task entered the supervisor queue.')
            || item.body.includes('Supervisor opened a new execution session.')
            || item.body.includes('Supervisor resumed task execution.')
            || item.body.includes('Task completed and the latest outputs are ready for review.')));
        const hasErrorEvidence = subsequentItems.some((item) => (item.kind === 'raw' && item.body.includes('\nError:\n')));
        const requiresMergeEvidence = isMergeRequestComment(comment.body);
        const hasMergeEvidence = subsequentItems.some((item) => hasMergeCompletionEvidence(item.body));
        if (hasQueuedFollowUp && !hasProcessedEvidence) {
            states[comment.id] = {
                tone: 'yellow',
                label: 'Queued',
                detail: 'This comment reopened the task and is waiting for the tracker daemon to run it.',
            };
            return states;
        }
        if (!hasProcessedEvidence) {
            states[comment.id] = {
                tone: 'yellow',
                label: 'Pending',
                detail: 'No execution evidence has been recorded after this comment yet.',
            };
            return states;
        }
        if (hasErrorEvidence) {
            states[comment.id] = {
                tone: 'red',
                label: 'Processed with errors',
                detail: 'A later run consumed this comment, but tool errors were recorded afterward.',
            };
            return states;
        }
        if (requiresMergeEvidence && !hasMergeEvidence) {
            states[comment.id] = {
                tone: 'yellow',
                label: 'Needs merge evidence',
                detail: 'A later run recorded execution evidence, but no commit, MR, or merge evidence was found after this comment.',
            };
            return states;
        }
        states[comment.id] = {
            tone: 'green',
            label: 'Processed',
            detail: 'A later run recorded execution evidence after this comment.',
        };
        return states;
    }, {});
}
function isMergeRequestComment(body) {
    const normalized = body.toLowerCase();
    return ((normalized.includes('merge') || normalized.includes('合并'))
        && (normalized.includes('mr')
            || normalized.includes('pull request')
            || normalized.includes('pr')
            || normalized.includes('master')
            || normalized.includes('main')));
}
function hasMergeCompletionEvidence(body) {
    const normalized = body.toLowerCase();
    return (normalized.includes('merge made by')
        || normalized.includes('merge pull request')
        || normalized.includes('merged into')
        || normalized.includes('merged to')
        || normalized.includes('already up to date')
        || normalized.includes('fast-forward')
        || normalized.includes('git merge')
        || normalized.includes('git commit')
        || normalized.includes('git push')
        || normalized.includes('pull request #')
        || normalized.includes('merge request')
        || normalized.includes('创建mr')
        || normalized.includes('已合并')
        || normalized.includes('合并到'));
}
function isCommentTimelineItem(item) {
    return item.actor === 'user' && item.body.startsWith('Comment added:\n');
}
function formatRelativeTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7)
        return `${days}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
//# sourceMappingURL=TaskCommentsBlock.js.map