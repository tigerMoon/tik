import { describe, expect, it } from 'vitest';
import {
  applyTaskAdjustmentPreset,
  allowedMetadataStatuses,
  buildRunProofPanelModel,
  buildTaskStatusBannerSpec,
  canArchiveWorkbenchTaskFromBanner,
  DASHBOARD_AGENT_LOOP_APPROVE_COMMENT,
  buildWorkbenchAcceptanceDigest,
  buildWorkbenchAcceptanceSummary,
  buildWorkbenchEvidenceDigest,
  buildWorkbenchLiveRunEntries,
  buildWorkbenchAgentLoopSummary,
  buildTaskWorkflowPanelModel,
  buildWorkbenchLatestCommentSummary,
  buildWorkbenchOperatorNoteSummary,
  buildWorkbenchQueueSignal,
  buildWorkbenchRuntimeControlActions,
  buildWorkbenchSteeringUpdateInput,
  buildWorkbenchTaskProgressColumns,
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
  getPreferredReviewArtifactId,
  groupWorkbenchTasks,
  normalizeWorkbenchSummaryText,
  parseWorkbenchEvidence,
  resolveWorkbenchLane,
  shouldLaunchWorkbenchFollowUp,
  sortWorkbenchTasks,
  type WorkbenchTaskSummary,
} from './workbench.js';

