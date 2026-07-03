import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus.js';
import { WorkbenchService, WorkbenchTaskError } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeService() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-agent-loop-workbench-'));
  tempDirs.push(root);
  const service = new WorkbenchService({
    rootPath: root,
    eventBus: new EventBus(),
    store: new WorkbenchStore(root),
  });
  return { root, service };
}

const changeRequestRef = {
  scm: 'gitlab' as const,
  repo: 'group/project',
  id: '456',
  type: 'merge_request' as const,
  url: 'https://gitlab.example.com/group/project/-/merge_requests/456',
  baseRef: 'main',
  headRef: 'agent/TASK-123-codex',
  headSha: 'abc123',
};

const workspaceBinding = {
  workspaceRoot: '/workspace',
  workspaceName: 'tik',
  projectName: 'tik',
  sourceProjectPath: '/workspace/tik',
  effectiveProjectPath: '/workspace/tik',
  laneId: 'review',
  worktreeKind: 'git-worktree' as const,
  worktreePath: '/workspace/.workspace/worktrees/tik--review',
};

describe('WorkbenchService agent loop work items', () => {
  it('creates review rounds idempotently by idempotencyKey', async () => {
    const { service } = await makeService();

    const first = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'claude_review:gitlab:group/project:456:abc123:r1',
    });
    const second = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'claude_review:gitlab:group/project:456:abc123:r1',
    });

    expect(second.id).toBe(first.id);
    expect(await service.listTasks()).toHaveLength(1);
    expect(first).toMatchObject({
      status: 'todo',
      agentLoop: {
        kind: 'claude_review',
        rootTaskId: 'TASK-123',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'claude_review:gitlab:group/project:456:abc123:r1',
        changeRequest: changeRequestRef,
      },
    });
    expect(first.labels).toEqual(['agent-loop', 'claude-review', 'needs-claude-review']);
  });

  it('requests review on an existing root task instead of creating a child work item', async () => {
    const { service } = await makeService();
    const rootTask = await service.createTask({
      title: 'Implement feature',
      goal: 'Ship the feature and request review.',
      status: 'completed',
      labels: ['feature'],
    }, 'TASK-123');

    const reviewTask = await service.createReviewRound({
      rootTaskId: rootTask.id,
      round: 2,
      maxRounds: 3,
      changeRequest: {
        ...changeRequestRef,
        headSha: 'def456',
      },
      idempotencyKey: 'review-existing-root',
    });

    expect(reviewTask.id).toBe(rootTask.id);
    expect(await service.listTasks()).toHaveLength(1);
    expect(reviewTask).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'claude-review', 'feature', 'needs-claude-review'],
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        round: 2,
        headSha: 'def456',
      },
    });
  });

  it('keeps worktree binding on review rounds and follow-up fix phases', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-with-binding',
      workspaceBinding,
    });

    expect(reviewTask.workspaceBinding).toEqual(workspaceBinding);

    const completed = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing regression coverage',
        file: 'packages/kernel/src/workbench/workbench-service.ts',
        reason: 'The new loop path needs a focused test.',
      }],
      nonBlockingSuggestions: [],
      testsNeeded: ['Add binding propagation regression test.'],
      markdown: 'Binding regression found.',
    });

    expect(completed.task.id).toBe(reviewTask.id);
    expect(completed.task.agentLoop?.kind).toBe('codex_fix');
    expect(completed.task.workspaceBinding).toEqual(workspaceBinding);
  });

  it('preserves caller labels across external review and fix phases', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-external-owner',
      labels: ['external-claude-review'],
    });

    expect(reviewTask.labels).toEqual([
      'agent-loop',
      'claude-review',
      'external-claude-review',
      'needs-claude-review',
    ]);

    const completed = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing regression coverage',
        file: 'packages/kernel/src/workbench/workbench-service.ts',
        reason: 'The caller-owned loop must not lose its owner label.',
      }],
      markdown: 'External review loop should stay externally owned.',
    });

    expect(completed.task.labels).toEqual([
      'agent-loop',
      'codex-fix',
      'external-claude-review',
      'needs-codex-fix',
    ]);
  });

  it('does not reroute a review task after Claude already submitted ReviewResult JSON', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-result-before-runtime-completion',
      labels: ['external-claude-review'],
    });

    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing regression coverage',
        file: 'packages/kernel/src/workbench/workbench-service.ts',
        reason: 'The structured ReviewResult must remain authoritative.',
      }],
      markdown: 'Structured review result found a blocker.',
    });

    const afterRuntime = await service.advanceReviewLoopAfterRuntime(reviewTask.id, {
      runner: 'claude-code',
      status: 'completed',
      stdout: 'No blocking findings. Ready for human review.',
      runId: 'claude-run-1',
    });

    expect(afterRuntime?.status).toBe('todo');
    expect(afterRuntime?.labels).toEqual([
      'agent-loop',
      'codex-fix',
      'external-claude-review',
      'needs-codex-fix',
    ]);
    expect(afterRuntime?.agentLoop).toMatchObject({
      kind: 'codex_fix',
      phase: 'needs_codex_fix',
      reviewResult: {
        verdict: 'request_changes',
      },
    });
  });

  it('marks stale review tasks blocked and records expected and actual head shas', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-stale',
    });

    const stale = await service.markAgentLoopStale(reviewTask.id, {
      expectedHeadSha: 'abc123',
      actualHeadSha: 'def456',
    });

    expect(stale?.status).toBe('blocked');
    expect(stale?.agentLoop?.stale).toEqual({
      expectedHeadSha: 'abc123',
      actualHeadSha: 'def456',
    });
    const timeline = await service.readTimeline(reviewTask.id);
    expect(timeline.map((item) => item.body).join('\n')).toContain('expected head sha abc123');
    expect(timeline.map((item) => item.body).join('\n')).toContain('actual head sha def456');
  });

  it('moves the same task to codex fix when review returns blocking issues', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-blocking',
    });

    const completed = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing backwards compatibility',
        file: 'src/api/message.ts',
        line: 88,
        reason: 'The new required field breaks old callers.',
        suggestedFix: 'Keep the field optional.',
      }],
      nonBlockingSuggestions: [],
      testsNeeded: ['Add request-without-store test.'],
      markdown: '## Blocking Issues\n\nMissing backwards compatibility.',
    });

    expect(completed.reviewTask.status).toBe('todo');
    expect(completed.task).toMatchObject({
      id: reviewTask.id,
      status: 'todo',
      agentLoop: {
        kind: 'codex_fix',
        phase: 'needs_codex_fix',
        rootTaskId: 'TASK-123',
        round: 1,
        nextReviewRound: 2,
        headSha: 'abc123',
        previousHeadSha: 'abc123',
        blockingIssues: [
          expect.objectContaining({ title: 'Missing backwards compatibility' }),
        ],
      },
    });
    expect(completed.task.labels).toEqual(['agent-loop', 'codex-fix', 'needs-codex-fix']);
    expect(completed.task.comments?.at(-1)?.body).toContain('"nextPhase": "needs_codex_fix"');
    expect(await service.listTasks()).toHaveLength(1);
  });

  it('returns the same task to Claude review for the next round after a Codex fix', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-next-round',
    });
    const fixNeeded = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing backwards compatibility',
        file: 'src/api/message.ts',
        reason: 'The new required field breaks old callers.',
      }],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Fix needed.',
    });

    const nextReview = await service.createReviewRound({
      rootTaskId: fixNeeded.task.id,
      round: 1,
      maxRounds: 3,
      changeRequest: {
        ...changeRequestRef,
        headSha: 'def456',
      },
      idempotencyKey: 'review-next-round:def456',
    });

    expect(nextReview.id).toBe(reviewTask.id);
    expect(nextReview).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'claude-review', 'needs-claude-review'],
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        round: 2,
        headSha: 'def456',
      },
    });
    expect(await service.listTasks()).toHaveLength(1);
    expect(nextReview.agentLoop?.reviewResult).toBeUndefined();
    expect(nextReview.agentLoop?.blockingIssues).toBeUndefined();
    expect(nextReview.agentLoop?.previousHeadSha).toBeUndefined();
    expect(nextReview.agentLoop?.nextReviewRound).toBeUndefined();
    expect(nextReview.agentLoop?.stale).toBeUndefined();
  });

  it('clears stale metadata when a root task is reused for a fresh Claude review', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-stale-reset',
    });
    await service.markAgentLoopStale(reviewTask.id, {
      expectedHeadSha: 'abc123',
      actualHeadSha: 'def456',
    });

    const freshReview = await service.createReviewRound({
      rootTaskId: reviewTask.id,
      round: 1,
      maxRounds: 3,
      changeRequest: {
        ...changeRequestRef,
        headSha: 'def456',
      },
      idempotencyKey: 'review-stale-reset:def456',
    });

    expect(freshReview.id).toBe(reviewTask.id);
    expect(freshReview).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'claude-review', 'needs-claude-review'],
      agentLoop: {
        kind: 'claude_review',
        phase: 'needs_claude_review',
        round: 1,
        headSha: 'def456',
      },
    });
    expect(freshReview.agentLoop?.stale).toBeUndefined();
    expect(freshReview.agentLoop?.reviewResult).toBeUndefined();
    expect(freshReview.agentLoop?.blockingIssues).toBeUndefined();
  });

  it('moves the same task to human review when review has no blocking issues', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-clean',
    });

    const completed = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });

    expect(completed.task).toMatchObject({
      id: reviewTask.id,
      status: 'in_review',
      agentLoop: {
        kind: 'human_review',
        phase: 'needs_human_review',
        rootTaskId: 'TASK-123',
        round: 1,
        headSha: 'abc123',
      },
    });
    expect(completed.task.labels).toEqual(['agent-loop', 'human-review', 'needs-human-review']);
    expect(await service.listTasks()).toHaveLength(1);
  });

  it('lets a human approve the human review phase with /approve', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-human-approve',
    });
    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });

    const approved = await service.addComment(reviewTask.id, {
      authorKind: 'human',
      authorId: 'operator',
      body: '/approve',
    });

    expect(approved).toMatchObject({
      status: 'completed',
      labels: ['agent-loop', 'loop-complete'],
      agentLoop: {
        phase: 'complete',
      },
    });
    const timeline = await service.readTimeline(reviewTask.id);
    expect(timeline.map((item) => item.body).join('\n')).toContain('Human review approved');
  });

  it('archives a completed human review loop without reviving it to in_review', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-human-archive',
    });
    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });

    await service.addComment(reviewTask.id, {
      authorKind: 'human',
      authorId: 'operator',
      body: '/approve\nLooks good.',
    });

    const archived = await service.archiveTask(reviewTask.id);

    expect(archived?.status).toBe('archived');
    expect(archived?.agentLoop).toMatchObject({
      kind: 'human_review',
      phase: 'complete',
    });
    expect(archived?.labels).toEqual(['agent-loop', 'loop-complete']);
    const stored = await service.readTask(reviewTask.id);
    expect(stored?.status).toBe('archived');
    const timeline = await service.readTimeline(reviewTask.id);
    expect(timeline.map((item) => item.body).join('\n')).toContain('Task archived from the active work queue.');
  });

  it('lets a human archive the human review phase and records approval first', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-human-direct-archive',
    });
    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });

    const archived = await service.archiveTask(reviewTask.id);

    expect(archived?.status).toBe('archived');
    expect(archived?.agentLoop).toMatchObject({
      kind: 'human_review',
      phase: 'complete',
    });
    expect(archived?.latestSummary).toBe('Human review approved and archived from the active work queue.');
    const timeline = await service.readTimeline(reviewTask.id);
    expect(timeline.map((item) => item.body).join('\n')).toContain('Human review approved before archive.');
    expect(timeline.map((item) => item.body).join('\n')).toContain('Human review approved and archived from the active work queue.');
  });

  it('rejects direct archive for human review metadata outside the explicit human review phase', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-human-undefined-phase-archive',
    });
    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });

    await service.addComment(reviewTask.id, {
      authorKind: 'human',
      authorId: 'operator',
      body: '/approve\nApproved.',
    });
    await service.updateTaskTrackerMetadata(reviewTask.id, { status: 'in_review' });

    await expect(service.archiveTask(reviewTask.id)).rejects.toThrow('cannot be archived from status in_review');

    const stored = await service.readTask(reviewTask.id);
    expect(stored).toMatchObject({
      status: 'in_review',
      agentLoop: {
        phase: 'complete',
      },
    });
  });

  it('rejects direct archive when human review metadata has no explicit phase', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-human-missing-phase-archive',
    });
    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });
    await service.updateTaskTrackerMetadata(reviewTask.id, { status: 'completed' });
    await service.updateTaskTrackerMetadata(reviewTask.id, {
      status: 'in_review',
      labels: ['agent-loop', 'human-review'],
    });

    const stored = await service.readTask(reviewTask.id);
    delete stored!.agentLoop!.phase;
    await (service as unknown as { store: { upsertTask: (task: unknown) => Promise<void> } }).store.upsertTask(stored);

    await expect(service.archiveTask(reviewTask.id)).rejects.toThrow('cannot be archived from status in_review');
  });

  it('lets a human request another Codex pass from human review with /retry', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-human-retry',
    });
    await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Ready for human review.',
    });

    const retry = await service.addComment(reviewTask.id, {
      authorKind: 'human',
      authorId: 'operator',
      body: '/retry\nPlease address the deployment note first.',
    });

    expect(retry).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'codex-fix', 'needs-codex-fix'],
      agentLoop: {
        kind: 'codex_fix',
        phase: 'needs_codex_fix',
      },
    });
  });

  it('lets a human retry a blocked Codex fix phase without changing loop ownership', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-blocked-codex-retry',
    });
    const completed = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Missing retry path',
        file: 'packages/kernel/src/workbench/workbench-service.ts',
        reason: 'Blocked fix phases need an explicit human retry command.',
      }],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Please add a retry path.',
    });
    await service.transitionTask(completed.task.id, 'blocked', {
      actor: 'daemon',
      reason: 'Runtime failed and should wait for explicit retry.',
    });

    const retry = await service.addComment(completed.task.id, {
      authorKind: 'human',
      authorId: 'operator',
      body: '/retry\nThe runner is fixed; retry the Codex pass.',
    });

    expect(retry).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'codex-fix', 'needs-codex-fix'],
      agentLoop: {
        kind: 'codex_fix',
        phase: 'needs_codex_fix',
      },
    });
    const timeline = await service.readTimeline(completed.task.id);
    expect(timeline.map((item) => item.body).join('\n')).toContain('Human requested retry for blocked agent loop phase needs_codex_fix.');
  });

  it('escalates the same task to human review instead of another fix after max rounds', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 3,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-max-rounds',
    });

    const completed = await service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'request_changes',
      headShaReviewed: 'abc123',
      blockingIssues: [{
        title: 'Still broken',
        file: 'src/api/message.ts',
        reason: 'The same blocking issue remains.',
        suggestedFix: 'Escalate to a human.',
      }],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Still blocked.',
    });

    expect(completed.task).toMatchObject({
      id: reviewTask.id,
      status: 'in_review',
      agentLoop: {
        kind: 'human_review',
        phase: 'needs_human_review',
        round: 3,
        headSha: 'abc123',
      },
    });
    expect(completed.task.agentLoop?.blockingIssues).toEqual([
      expect.objectContaining({ title: 'Still broken' }),
    ]);
    expect(await service.listTasks()).toHaveLength(1);
  });

  it('rejects approve review results that do not match the task head sha', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-mismatch',
    });

    await expect(service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'def456',
      blockingIssues: [],
      nonBlockingSuggestions: [],
      testsNeeded: [],
      markdown: 'Reviewed another sha.',
    })).rejects.toMatchObject({
      code: 'head_sha_mismatch',
    } satisfies Partial<WorkbenchTaskError>);
  });

  it('rejects final-review coverage fields on subtask review results', async () => {
    const { service } = await makeService();
    const reviewTask = await service.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      changeRequest: changeRequestRef,
      idempotencyKey: 'review-subtask-with-final-coverage',
    });

    await expect(service.completeAgentLoopReview(reviewTask.id, {
      verdict: 'approve',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      subtaskCoverage: [{
        subtaskId: 'st-api',
        status: 'covered',
      }],
      markdown: 'Subtask review accidentally used final schema.',
    })).rejects.toMatchObject({
      code: 'invalid_review_result',
      message: expect.stringContaining('must not include'),
    } satisfies Partial<WorkbenchTaskError>);
  });

  it('requires subtaskCoverage on final Claude review results', async () => {
    const { service } = await makeService();
    const finalReviewTask = await service.createReviewRound({
      rootTaskId: 'wf-123',
      round: 1,
      maxRounds: 1,
      changeRequest: changeRequestRef,
      idempotencyKey: 'multi_agent_final_claude_review:group/project:wf-123:abc123',
      labels: ['external-claude-review', 'final-claude-review'],
    });

    await expect(service.completeAgentLoopReview(finalReviewTask.id, {
      verdict: 'approve',
      workflowId: 'wf-123',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      markdown: 'Final review without coverage.',
    })).rejects.toMatchObject({
      code: 'invalid_review_result',
      message: expect.stringContaining('subtaskCoverage'),
    } satisfies Partial<WorkbenchTaskError>);

    const completed = await service.completeAgentLoopReview(finalReviewTask.id, {
      verdict: 'approve',
      workflowId: 'wf-123',
      headShaReviewed: 'abc123',
      blockingIssues: [],
      subtaskCoverage: [{
        subtaskId: 'st-api',
        status: 'covered',
        notes: 'Evidence satisfies acceptance criteria.',
      }],
      markdown: 'Final review approved.',
    });

    expect(completed.task.agentLoop?.reviewResult).toMatchObject({
      workflowId: 'wf-123',
      subtaskCoverage: [{
        subtaskId: 'st-api',
        status: 'covered',
      }],
    });
  });
});
