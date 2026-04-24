import { describe, expect, it } from 'vitest';
import {
  applyTaskAdjustmentPreset,
  buildWorkbenchAcceptanceSummary,
  buildWorkbenchEvidenceDigest,
  buildWorkbenchLiveRunEntries,
  buildWorkbenchOperatorNoteSummary,
  buildWorkbenchQueueSignal,
  buildWorkbenchSteeringUpdateInput,
  buildWorkbenchTaskVisibleSummary,
  buildTimelineFeedMetrics,
  buildWorkbenchOverview,
  buildTaskAdjustmentPreview,
  buildWorkbenchFocusSummary,
  buildTimelineGroups,
  buildWorkbenchWorkspaceBindingSummary,
  filterStaleTimelineGroupsForTask,
  filterTimelineGroupsByLens,
  filterWorkbenchTasksByQuery,
  filterWorkbenchTasksByLens,
  filterVisibleWorkbenchTasks,
  getDefaultWorkbenchFeedLens,
  getLatestPreviewableArtifact,
  getNextActiveWorkbenchTaskId,
  groupWorkbenchTasks,
  normalizeWorkbenchSummaryText,
  parseWorkbenchEvidence,
  resolveWorkbenchLane,
  shouldLaunchWorkbenchFollowUp,
  sortWorkbenchTasks,
  type WorkbenchTaskSummary,
} from './workbench.js';