describe('workbench view models', () => {
  it('summarizes multi-agent workflow evidence for task detail', () => {
    const model = buildTaskWorkflowPanelModel({
      workflow: {
        id: 'wf-task-detail',
        driver: 'codex-workflow',
        status: 'active',
        goal: 'Expose workflow evidence on task detail',
        rootTaskId: 'task-root',
        repo: 'tik',
        baseRef: 'main',
        headRef: 'codex/workflow-evidence',
        currentHeadSha: 'abcdef1234567890',
        maxRounds: 3,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:05:00.000Z',
        lastDecisionId: 'dec-complete-api',
      },
      taskGraph: {
        workflowId: 'wf-task-detail',
        version: 1,
        createdBy: 'codex-workflow',
        risks: [],
        globalAcceptanceCriteria: ['Task detail shows workflow proof.'],
        finalValidationCommands: ['pnpm test'],
        subtasks: [
          {
            id: 'st-ui',
            title: 'Render workflow panel',
            goal: 'Show workflow evidence.',
            dependsOn: [],
            allowedPaths: ['packages/dashboard/src/**'],
            acceptanceCriteria: ['Panel renders.'],
            validationCommands: ['pnpm --filter @tik/dashboard test'],
            reviewFocus: ['evidence completeness'],
            assignedExecutor: 'codex',
            assignedReviewer: 'claude-code',
          },
        ],
      },
      subtasks: {
        'st-ui': {
          subtaskId: 'st-ui',
          status: 'done',
          reviewRoundIds: ['rr-1'],
          validationRunIds: ['ev-validation'],
          evidenceRefs: ['ev-validation', 'ev-review'],
          blockerFindingIds: [],
          fixRound: 0,
          implementationHeadSha: 'abcdef1234567890',
        },
      },
      contracts: [
        {
          id: 'contract-ui',
          workflowId: 'wf-task-detail',
          subtaskId: 'st-ui',
          version: 1,
          status: 'accepted',
          goal: 'Render workflow evidence.',
          scope: {
            allowedPaths: ['packages/dashboard/src/**'],
            blockedPaths: [],
          },
          deliverables: [
            {
              id: 'deliver-ui',
              description: 'Task detail workflow evidence panel',
            },
          ],
          acceptanceCriteria: [
            {
              id: 'criteria-ui',
              statement: 'Panel renders workflow proof.',
              priority: 'must',
              verificationMethod: 'command',
            },
          ],
          verificationPlan: {
            commands: [
              {
                id: 'dashboard-test',
                command: 'pnpm --filter @tik/dashboard test',
                hardTimeoutMs: 120000,
                required: true,
              },
            ],
          },
          questionerOutputRefs: [],
          acceptedBy: 'codex-workflow',
          acceptedAt: '2026-07-03T00:01:30.000Z',
          headShaAtAcceptance: 'abcdef1234567890',
        },
      ],
      evaluationRuns: [
        {
          id: 'eval-ui',
          workflowId: 'wf-task-detail',
          subtaskId: 'st-ui',
          contractId: 'contract-ui',
          evaluator: { kind: 'codex-evaluator' },
          status: 'passed',
          headSha: 'abcdef1234567890',
          readonlyPolicy: { enforced: true, allowedWritePaths: [], forbiddenWritePaths: [] },
          result: {
            workflowId: 'wf-task-detail',
            subtaskId: 'st-ui',
            contractId: 'contract-ui',
            evaluatorRunId: 'eval-ui',
            headSha: 'abcdef1234567890',
            verdict: 'pass',
            criteriaResults: [],
            commandResults: [],
            runtimeFindings: [],
            coverageGaps: [],
            confidence: 0.9,
          },
          artifactRefs: [],
          startedAt: '2026-07-03T00:02:00.000Z',
          completedAt: '2026-07-03T00:03:00.000Z',
        },
      ],
      questionerRuns: [],
      questionerOutputs: [
        {
          id: 'q-final',
          workflowId: 'wf-task-detail',
          source: 'claude-plugin',
          headSha: 'abcdef1234567890',
          intent: 'question_final_evidence',
          actor: { kind: 'claude-code-questioner', invocationId: 'inv-q' },
          verdict: 'no_blocking_questions',
          questions: [],
          risks: [],
          missingTests: [],
          suggestedContractChanges: [],
          createdAt: '2026-07-03T00:04:00.000Z',
        },
      ],
      questionResolutions: [],
      decisions: [
        {
          id: 'dec-complete-api',
          workflowId: 'wf-task-detail',
          rootTaskId: 'task-root',
          subtaskId: 'st-ui',
          decidedBy: 'codex-workflow',
          decidedAt: '2026-07-03T00:04:30.000Z',
          action: 'complete_subtask',
          reason: 'Validation and review passed.',
          evidenceRefs: ['ev-validation', 'ev-review'],
          confidence: 0.94,
        },
      ],
      evidence: [
        {
          id: 'ev-validation',
          workflowId: 'wf-task-detail',
          subtaskId: 'st-ui',
          kind: 'validation',
          title: 'Dashboard tests',
          summary: 'Tests passed.',
          command: 'pnpm --filter @tik/dashboard test',
          passed: true,
          headSha: 'abcdef1234567890',
          createdAt: '2026-07-03T00:01:00.000Z',
        },
        {
          id: 'ev-review',
          workflowId: 'wf-task-detail',
          subtaskId: 'st-ui',
          kind: 'review',
          title: 'Claude approved',
          passed: true,
          headSha: 'abcdef1234567890',
          payload: {
            result: {
              verdict: 'approve',
              blockingIssues: [],
            },
          },
          createdAt: '2026-07-03T00:02:00.000Z',
        },
      ],
      invocations: [
        {
          id: 'inv-evaluator',
          workflowId: 'wf-task-detail',
          subtaskId: 'st-ui',
          role: 'evaluator',
          runner: 'codex-evaluator',
          promptContract: 'readonly evaluation',
          status: 'completed',
          hookAttested: true,
          createdAt: '2026-07-03T00:02:00.000Z',
          updatedAt: '2026-07-03T00:03:00.000Z',
        },
      ],
      events: [],
    });

    expect(model).toMatchObject({
      workflowId: 'wf-task-detail',
      statusLabel: 'Active',
      rootTaskLabel: 'task-root',
      refLabel: 'tik · main -> codex/workflow-evidence',
      headLabel: 'abcdef123456',
      lastDecisionLabel: 'dec-complete-api',
      metrics: [
        { label: 'Subtasks', value: '1' },
        { label: 'Evidence', value: '2' },
        { label: 'Decisions', value: '1' },
        { label: 'Contracts', value: '1' },
        { label: 'Runtime', value: '3' },
      ],
    });
    expect(model?.plan.map((row) => row.title)).toEqual([
      'TaskGraph v1',
      'Global acceptance',
      'Final validation',
    ]);
    expect(model?.contracts[0]).toMatchObject({
      title: 'Contract contract-ui',
      detail: 'Accepted · v1 · 1 criteria · 1 deliverables · 1 commands',
      tone: 'green',
    });
    expect(model?.subtasks[0]).toMatchObject({
      title: 'Render workflow panel',
      detail: 'Done · 2 evidence · 1 validation · 1 review',
      tone: 'green',
    });
    expect(model?.evidence[0]).toMatchObject({
      title: 'Claude approved',
      detail: 'review · passed · verdict approve · 0 blocking',
      tone: 'green',
    });
    expect(model?.decisions[0]?.detail).toContain('2 evidence refs');
    expect(model?.runtime.map((row) => row.title)).toEqual([
      'Evaluation eval-ui',
      'Questioner Question final evidence',
      'Evaluator invocation',
    ]);
  });

  it('keeps task detail workflow evidence renderable for legacy bundles missing optional collections', () => {
    const model = buildTaskWorkflowPanelModel({
      workflow: {
        id: 'wf-legacy',
        driver: 'codex-workflow',
        status: 'completed',
        goal: 'Legacy workflow response',
        rootTaskId: 'TIK-135',
        currentHeadSha: 'abcdef1234567890',
        maxRounds: 3,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:05:00.000Z',
      },
      taskGraph: null,
      subtasks: {},
      contracts: [],
      evaluationRuns: [],
      questionerOutputs: [],
      questionResolutions: [],
      decisions: [],
      evidence: [
        {
          id: 'ev-final',
          workflowId: 'wf-legacy',
          kind: 'validation',
          title: 'Final validation',
          passed: true,
          headSha: 'abcdef1234567890',
          createdAt: '2026-07-03T00:04:00.000Z',
        },
      ],
      invocations: [],
      events: [],
    });

    expect(model).toMatchObject({
      workflowId: 'wf-legacy',
      metrics: [
        { label: 'Subtasks', value: '0' },
        { label: 'Evidence', value: '1' },
        { label: 'Decisions', value: '0' },
        { label: 'Contracts', value: '0' },
        { label: 'Runtime', value: '0' },
      ],
    });
    expect(model?.evidence[0]).toMatchObject({ title: 'Final validation', tone: 'green' });
  });

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

  it('groups tracker workflow states into backlog, active, and attention lanes', () => {
    const tasks: WorkbenchTaskSummary[] = [
      { id: 'backlog', title: 'backlog', status: 'backlog', updatedAt: '2026-04-09T00:00:00.000Z' },
      { id: 'todo', title: 'todo', status: 'todo', updatedAt: '2026-04-09T00:00:01.000Z' },
      { id: 'progress', title: 'progress', status: 'in_progress', updatedAt: '2026-04-09T00:00:02.000Z' },
      { id: 'review', title: 'review', status: 'in_review', updatedAt: '2026-04-09T00:00:03.000Z' },
      { id: 'urgent', title: 'urgent', status: 'todo', priority: 1, updatedAt: '2026-04-09T00:00:04.000Z' },
    ];

    const grouped = groupWorkbenchTasks(tasks);

    expect(grouped.backlog.map((task) => task.id)).toEqual(['backlog']);
    expect(grouped.active.map((task) => task.id)).toEqual(['urgent', 'review', 'progress', 'todo']);
    expect(grouped.attention.map((task) => task.id)).toEqual(['urgent', 'review']);
    expect(filterWorkbenchTasksByLens(tasks, 'backlog').map((task) => task.id)).toEqual(['backlog']);
  });

  it('groups visible tasks into progress board columns', () => {
    const tasks: WorkbenchTaskSummary[] = [
      { id: 'backlog', title: 'backlog', status: 'backlog', updatedAt: '2026-04-09T00:00:00.000Z' },
      { id: 'recover', title: 'recover', status: 'failed', updatedAt: '2026-04-09T00:00:01.000Z' },
      { id: 'cancelled', title: 'cancelled', status: 'cancelled', updatedAt: '2026-04-09T00:00:01.500Z' },
      { id: 'running', title: 'running', status: 'running', updatedAt: '2026-04-09T00:00:02.000Z' },
      { id: 'review', title: 'review', status: 'waiting_for_user', updatedAt: '2026-04-09T00:00:03.000Z' },
      { id: 'done', title: 'done', status: 'completed', updatedAt: '2026-04-09T00:00:04.000Z' },
    ];

    expect(buildWorkbenchTaskProgressColumns(tasks).map((column) => ({
      id: column.id,
      taskIds: column.tasks.map((task) => task.id),
    }))).toEqual([
      { id: 'backlog', taskIds: ['backlog'] },
      { id: 'todo', taskIds: ['recover'] },
      { id: 'in_progress', taskIds: ['running'] },
      { id: 'in_review', taskIds: ['done', 'review'] },
    ]);
  });

  it('surfaces agent-loop tasks in review loop lane and search metadata', () => {
    const tasks: WorkbenchTaskSummary[] = [
      {
        id: 'review-task',
        title: 'Review local changes',
        status: 'todo',
        updatedAt: '2026-04-09T00:00:01.000Z',
        agentLoop: {
          kind: 'claude_review',
          rootTaskId: 'local-review',
          round: 1,
          maxRounds: 3,
          headSha: 'abcdef1234567890',
          idempotencyKey: 'claude_review:internal:tik:local-review:abcdef:r1',
          changeRequest: {
            scm: 'internal',
            repo: 'tik',
            id: 'local-review:abcdef',
            type: 'internal_review',
            baseRef: 'HEAD~1',
            headRef: 'codex/tik-agent-loop-mvp',
            headSha: 'abcdef1234567890',
          },
          reviewFocus: ['dashboard visibility'],
        },
      },
      {
        id: 'cancelled-review-task',
        title: 'Cancelled review local changes',
        status: 'cancelled',
        updatedAt: '2026-04-09T00:00:02.000Z',
        agentLoop: {
          kind: 'claude_review',
          rootTaskId: 'local-review',
          round: 1,
          maxRounds: 3,
          headSha: 'abcdef1234567890',
          idempotencyKey: 'claude_review:internal:tik:cancelled:abcdef:r1',
          changeRequest: {
            scm: 'internal',
            repo: 'tik',
            id: 'cancelled:abcdef',
            type: 'internal_review',
            baseRef: 'HEAD~1',
            headRef: 'codex/tik-agent-loop-mvp',
            headSha: 'abcdef1234567890',
          },
        },
      },
      { id: 'normal-task', title: 'Normal task', status: 'todo', updatedAt: '2026-04-09T00:00:00.000Z' },
    ];

    expect(filterWorkbenchTasksByLens(tasks, 'review-loop').map((task) => task.id)).toEqual(['review-task']);
    expect(filterWorkbenchTasksByQuery(tasks, 'claude_review').map((task) => task.id)).toEqual(['review-task', 'cancelled-review-task']);
    expect(filterWorkbenchTasksByQuery(tasks, 'dashboard visibility').map((task) => task.id)).toEqual(['review-task']);
    expect(buildWorkbenchAgentLoopSummary(tasks[0]?.agentLoop)).toEqual({
      label: 'Claude review · R1/3',
      detail: 'tik#local-review:abcdef · codex/tik-agent-loop-mvp · abcdef123456',
      kindLabel: 'Claude review',
      shortHeadSha: 'abcdef123456',
      tone: 'neutral',
    });
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

  it('extracts modified files from raw git status and git diff shell evidence', () => {
    const parsed = parseWorkbenchEvidence({
      id: 'raw-git',
      kind: 'raw',
      actor: 'system',
      body: [
        'Tool: bash',
        '',
        'Output:',
        ' M packages/dashboard/src/styles/workbench-inbox.css',
        '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
        'diff --git a/packages/dashboard/src/App.tsx b/packages/dashboard/src/App.tsx',
        'index 123..456 100644',
      ].join('\n'),
      createdAt: '2026-04-09T00:00:00.000Z',
    });

    expect(parsed.filesModified).toEqual([
      'packages/dashboard/src/styles/workbench-inbox.css',
      'packages/dashboard/src/styles/workbench-inbox.test.ts',
      'packages/dashboard/src/App.tsx',
    ]);
  });

  it('extracts modified files from JSON bash stdout evidence', () => {
    const parsed = parseWorkbenchEvidence({
      id: 'raw-json-git',
      kind: 'raw',
      actor: 'system',
      body: [
        'Tool: bash',
        '',
        'Output:',
        JSON.stringify({
          command: 'git status --short && git diff -- packages/dashboard/src/styles/workbench-inbox.css',
          stdout: [
            '/Users/huyuehui/ace/tik/.workspace/worktrees/tik-805562e6--tik-83',
            ' M packages/dashboard/src/styles/workbench-inbox.css',
            '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
            'diff --git a/packages/dashboard/src/styles/workbench-inbox.css b/packages/dashboard/src/styles/workbench-inbox.css',
          ].join('\n'),
          exitCode: 0,
        }, null, 2),
      ].join('\n'),
      createdAt: '2026-04-09T00:00:00.000Z',
    });

    expect(parsed.filesModified).toEqual([
      'packages/dashboard/src/styles/workbench-inbox.css',
      'packages/dashboard/src/styles/workbench-inbox.test.ts',
    ]);
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

  it('counts modified files from shell git evidence in the digest', () => {
    const digest = buildWorkbenchEvidenceDigest([
      {
        id: 'raw-git',
        kind: 'raw',
        actor: 'system',
        body: [
          'Tool: bash',
          '',
          'Output:',
          ' M packages/dashboard/src/styles/workbench-inbox.css',
          '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
          'diff --git a/packages/dashboard/src/styles/workbench-inbox.css b/packages/dashboard/src/styles/workbench-inbox.css',
        ].join('\n'),
        createdAt: '2026-04-09T02:00:00.000Z',
      },
    ]);

    expect(digest.modifiedFileCount).toBe(2);
    expect(digest.modifiedFiles).toEqual([
      'packages/dashboard/src/styles/workbench-inbox.css',
      'packages/dashboard/src/styles/workbench-inbox.test.ts',
    ]);
  });

  it('extracts the latest git diff excerpt for acceptance review', () => {
    const digest = buildWorkbenchEvidenceDigest([
      {
        id: 'raw-diff',
        kind: 'raw',
        actor: 'system',
        body: [
          'Tool: bash',
          '',
          'Output:',
          JSON.stringify({
            command: 'git diff -- packages/dashboard/src/App.tsx',
            stdout: [
              'diff --git a/packages/dashboard/src/App.tsx b/packages/dashboard/src/App.tsx',
              'index 1111111..2222222 100644',
              '--- a/packages/dashboard/src/App.tsx',
              '+++ b/packages/dashboard/src/App.tsx',
              '@@ -1,3 +1,4 @@',
              ' import React from "react";',
              '+import { TaskCommentsBlock } from "./TaskCommentsBlock";',
            ].join('\n'),
            exitCode: 0,
          }, null, 2),
        ].join('\n'),
        createdAt: '2026-04-09T02:00:00.000Z',
      },
    ]);

    expect(digest.latestDiffExcerpt).toContain('diff --git a/packages/dashboard/src/App.tsx');
    expect(digest.latestDiffExcerpt).toContain('+import { TaskCommentsBlock }');
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

  it('counts registry artifacts as acceptance evidence when raw timeline evidence is missing', () => {
    const digest = buildWorkbenchAcceptanceDigest([], [
      {
        id: 'art-review',
        taskId: 'task-1',
        title: 'Run Review: TIK-105 attempt 1',
        kind: 'run_review',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-review',
        version: 1,
        safeRelativePath: 'review.md',
        contentType: 'text/markdown',
        sizeBytes: 10,
        contentHash: 'hash-review',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        changedFiles: ['README.md', 'packages/dashboard/src/App.tsx'],
        producedBy: { provider: 'codex', template: 'run-review' },
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
      },
      {
        id: 'art-diff',
        taskId: 'task-1',
        title: 'Run Diff: TIK-105 attempt 1',
        kind: 'diff',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-diff',
        version: 1,
        safeRelativePath: 'diff.patch',
        contentType: 'text/x-diff',
        sizeBytes: 10,
        contentHash: 'hash-diff',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        changedFiles: ['README.md'],
        producedBy: { provider: 'codex' },
        createdAt: '2026-06-24T00:00:01.000Z',
        updatedAt: '2026-06-24T00:00:01.000Z',
      },
      {
        id: 'art-transcript',
        taskId: 'task-1',
        title: 'Run Transcript: TIK-105 attempt 1',
        kind: 'transcript',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-transcript',
        version: 1,
        safeRelativePath: 'transcript.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
        contentHash: 'hash-transcript',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        producedBy: { provider: 'codex' },
        createdAt: '2026-06-24T00:00:02.000Z',
        updatedAt: '2026-06-24T00:00:02.000Z',
      },
      {
        id: 'art-diff-stat',
        taskId: 'task-1',
        title: 'Run Diff Stat: TIK-105 attempt 1',
        kind: 'diff',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-diff-stat',
        version: 1,
        safeRelativePath: 'diff-stat.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
        contentHash: 'hash-diff-stat',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        changedFiles: ['packages/dashboard/src/App.tsx'],
        producedBy: { provider: 'codex' },
        createdAt: '2026-06-24T00:00:03.000Z',
        updatedAt: '2026-06-24T00:00:03.000Z',
      },
    ]);

    expect(digest.rawEventCount).toBe(0);
    expect(digest.artifactCount).toBe(4);
    expect(digest.modifiedFileCount).toBe(2);
    expect(digest.modifiedFiles).toEqual(['README.md', 'packages/dashboard/src/App.tsx']);
    expect(buildWorkbenchAcceptanceSummary('in_review', digest)).toEqual({
      tone: 'blue',
      headline: 'Review artifacts ready',
      detail: 'The task is in review with artifacts attached. Inspect the preview, changed files, and run evidence before accepting it.',
    });
  });

  it('builds a run proof decision panel model from review evidence artifacts', () => {
    const model = buildRunProofPanelModel('needs_review', [
      {
        id: 'art-review',
        taskId: 'task-1',
        title: 'Run Review: TIK-1 attempt 1',
        kind: 'run_review',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-review',
        version: 1,
        safeRelativePath: 'review.md',
        contentType: 'text/markdown',
        sizeBytes: 10,
        contentHash: 'hash',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        changedFiles: ['src/app.ts'],
        validationRefs: ['validation-1'],
        producedBy: { provider: 'codex', template: 'run-review' },
        summary: 'Ready for review',
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
      },
      {
        id: 'art-diff',
        taskId: 'task-1',
        title: 'Run Diff: TIK-1 attempt 1',
        kind: 'diff',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-diff',
        version: 1,
        safeRelativePath: 'diff.patch',
        contentType: 'text/x-diff',
        sizeBytes: 10,
        contentHash: 'hash',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        producedBy: {},
        createdAt: '2026-06-24T00:00:01.000Z',
        updatedAt: '2026-06-24T00:00:01.000Z',
      },
      {
        id: 'art-transcript',
        taskId: 'task-1',
        title: 'Run Transcript: TIK-1 attempt 1',
        kind: 'transcript',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-transcript',
        version: 1,
        safeRelativePath: 'transcript.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
        contentHash: 'hash',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        producedBy: {},
        createdAt: '2026-06-24T00:00:02.000Z',
        updatedAt: '2026-06-24T00:00:02.000Z',
      },
      {
        id: 'art-validation',
        taskId: 'task-1',
        title: 'Run Validation STDOUT: TIK-1 attempt 1',
        kind: 'validation_log',
        status: 'needs_review',
        visibility: 'local',
        latestVersionId: 'ver-validation',
        version: 1,
        safeRelativePath: 'validation.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
        contentHash: 'hash',
        sourceEventIds: [],
        sourceEvidenceIds: [],
        producedBy: {},
        createdAt: '2026-06-24T00:00:03.000Z',
        updatedAt: '2026-06-24T00:00:03.000Z',
      },
    ]);

    expect(model).toMatchObject({
      reviewArtifactId: 'art-review',
      statusLabel: 'Needs review',
      canDecide: true,
      changedFiles: ['src/app.ts'],
      validationRefs: ['validation-1'],
      links: {
        review: { artifactId: 'art-review', versionId: 'ver-review' },
        diff: { artifactId: 'art-diff', versionId: 'ver-diff' },
        transcript: { artifactId: 'art-transcript', versionId: 'ver-transcript' },
        validation: { artifactId: 'art-validation', versionId: 'ver-validation' },
      },
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

    expect(buildWorkbenchQueueSignal({
      status: 'running',
      evidenceSummary: {
        rawEventCount: 12,
        modifiedFileCount: 2,
        previewableArtifactCount: 0,
        latestToolName: 'bash',
        hasErrorEvidence: true,
      },
    })).toEqual({
      tone: 'red',
      label: 'Tool error',
      detail: '12 evidence events recorded · latest run contains a tool error',
    });

    expect(buildWorkbenchQueueSignal({
      status: 'completed',
      evidenceSummary: {
        rawEventCount: 12,
        modifiedFileCount: 2,
        previewableArtifactCount: 0,
        latestToolName: 'bash',
        hasErrorEvidence: true,
      },
    })).toEqual({
      tone: 'yellow',
      label: 'Run had errors',
      detail: 'Completed with tool errors in evidence · 2 files touched',
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

  it('surfaces the latest human comment on completed task cards', () => {
    const task: WorkbenchTaskSummary & { goal: string; waitingReason: string } = {
      id: 'task-comment',
      title: 'Left align task list',
      status: 'completed',
      goal: 'Left align task list',
      waitingReason: 'Review finished.',
      latestSummary: 'Task completed and the latest outputs are ready for review.',
      comments: [
        {
          id: 'agent-comment',
          authorKind: 'agent',
          body: 'Internal note',
          createdAt: '2026-04-13T12:00:00.000Z',
        },
        {
          id: 'human-comment',
          authorKind: 'human',
          body: '创建mr 并合并到 master',
          createdAt: '2026-04-13T12:01:00.000Z',
        },
      ],
    };

    expect(buildWorkbenchLatestCommentSummary(task)).toBe('Latest comment: 创建mr 并合并到 master');
    expect(buildWorkbenchTaskVisibleSummary(task)).toBe('Latest comment: 创建mr 并合并到 master');
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

describe('task status banner spec', () => {
  const baseTask = (overrides: Partial<{
    status: import('@tik/shared').WorkbenchTaskStatus;
    waitingReason: string;
    attempts: Array<{ attemptNumber: number; outcome?: string; error?: string }>;
    blockedBy: Array<{ state?: string | null }>;
    agentLoop: import('@tik/shared').AgentLoopMetadata;
  }> = {}) => ({
    status: overrides.status ?? 'todo' as import('@tik/shared').WorkbenchTaskStatus,
    waitingReason: overrides.waitingReason,
    attempts: overrides.attempts,
    blockedBy: overrides.blockedBy,
    agentLoop: overrides.agentLoop,
  });

  it('returns null for active execution states (banner hidden)', () => {
    expect(buildTaskStatusBannerSpec(baseTask({ status: 'running' }))).toBeNull();
    expect(buildTaskStatusBannerSpec(baseTask({ status: 'in_progress' }))).toBeNull();
    expect(buildTaskStatusBannerSpec(baseTask({ status: 'todo' }))).toBeNull();
    expect(buildTaskStatusBannerSpec(baseTask({ status: 'backlog' }))).toBeNull();
    expect(buildTaskStatusBannerSpec(baseTask({ status: 'verifying' }))).toBeNull();
    expect(buildTaskStatusBannerSpec(baseTask({ status: 'new' }))).toBeNull();
  });

  it('returns null when no task is selected', () => {
    expect(buildTaskStatusBannerSpec(null, [])).toBeNull();
  });

  it('renders a decision-driven banner regardless of task status (no buttons)', () => {
    const spec = buildTaskStatusBannerSpec(
      baseTask({ status: 'running' }),
      [{ title: 'Approve high-risk bash', summary: 'Bash will run rm -rf node_modules' }],
    );

    expect(spec).not.toBeNull();
    expect(spec!.tone).toBe('yellow');
    expect(spec!.headline).toBe('Approve high-risk bash');
    expect(spec!.actions).toEqual([]);
    expect(spec!.decisionDriven).toBe(true);
  });

  it('renders waiting_for_user banner with resume + stop actions', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'waiting_for_user',
      waitingReason: 'Operator rejected high-risk bash',
    }));

    expect(spec).not.toBeNull();
    expect(spec!.tone).toBe('yellow');
    expect(spec!.headline).toBe('Waiting on you');
    expect(spec!.detail).toBe('Operator rejected high-risk bash');
    expect(spec!.actions.map((action) => action.id)).toEqual(['resume', 'stop']);
    expect(spec!.decisionDriven).toBe(false);
  });

  it('renders in_review banner as a review entrypoint instead of a resume control', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'in_review',
      waitingReason: 'Latest review artifact needs acceptance.',
    }));

    expect(spec).not.toBeNull();
    expect(spec!.headline).toBe('In review');
    expect(spec!.detail).toBe('Latest review artifact needs acceptance.');
    expect(spec!.actions.map((action) => action.id)).toEqual(['open-review', 'stop']);
    expect(spec!.actions.find((action) => action.id === 'open-review')?.label).toBe('Open review');
  });

  it('renders agent-loop human review banner with approve and archive actions', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'in_review',
      agentLoop: {
        kind: 'human_review',
        phase: 'needs_human_review',
        rootTaskId: 'TASK-123',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'review-human',
        changeRequest: {
          scm: 'internal',
          repo: 'tik',
          id: 'TASK-123:abc123',
          type: 'internal_review',
          baseRef: 'main',
          headRef: 'codex/review',
          headSha: 'abc123',
        },
      },
    }));

    expect(spec).not.toBeNull();
    expect(spec!.headline).toBe('Human review');
    expect(spec!.actions.map((action) => action.id)).toEqual(['approve-review', 'archive', 'open-review']);
  });

  it('falls back to the default review banner when human review phase is not explicit', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'in_review',
      agentLoop: {
        kind: 'human_review',
        phase: 'complete',
        rootTaskId: 'TASK-123',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'review-human-complete',
        changeRequest: {
          scm: 'internal',
          repo: 'tik',
          id: 'TASK-123:abc123',
          type: 'internal_review',
          baseRef: 'main',
          headRef: 'codex/review',
          headSha: 'abc123',
        },
      },
    }));

    expect(spec).not.toBeNull();
    expect(spec!.headline).toBe('In review');
    expect(spec!.actions.map((action) => action.id)).toEqual(['open-review', 'stop']);
  });

  it('centralizes dashboard archive and approve-review action protocol', () => {
    expect(canArchiveWorkbenchTaskFromBanner(baseTask({ status: 'completed' }))).toBe(true);
    expect(canArchiveWorkbenchTaskFromBanner(baseTask({ status: 'in_review' }))).toBe(false);
    expect(canArchiveWorkbenchTaskFromBanner(baseTask({
      status: 'in_review',
      agentLoop: {
        kind: 'human_review',
        phase: 'needs_human_review',
        rootTaskId: 'TASK-123',
        round: 1,
        maxRounds: 3,
        headSha: 'abc123',
        idempotencyKey: 'review-human-archive',
        changeRequest: {
          scm: 'internal',
          repo: 'tik',
          id: 'TASK-123:abc123',
          type: 'internal_review',
          baseRef: 'main',
          headRef: 'codex/review',
          headSha: 'abc123',
        },
      },
    }))).toBe(true);
    expect(DASHBOARD_AGENT_LOOP_APPROVE_COMMENT).toContain('/approve');
  });

  it('renders failed banner with retry + cancel and surfaces last attempt error', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'failed',
      attempts: [
        { attemptNumber: 1, outcome: 'failed', error: 'connection timeout to magic-trade' },
        { attemptNumber: 2, outcome: 'failed', error: 'second pass also timed out' },
      ],
    }));

    expect(spec).not.toBeNull();
    expect(spec!.tone).toBe('red');
    expect(spec!.headline).toBe('Failed on attempt 2');
    expect(spec!.detail).toBe('second pass also timed out');
    expect(spec!.actions.map((action) => action.id)).toEqual(['retry', 'cancel']);
  });

  it('renders blocked banner with open blocker count', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'blocked',
      blockedBy: [
        { state: 'todo' },
        { state: 'done' },
        { state: 'in_progress' },
      ],
    }));

    expect(spec).not.toBeNull();
    expect(spec!.tone).toBe('red');
    expect(spec!.headline).toBe('Blocked');
    expect(spec!.detail).toBe('2 open blockers.');
    expect(spec!.actions.map((action) => action.id)).toEqual(['unblock', 'cancel']);
  });

  it('renders completed banner with run-next-pass + archive actions', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({
      status: 'completed',
      attempts: [{ attemptNumber: 1, outcome: 'completed' }],
    }));

    expect(spec).not.toBeNull();
    expect(spec!.tone).toBe('green');
    expect(spec!.headline).toBe('Completed on attempt 1');
    expect(spec!.actions.map((action) => action.id)).toEqual(['run-next-pass', 'archive']);
  });

  it('renders paused banner with neutral tone', () => {
    const spec = buildTaskStatusBannerSpec(baseTask({ status: 'paused' }));

    expect(spec).not.toBeNull();
    expect(spec!.tone).toBe('neutral');
    expect(spec!.icon).toBe('⏸');
    expect(spec!.actions.map((action) => action.id)).toEqual(['resume', 'stop']);
  });

  it('renders cancelled banner with archive + reopen actions', () => {
    const cancelled = buildTaskStatusBannerSpec(baseTask({ status: 'cancelled' }));
    expect(cancelled!.tone).toBe('neutral');
    expect(cancelled!.headline).toBe('Cancelled');
    expect(cancelled!.actions.map((action) => action.id)).toEqual(['archive', 'reopen']);
  });

  it('renders archived banner with reopen action', () => {
    const archived = buildTaskStatusBannerSpec(baseTask({ status: 'archived' }));
    expect(archived!.tone).toBe('neutral');
    expect(archived!.headline).toBe('Archived');
    expect(archived!.actions.map((action) => action.id)).toEqual(['reopen']);
  });
});

describe('allowedMetadataStatuses', () => {
  it('always includes the current status as a no-op option', () => {
    expect(allowedMetadataStatuses('running')).toContain('running');
    expect(allowedMetadataStatuses('blocked')).toContain('blocked');
    expect(allowedMetadataStatuses('completed')).toContain('completed');
  });

  it('disallows reaching unrelated states from completed', () => {
    expect(allowedMetadataStatuses('completed')).not.toContain('running');
    expect(allowedMetadataStatuses('completed')).not.toContain('failed');
  });
});

describe('buildWorkbenchRuntimeControlActions', () => {
  it('hides runtime controls for completed tasks', () => {
    expect(buildWorkbenchRuntimeControlActions('completed')).toEqual([]);
  });

  it('surfaces only controls that apply to the current runtime state', () => {
    expect(buildWorkbenchRuntimeControlActions('running').map((action) => action.id)).toEqual(['pause', 'stop']);
    expect(buildWorkbenchRuntimeControlActions('paused').map((action) => action.id)).toEqual(['resume', 'stop']);
    expect(buildWorkbenchRuntimeControlActions('waiting_for_user').map((action) => action.id)).toEqual(['resume', 'stop']);
    expect(buildWorkbenchRuntimeControlActions('in_review').map((action) => action.id)).toEqual(['stop']);
  });
});