describe('workbench view models', () => {
  it('sorts tasks by last progress time before created time', () => {
    const tasks: WorkbenchTaskSummary[] = [
      { id: 'a', title: 'older', status: 'running', latestSummary: 'old', lastProgressAt: '2026-04-09T00:00:00.000Z' },
      { id: 'b', title: 'newer', status: 'running', latestSummary: 'new', lastProgressAt: '2026-04-09T01:00:00.000Z' },
    ];

    expect(sortWorkbenchTasks(tasks).map((task) => task.id)).toEqual(['b', 'a']);
  });

  it('launches a follow-up steering pass for terminal tasks', () => {
    expect(shouldLaunchWorkbenchFollowUp('completed')).toBe(true);
    expect(shouldLaunchWorkbenchFollowUp('failed')).toBe(true);
    expect(shouldLaunchWorkbenchFollowUp('running')).toBe(false);

    expect(buildWorkbenchSteeringUpdateInput({
      id: 'task-terminal',
      title: 'Snake polish',
      goal: 'Ship a cartoon pass',
      status: 'completed',
    }, {
      adjustment: 'Add more animation and acceptance evidence.',
    })).toEqual({
      title: 'Snake polish',
      goal: 'Ship a cartoon pass',
      adjustment: 'Add more animation and acceptance evidence.',
      launchFollowUp: true,
    });
  });

  it('keeps summary items inline but nests raw evidence beneath them', () => {
    const groups = buildTimelineGroups([
      { id: '1', kind: 'summary', actor: 'supervisor', body: 'Did work', createdAt: '2026-04-09T00:00:00.000Z', evidenceIds: ['ev-1'] },
      { id: '2', kind: 'raw', actor: 'coder', body: 'npm test', createdAt: '2026-04-09T00:00:01.000Z' },
    ]);

    expect(groups[0]?.summary.id).toBe('1');
    expect(groups[0]?.rawItems).toHaveLength(1);
  });

  it('normalizes legacy supervisor event summaries and hides low-signal noise from the feed', () => {
    expect(normalizeWorkbenchSummaryText('Supervisor observed event task.completed.'))
      .toBe('Task completed and the latest outputs are ready for review.');
    expect(normalizeWorkbenchSummaryText('Supervisor observed event session.usage.')).toBeNull();

    const groups = buildTimelineGroups([
      { id: 'noise', kind: 'summary', actor: 'supervisor', body: 'Supervisor observed event session.usage.', createdAt: '2026-04-09T00:00:00.000Z' },
      { id: 'kept', kind: 'summary', actor: 'supervisor', body: 'Supervisor observed event task.completed.', createdAt: '2026-04-09T00:00:01.000Z' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.summary.body).toBe('Task completed and the latest outputs are ready for review.');
  });

  it('filters activity feed groups for operator, agents, evidence, and decisions', () => {
    const groups = buildTimelineGroups([
      { id: 'summary-1', kind: 'summary', actor: 'user', body: 'Operator adjusted the brief', createdAt: '2026-04-09T00:00:00.000Z' },
      { id: 'summary-2', kind: 'summary', actor: 'supervisor', body: 'Supervisor executed the next pass', createdAt: '2026-04-09T00:00:01.000Z' },
      { id: 'raw-2', kind: 'raw', actor: 'system', body: 'Tool: write_file', createdAt: '2026-04-09T00:00:02.000Z' },
      { id: 'decision-1', kind: 'decision', actor: 'supervisor', body: 'Need approval', createdAt: '2026-04-09T00:00:03.000Z' },
    ]);

    expect(filterTimelineGroupsByLens(groups, 'operator').map((group) => group.summary.id)).toEqual(['summary-1']);
    expect(filterTimelineGroupsByLens(groups, 'agents').map((group) => group.summary.id)).toEqual(['summary-2']);
    expect(filterTimelineGroupsByLens(groups, 'evidence').map((group) => group.summary.id)).toEqual(['summary-2']);
    expect(filterTimelineGroupsByLens(groups, 'decisions').map((group) => group.summary.id)).toEqual(['decision-1']);
    expect(buildTimelineFeedMetrics(groups)).toEqual({
      allCount: 3,
      operatorCount: 1,
      agentCount: 1,
      evidenceCount: 1,
      decisionCount: 1,
    });
  });

  it('hides stale terminal timeline groups when the task is still active later', () => {
    const groups = buildTimelineGroups([
      { id: 'summary-1', kind: 'summary', actor: 'supervisor', body: 'Task entered the supervisor queue.', createdAt: '2026-04-09T00:00:00.000Z' },
      { id: 'summary-2', kind: 'summary', actor: 'supervisor', body: 'Operator stopped the task before completion.', createdAt: '2026-04-09T00:00:01.000Z' },
      { id: 'summary-3', kind: 'summary', actor: 'user', body: 'Task archived from the active work queue.', createdAt: '2026-04-09T00:00:02.000Z' },
      { id: 'summary-4', kind: 'summary', actor: 'supervisor', body: 'Supervisor is preparing a shell action that may need approval.', createdAt: '2026-04-09T00:00:03.000Z' },
      { id: 'decision-1', kind: 'decision', actor: 'supervisor', body: 'Need approval', createdAt: '2026-04-09T00:00:04.000Z' },
    ]);

    expect(filterStaleTimelineGroupsForTask(groups, 'waiting_for_user').map((group) => group.summary.id)).toEqual([
      'summary-1',
      'summary-4',
      'decision-1',
    ]);
    expect(filterStaleTimelineGroupsForTask(groups, 'archived').map((group) => group.summary.id)).toEqual([
      'summary-1',
      'summary-2',
      'summary-3',
      'summary-4',
      'decision-1',
    ]);
  });

  it('hides archived tasks by default but keeps them when explicitly requested', () => {
    const tasks: WorkbenchTaskSummary[] = [
      { id: 'active', title: 'active', status: 'completed', latestSummary: 'done', lastProgressAt: '2026-04-09T01:00:00.000Z' },
      { id: 'archived', title: 'archived', status: 'archived', latestSummary: 'old', lastProgressAt: '2026-04-09T02:00:00.000Z' },
    ];

    expect(filterVisibleWorkbenchTasks(tasks).map((task) => task.id)).toEqual(['active']);
    expect(filterVisibleWorkbenchTasks(tasks, { showArchived: true }).map((task) => task.id)).toEqual(['active', 'archived']);
  });

  it('extracts previewable artifact information from raw write_file evidence', () => {
    const parsed = parseWorkbenchEvidence({
      id: 'raw-1',
      kind: 'raw',
      actor: 'system',
      body: [
        'Tool: write_file',
        '',
        'Files modified:',
        '- /Users/huyuehui/ace/tik/src/mock-app.html',
        '',
        'Output:',
        'Written 8360 bytes',
      ].join('\n'),
      createdAt: '2026-04-09T00:00:00.000Z',
    });

    expect(parsed.toolName).toBe('write_file');
    expect(parsed.filesModified).toEqual(['/Users/huyuehui/ace/tik/src/mock-app.html']);
    expect(parsed.previewableArtifacts).toEqual(['/Users/huyuehui/ace/tik/src/mock-app.html']);
    expect(parsed.output).toContain('Written 8360 bytes');
  });

  it('builds an evidence digest with newest artifacts, tools, and latest output excerpts', () => {
    const digest = buildWorkbenchEvidenceDigest([
      {
        id: 'raw-older',
        kind: 'raw',
        actor: 'system',
        body: [
          'Tool: write_file',
          '',
          'Files modified:',
          '- /Users/huyuehui/ace/tik/src/older.html',
          '',
          'Output:',
          'Written 12 bytes',
        ].join('\n'),
        createdAt: '2026-04-09T01:00:00.000Z',
      },
      {
        id: 'raw-newer',
        kind: 'raw',
        actor: 'system',
        body: [
          'Tool: frontend_browser_screenshot',
          '',
          'Files modified:',
          '- /Users/huyuehui/ace/tik/.tik-artifacts/hero.png',
          '- /Users/huyuehui/ace/tik/src/newer.html',
          '',
          'Output:',
          'Captured a fresh browser screenshot for review',
        ].join('\n'),
        createdAt: '2026-04-09T02:00:00.000Z',
      },
    ]);

    expect(digest.rawEventCount).toBe(2);
    expect(digest.artifactCount).toBe(2);
    expect(digest.modifiedFileCount).toBe(3);
    expect(digest.toolNames).toEqual(['frontend_browser_screenshot', 'write_file']);
    expect(digest.previewableArtifacts[0]).toMatchObject({
      path: '/Users/huyuehui/ace/tik/src/newer.html',
      toolName: 'frontend_browser_screenshot',
    });
    expect(digest.latestOutputExcerpt).toContain('Captured a fresh browser screenshot');
    expect(digest.modifiedFiles[0]).toBe('/Users/huyuehui/ace/tik/.tik-artifacts/hero.png');
  });

  it('derives acceptance summaries from task state and evidence density', () => {
    const readyDigest = buildWorkbenchEvidenceDigest([
      {
        id: 'raw-newer',
        kind: 'raw',
        actor: 'system',
        body: 'Tool: write_file\n\nFiles modified:\n- /Users/huyuehui/ace/tik/src/newer.html\n\nOutput:\nWritten 24 bytes',
        createdAt: '2026-04-09T02:00:00.000Z',
      },
    ]);
    const emptyDigest = buildWorkbenchEvidenceDigest([]);

    expect(buildWorkbenchAcceptanceSummary('completed', readyDigest)).toEqual({
      tone: 'green',
      headline: 'Artifact ready for acceptance',
      detail: 'The task completed and left a previewable artifact in the workbench. Open it, review the evidence, then archive when satisfied.',
    });
    expect(buildWorkbenchAcceptanceSummary('waiting_for_user', emptyDigest, 1)).toEqual({
      tone: 'yellow',
      headline: 'Operator review required',
      detail: 'The task is paused for a decision, but no previewable artifact is attached yet. Inspect the latest evidence before approving.',
    });
  });

  it('derives queue card signals from task state and evidence summaries', () => {
    expect(buildWorkbenchQueueSignal({
      status: 'completed',
      evidenceSummary: {
        rawEventCount: 2,
        modifiedFileCount: 3,
        previewableArtifactCount: 1,
        latestPreviewableArtifactPath: '/Users/huyuehui/ace/tik/src/mock-app.html',
        latestToolName: 'write_file',
        hasErrorEvidence: false,
      },
    })).toEqual({
      tone: 'green',
      label: 'Artifact ready',
      detail: '1 artifact ready for acceptance · 3 files touched',
    });

    expect(buildWorkbenchQueueSignal({
      status: 'archived',
      evidenceSummary: {
        rawEventCount: 1,
        modifiedFileCount: 2,
        previewableArtifactCount: 1,
        latestPreviewableArtifactPath: '/Users/huyuehui/ace/tik/src/mock-app.html',
        latestToolName: 'write_file',
        hasErrorEvidence: false,
      },
    })).toEqual({
      tone: 'green',
      label: 'Accepted',
      detail: 'Archived after 1 artifact review · 2 files touched',
    });

    expect(buildWorkbenchQueueSignal({
      status: 'waiting_for_user',
      waitingReason: 'Need approval',
      evidenceSummary: {
        rawEventCount: 0,
        modifiedFileCount: 0,
        previewableArtifactCount: 0,
        latestToolName: undefined,
        hasErrorEvidence: false,
      },
    })).toEqual({
      tone: 'yellow',
      label: 'Decision pending',
      detail: 'Need approval',
    });
  });

  it('surfaces the latest operator note ahead of stale waiting summaries', () => {
    const task: WorkbenchTaskSummary & { goal: string; waitingReason: string } = {
      id: 'task-note',
      title: 'Snake polish',
      status: 'waiting_for_user',
      goal: 'Ship a reviewable cartoon snake build',
      waitingReason: 'Waiting for approval before bash.',
      latestSummary: 'Waiting for operator approval before bash.',
      lastAdjustment: {
        previousTitle: 'Snake polish',
        previousGoal: 'Ship a reviewable snake build',
        nextTitle: 'Snake polish',
        nextGoal: 'Ship a reviewable cartoon snake build',
        note: '卡通化实现，并把最新产物挂到任务卡上。',
        appliedAt: '2026-04-13T12:44:33.298Z',
      },
    };

    expect(buildWorkbenchOperatorNoteSummary(task)).toBe('Operator note: 卡通化实现，并把最新产物挂到任务卡上。');
    expect(buildWorkbenchTaskVisibleSummary(task)).toBe('Operator note: 卡通化实现，并把最新产物挂到任务卡上。');
  });

  it('builds a compact live run log from summaries, decisions, and tool evidence', () => {
    const entries = buildWorkbenchLiveRunEntries([
      {
        id: 'summary-1',
        kind: 'summary',
        actor: 'supervisor',
        body: 'Supervisor observed event task.resumed.',
        createdAt: '2026-04-13T12:00:00.000Z',
      },
      {
        id: 'raw-1',
        kind: 'raw',
        actor: 'system',
        body: [
          'Tool: bash',
          '',
          'Files modified:',
          '- /Users/huyuehui/ace/tik/src/app.tsx',
          '',
          'Error:',
          'Timed out waiting for workbench decision.',
        ].join('\n'),
        createdAt: '2026-04-13T12:00:01.000Z',
      },
      {
        id: 'decision-1',
        kind: 'decision',
        actor: 'supervisor',
        body: 'Supervisor paused before a high-risk tool invocation.',
        createdAt: '2026-04-13T12:00:02.000Z',
      },
      {
        id: 'summary-2',
        kind: 'summary',
        actor: 'user',
        body: 'Adjusted task brief.\n\nAdjustment note:\nPush for a preview artifact first.',
        createdAt: '2026-04-13T12:00:03.000Z',
      },
    ]);

    expect(entries).toEqual([
      {
        id: 'summary-1',
        createdAt: '2026-04-13T12:00:00.000Z',
        tone: 'blue',
        label: 'Supervisor',
        text: 'Supervisor resumed task execution.',
      },
      {
        id: 'raw-1',
        createdAt: '2026-04-13T12:00:01.000Z',
        tone: 'red',
        label: '$ bash',
        text: 'Timed out waiting for workbench decision.',
        detail: '.../ace/tik/src/app.tsx',
      },
      {
        id: 'decision-1',
        createdAt: '2026-04-13T12:00:02.000Z',
        tone: 'yellow',
        label: 'Decision',
        text: 'Supervisor paused before a high-risk tool invocation.',
      },
      {
        id: 'summary-2',
        createdAt: '2026-04-13T12:00:03.000Z',
        tone: 'green',
        label: 'Operator',
        text: 'Adjusted task brief. Adjustment note: Push for a preview artifact first.',
      },
    ]);
  });

  it('picks the nearest visible task after archiving the current one instead of jumping to an arbitrary task', () => {
    const tasks: WorkbenchTaskSummary[] = [
      { id: 'older', title: 'older', status: 'completed', latestSummary: 'older', lastProgressAt: '2026-04-09T01:00:00.000Z' },
      { id: 'current', title: 'current', status: 'completed', latestSummary: 'current', lastProgressAt: '2026-04-09T03:00:00.000Z' },
      { id: 'newest', title: 'newest', status: 'completed', latestSummary: 'newest', lastProgressAt: '2026-04-09T04:00:00.000Z' },
      { id: 'hidden', title: 'hidden', status: 'archived', latestSummary: 'hidden', lastProgressAt: '2026-04-09T05:00:00.000Z' },
    ];

    expect(getNextActiveWorkbenchTaskId(tasks, 'current')).toBe('older');
    expect(getNextActiveWorkbenchTaskId(tasks, 'newest')).toBe('current');
    expect(getNextActiveWorkbenchTaskId(tasks, 'missing')).toBe('newest');
  });

  it('builds workbench overview metrics and grouped queues for the cockpit header and sidebar', () => {
    const tasks: WorkbenchTaskSummary[] = [
      { id: 'attention', title: 'attention', status: 'waiting_for_user', latestSummary: 'needs approval', lastProgressAt: '2026-04-09T05:00:00.000Z' },
      { id: 'cancelled', title: 'cancelled', status: 'cancelled', latestSummary: 'stopped', lastProgressAt: '2026-04-09T04:30:00.000Z' },
      { id: 'running', title: 'running', status: 'running', latestSummary: 'in flight', lastProgressAt: '2026-04-09T04:00:00.000Z' },
      { id: 'paused', title: 'paused', status: 'paused', latestSummary: 'paused', lastProgressAt: '2026-04-09T03:00:00.000Z' },
      { id: 'done', title: 'done', status: 'completed', latestSummary: 'done', lastProgressAt: '2026-04-09T02:00:00.000Z' },
      { id: 'old', title: 'old', status: 'archived', latestSummary: 'old', lastProgressAt: '2026-04-09T01:00:00.000Z' },
    ];

    expect(buildWorkbenchOverview(tasks)).toEqual({
      totalTasks: 6,
      attentionCount: 2,
      activeCount: 1,
      backlogCount: 1,
      completedCount: 1,
      archivedCount: 1,
    });

    const groups = groupWorkbenchTasks(tasks);
    expect(groups.attention.map((task) => task.id)).toEqual(['attention', 'cancelled']);
    expect(groups.active.map((task) => task.id)).toEqual(['running']);
    expect(groups.backlog.map((task) => task.id)).toEqual(['paused']);
    expect(groups.completed.map((task) => task.id)).toEqual(['done']);
    expect(groups.archived.map((task) => task.id)).toEqual(['old']);
  });

  it('filters tasks by inbox/today/completed lenses and builds a focus summary', () => {
    const tasks: WorkbenchTaskSummary[] = [
      {
        id: 'inbox',
        title: 'Needs approval',
        status: 'waiting_for_user',
        latestSummary: 'awaiting decision',
        lastProgressAt: '2026-04-09T05:00:00.000Z',
        updatedAt: '2026-04-09T05:00:00.000Z',
      },
      {
        id: 'today-running',
        title: 'Running today',
        status: 'running',
        latestSummary: 'in flight',
        lastProgressAt: '2026-04-09T04:00:00.000Z',
        updatedAt: '2026-04-09T04:00:00.000Z',
      },
      {
        id: 'done',
        title: 'Done today',
        status: 'completed',
        latestSummary: 'done',
        lastProgressAt: '2026-04-09T03:00:00.000Z',
        updatedAt: '2026-04-09T03:00:00.000Z',
      },
      {
        id: 'old',
        title: 'Old archived',
        status: 'archived',
        latestSummary: 'old',
        lastProgressAt: '2026-04-08T03:00:00.000Z',
        updatedAt: '2026-04-08T03:00:00.000Z',
      },
    ];

    expect(filterWorkbenchTasksByLens(tasks, 'inbox', { now: new Date('2026-04-09T12:00:00.000Z') }).map((task) => task.id))
      .toEqual(['inbox']);
    expect(filterWorkbenchTasksByLens(tasks, 'today', { now: new Date('2026-04-09T12:00:00.000Z') }).map((task) => task.id))
      .toEqual(['inbox', 'today-running', 'done']);
    expect(filterWorkbenchTasksByLens(tasks, 'completed', { now: new Date('2026-04-09T12:00:00.000Z') }).map((task) => task.id))
      .toEqual(['done']);

    expect(buildWorkbenchFocusSummary(tasks, { now: new Date('2026-04-09T12:00:00.000Z') })).toEqual({
      lens: 'inbox',
      headline: 'Needs your attention',
      detail: '1 task need review or recovery. Start with Needs approval.',
      primaryTaskId: 'inbox',
    });

    expect(resolveWorkbenchLane(tasks, 'today', { now: new Date('2026-04-10T12:00:00.000Z') })).toEqual({
      lens: 'inbox',
      taskId: 'inbox',
    });
  });

  it('filters tasks by a local search query across title, summary, goal, owner, and waiting reason', () => {
    const tasks = [
      {
        id: 'task-a',
        title: 'Design console shell',
        status: 'running' as const,
        latestSummary: 'restyling the studio header',
        goal: 'Ship a control-console shell',
        currentOwner: 'coder',
      },
      {
        id: 'task-b',
        title: 'Recover failed task',
        status: 'waiting_for_user' as const,
        latestSummary: 'needs approval',
        waitingReason: 'Need signoff on retry path',
      },
    ];

    expect(filterWorkbenchTasksByQuery(tasks, 'console').map((task) => task.id)).toEqual(['task-a']);
    expect(filterWorkbenchTasksByQuery(tasks, 'signoff').map((task) => task.id)).toEqual(['task-b']);
    expect(filterWorkbenchTasksByQuery(tasks, '').map((task) => task.id)).toEqual(['task-a', 'task-b']);
  });

  it('builds workspace binding summaries for root-bound and lane-bound tasks', () => {
    expect(buildWorkbenchWorkspaceBindingSummary({
      workspaceRoot: '/Users/huyuehui/ace/tik',
      workspaceName: 'tik',
      effectiveProjectPath: '/Users/huyuehui/ace/tik',
      worktreeKind: 'root',
    })).toEqual({
      headline: 'tik',
      detail: 'Single-workspace root binding',
      pathLabel: '/Users/huyuehui/ace/tik',
      scopeLabel: 'Workspace root',
    });

    expect(buildWorkbenchWorkspaceBindingSummary({
      workspaceRoot: '/Users/huyuehui/ace',
      workspaceName: 'operations-suite',
      projectName: 'operations-web',
      sourceProjectPath: '/Users/huyuehui/ace/operations-web',
      effectiveProjectPath: '/Users/huyuehui/ace/.workspace/worktrees/operations-web--review',
      laneId: 'review',
      worktreeKind: 'git-worktree',
      worktreePath: '/Users/huyuehui/ace/.workspace/worktrees/operations-web--review',
    })).toEqual({
      headline: 'operations-web',
      detail: 'operations-suite · git-worktree',
      pathLabel: '.../ace/.workspace/worktrees/operations-web--review',
      scopeLabel: 'Lane · review',
    });
  });

  it('finds the newest previewable artifact from raw evidence items', () => {
    const latest = getLatestPreviewableArtifact([
      {
        id: 'raw-older',
        kind: 'raw',
        actor: 'system',
        body: 'Tool: write_file\n\nFiles modified:\n- /Users/huyuehui/ace/tik/src/older.html\n\nOutput:\nWritten 12 bytes',
        createdAt: '2026-04-09T01:00:00.000Z',
      },
      {
        id: 'raw-newer',
        kind: 'raw',
        actor: 'system',
        body: 'Tool: write_file\n\nFiles modified:\n- /Users/huyuehui/ace/tik/src/newer.html\n\nOutput:\nWritten 24 bytes',
        createdAt: '2026-04-09T02:00:00.000Z',
      },
    ]);

    expect(latest).toBe('/Users/huyuehui/ace/tik/src/newer.html');
  });

  it('appends steering preset notes without duplicating an existing preset line', () => {
    const first = applyTaskAdjustmentPreset('', 'tighten-scope');
    const second = applyTaskAdjustmentPreset(first, 'tighten-scope');

    expect(first).toContain('smallest shippable slice');
    expect(second).toBe(first);
  });

  it('builds a task adjustment preview from pending title, brief, and operator-note changes', () => {
    const preview = buildTaskAdjustmentPreview(
      {
        id: 'task-a',
        title: 'Console shell',
        status: 'running',
        goal: 'Ship the current console shell',
      },
      {
        title: 'Control console shell',
        goal: 'Ship the current console shell with stronger task steering',
        adjustmentNote: 'Prioritize previewable artifacts for validation.',
      },
    );

    expect(preview.dirty).toBe(true);
    expect(preview.changes.map((change) => change.label)).toEqual([
      'Mission title',
      'Task brief',
      'Operator note',
    ]);
    expect(preview.impacts[0]).toContain('Rewrite the active task brief');
  });

  it('chooses an operator-centric default activity feed lens for the current task state', () => {
    const decisionGroups = buildTimelineGroups([
      { id: 'summary-1', kind: 'summary', actor: 'supervisor', body: 'Supervisor paused before bash and opened a decision request.', createdAt: '2026-04-09T00:00:00.000Z' },
      { id: 'decision-1', kind: 'decision', actor: 'supervisor', body: 'Need approval', createdAt: '2026-04-09T00:00:01.000Z' },
    ]);
    const evidenceGroups = buildTimelineGroups([
      { id: 'summary-2', kind: 'summary', actor: 'supervisor', body: 'Task completed and the latest outputs are ready for review.', createdAt: '2026-04-09T01:00:00.000Z' },
      { id: 'raw-2', kind: 'raw', actor: 'system', body: 'Tool: write_file', createdAt: '2026-04-09T01:00:01.000Z' },
    ]);

    expect(getDefaultWorkbenchFeedLens(decisionGroups, { taskStatus: 'waiting_for_user', hasPendingDecision: true })).toBe('decisions');
    expect(getDefaultWorkbenchFeedLens(evidenceGroups, { taskStatus: 'completed' })).toBe('evidence');
    expect(getDefaultWorkbenchFeedLens(evidenceGroups, { taskStatus: 'running' })).toBe('agents');
  });
});