describe('getPreferredReviewArtifactId', () => {
  const artifact = (input: {
    id: string;
    kind: import('@tik/shared').ArtifactKind;
    title: string;
    createdAt: string;
    updatedAt: string;
    tags?: string[];
  }): import('@tik/shared').WorkbenchArtifactRecord => ({
    id: input.id,
    taskId: 'task-1',
    kind: input.kind,
    title: input.title,
    status: 'needs_review',
    visibility: 'local',
    latestVersionId: `ver-${input.id}`,
    version: 1,
    safeRelativePath: `${input.id}.md`,
    contentType: 'text/markdown',
    sizeBytes: 1,
    contentHash: `hash-${input.id}`,
    sourceEventIds: [],
    sourceEvidenceIds: [],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    tags: input.tags || [],
    producedBy: {},
  });

  it('prefers the newest run review artifact, then falls back to the newest artifact', () => {
    expect(getPreferredReviewArtifactId([
      artifact({
        id: 'art-diff-newer',
        kind: 'diff',
        title: 'Patch',
        createdAt: '2026-04-09T00:00:03.000Z',
        updatedAt: '2026-04-09T00:00:03.000Z',
      }),
      artifact({
        id: 'art-review',
        kind: 'run_review',
        title: 'Review',
        createdAt: '2026-04-09T00:00:01.000Z',
        updatedAt: '2026-04-09T00:00:01.000Z',
      }),
    ])).toBe('art-review');

    expect(getPreferredReviewArtifactId([
      artifact({
        id: 'art-diff',
        kind: 'diff',
        title: 'Patch',
        createdAt: '2026-04-09T00:00:01.000Z',
        updatedAt: '2026-04-09T00:00:01.000Z',
      }),
      artifact({
        id: 'art-validation',
        kind: 'validation_log',
        title: 'Validation',
        createdAt: '2026-04-09T00:00:02.000Z',
        updatedAt: '2026-04-09T00:00:02.000Z',
      }),
    ])).toBe('art-validation');
  });
});
