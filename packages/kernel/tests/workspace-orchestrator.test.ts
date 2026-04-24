import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceOrchestrator } from '../src/workspace-orchestrator.js';
import type { WorkspaceDecisionRequest, WorkspaceResolution } from '@tik/shared';

const tempDirs: string[] = [];

async function createWorkspaceResolution(): Promise<WorkspaceResolution> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workspace-orchestrator-'));
  tempDirs.push(rootPath);
  const serviceAPath = path.join(rootPath, 'service-a');
  const serviceBPath = path.join(rootPath, 'service-b');
  await fs.mkdir(serviceAPath, { recursive: true });
  await fs.mkdir(serviceBPath, { recursive: true });
  const workspaceFile = path.join(rootPath, 'demo.code-workspace');
  await fs.writeFile(workspaceFile, JSON.stringify({
    folders: [
      { path: 'service-a', name: 'service-a' },
      { path: 'service-b', name: 'service-b' },
    ],
  }), 'utf-8');

  return {
    workspace: {
      name: 'demo',
      rootPath,
      workspaceFile,
      projects: [
        { name: 'service-a', path: serviceAPath },
        { name: 'service-b', path: serviceBPath },
      ],
      config: {},
    },
    projectPath: serviceAPath,
    isWorkspace: true,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

describe('WorkspaceOrchestrator', () => {
  it('bootstraps into PARALLEL_CLARIFY and advances phases as projects complete', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();

    const bootstrapped = await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成技术方案，并给 service-b 生成技术方案',
    });
    const serviceA = resolution.workspace!.projects[0]!;
    const serviceB = resolution.workspace!.projects[1]!;
    expect(bootstrapped.state?.currentPhase).toBe('PARALLEL_CLARIFY');
    expect(bootstrapped.state?.activeProjectNames).toEqual(['service-a', 'service-b']);
    expect(bootstrapped.settings?.worktreePolicy?.mode).toBe('managed');
    expect(bootstrapped.settings?.worktreePolicy?.nonGitStrategy).toBe('source');
    expect(bootstrapped.state?.projects?.[0]?.sourceProjectPath).toBe(serviceA.path);
    expect(bootstrapped.state?.projects?.[0]?.effectiveProjectPath).toBe(serviceA.path);
    expect(bootstrapped.state?.projects?.[0]?.worktreeLanes).toEqual([]);

    await orchestrator.markClarifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(resolution.workspace!.rootPath, '.workspace/clarifications/service-a/clarify-1.md'),
      'clarify a',
      'task-clarify-a',
    );
    let snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    expect(snapshot.state?.currentPhase).toBe('PARALLEL_CLARIFY');

    await orchestrator.markClarifyResult(
      resolution.workspace!.rootPath,
      'service-b',
      path.join(resolution.workspace!.rootPath, '.workspace/clarifications/service-b/clarify-1.md'),
      'clarify b',
      'task-clarify-b',
    );
    snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    expect(snapshot.state?.currentPhase).toBe('PARALLEL_SPECIFY');

    await orchestrator.markSpecifyResult(resolution.workspace!.rootPath, 'service-a', path.join(serviceA.path, '.specify/specs/spec.md'), 'spec a');
    snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    expect(snapshot.state?.currentPhase).toBe('PARALLEL_SPECIFY');

    await orchestrator.markSpecifyResult(resolution.workspace!.rootPath, 'service-b', path.join(serviceB.path, '.specify/specs/spec.md'), 'spec b');
    snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    expect(snapshot.state?.currentPhase).toBe('PARALLEL_PLAN');

    await orchestrator.markPlanResult(resolution.workspace!.rootPath, 'service-a', path.join(serviceA.path, '.specify/specs/plan.md'), 'plan a');
    await orchestrator.markPlanResult(resolution.workspace!.rootPath, 'service-b', path.join(serviceB.path, '.specify/specs/plan.md'), 'plan b');
    snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    expect(snapshot.state?.currentPhase).toBe('PARALLEL_ACE');

    await orchestrator.markAceResult(resolution.workspace!.rootPath, 'service-a', 'task-a', 'completed', 'done a');
    await orchestrator.markAceResult(resolution.workspace!.rootPath, 'service-b', 'task-b', 'completed', 'done b');
    snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    expect(snapshot.state?.currentPhase).toBe('COMPLETED');
    expect(snapshot.state?.summary?.completedProjects).toBe(2);
  });

  it('records feedback and moves to FEEDBACK_ITERATION with nextPhase metadata', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-b 增加缓存并同步 service-a 契约',
    });

    const snapshot = await orchestrator.recordFeedback(
      resolution.workspace!.rootPath,
      'plan 仍是模板，需要重跑 plan',
      ['service-a', 'service-b'],
      'PARALLEL_CLARIFY',
    );

    expect(snapshot.state?.currentPhase).toBe('FEEDBACK_ITERATION');
    expect(snapshot.state?.workspaceFeedback?.required).toBe(true);
    expect(snapshot.state?.workspaceFeedback?.nextPhase).toBe('PARALLEL_CLARIFY');
  });

  it('persists an explicit workflow policy profile during bootstrap', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();

    const snapshot = await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成技术方案',
      workflowPolicy: {
        profile: 'deep-verify',
      },
    });

    expect(snapshot.settings?.workflowPolicy?.profile).toBe('deep-verify');
    expect(snapshot.settings?.workflowPolicy?.phaseBudgetsMs?.PARALLEL_ACE).toBe(900_000);
    expect(snapshot.settings?.workflowPolicy?.maxFeedbackRetriesPerPhase?.PARALLEL_PLAN).toBe(2);
  });

  it('tracks multiple worktree lanes while keeping a single active execution path', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成技术方案',
    });

    await orchestrator.markProjectWorktreeReady(resolution.workspace!.rootPath, 'service-a', {
      effectiveProjectPath: path.join(resolution.workspace!.rootPath, '.workspace', 'worktrees', 'service-a'),
      worktree: {
        enabled: true,
        status: 'ready',
        laneId: 'primary',
        sourceBranch: 'main',
        worktreeBranch: 'tik/demo/service-a',
        worktreePath: path.join(resolution.workspace!.rootPath, '.workspace', 'worktrees', 'service-a'),
        updatedAt: '2026-04-07T00:00:00.000Z',
      },
    });

    let snapshot = await orchestrator.getStatus(resolution.workspace!.rootPath);
    let project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.effectiveProjectPath).toBe(resolution.workspace!.projects[0]!.path);
    expect(project?.worktree).toBeUndefined();
    expect(project?.worktreeLanes?.map((lane) => lane.laneId)).toEqual(['primary']);

    const activated = await orchestrator.activateProjectWorktreeLane(resolution.workspace!.rootPath, 'service-a', {
      effectiveProjectPath: path.join(resolution.workspace!.rootPath, '.workspace', 'worktrees', 'service-a--feature-a'),
      worktree: {
        enabled: true,
        status: 'ready',
        laneId: 'feature-a',
        sourceBranch: 'main',
        worktreeBranch: 'tik/demo/service-a--feature-a',
        worktreePath: path.join(resolution.workspace!.rootPath, '.workspace', 'worktrees', 'service-a--feature-a'),
        updatedAt: '2026-04-07T00:00:01.000Z',
      },
    });

    project = activated.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.effectiveProjectPath).toBe(path.join(resolution.workspace!.rootPath, '.workspace', 'worktrees', 'service-a--feature-a'));
    expect(project?.worktree?.laneId).toBe('feature-a');
    expect(project?.worktreeLanes?.map((lane) => lane.laneId)).toEqual(['primary', 'feature-a']);
  });

  it('selects only the primary owner project when another project is mentioned as an external dependency', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();

    const snapshot = await orchestrator.bootstrap({
      resolution,
      demand: '替换 service-a 本地查询为 service-b 外部接口，并同步 service-b 契约',
    });

    expect(snapshot.splitDemands?.items.map((item) => item.projectName)).toEqual(['service-a']);
    expect(snapshot.splitDemands?.items[0]?.reason).toContain('ownership cues');
    expect(snapshot.state?.activeProjectNames).toEqual(['service-a']);
  });

  it('preserves plan task ids and raises workspace feedback when plan is blocked', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成技术实现计划',
    });

    const serviceA = resolution.workspace!.projects[0]!;
    await orchestrator.markClarifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(resolution.workspace!.rootPath, '.workspace/clarifications/service-a/clarify-1.md'),
      'clarify a',
      'task-clarify-a',
    );
    await orchestrator.markSpecifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/spec.md'),
      'spec a',
      'task-spec-a',
    );

    const snapshot = await orchestrator.markProjectBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      'PARALLEL_PLAN',
      'Generated plan still looks like a template skeleton.',
      'task-plan-a',
    );

    const project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.planTaskId).toBe('task-plan-a');
    expect(project?.taskId).toBe('task-plan-a');
    expect(project?.workflowContract).toBe('PLAN_SUBTASK');
    expect(project?.recommendedCommand).toBe('tik workspace decisions');
    expect(snapshot.state?.currentPhase).toBe('FEEDBACK_ITERATION');
    expect(snapshot.state?.workspaceFeedback?.required).toBe(true);
    expect(snapshot.state?.workspaceFeedback?.nextPhase).toBe('PARALLEL_PLAN');
    expect(snapshot.state?.decisions?.[0]).toMatchObject({
      status: 'pending',
      kind: 'phase_reroute',
      projectName: 'service-a',
      phase: 'PARALLEL_PLAN',
    });
  });

  it('captures clarify blockers as pending decisions before specification begins', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '不要假设，先澄清 service-a 的范围',
    });

    const clarificationPath = path.join(
      resolution.workspace!.rootPath,
      '.workspace/clarifications/service-a/clarify-1.md',
    );
    const snapshot = await orchestrator.markClarifyBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      clarificationPath,
      'Clarification category: scope\nClarification method: deep-interview',
      'task-clarify-a',
    );

    const project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.phase).toBe('PARALLEL_CLARIFY');
    expect(project?.status).toBe('blocked');
    expect(project?.clarificationPath).toBe(clarificationPath);
    expect(project?.clarificationStatus).toBe('awaiting_decision');
    expect(project?.clarifyTaskId).toBe('task-clarify-a');
    expect(project?.recommendedCommand).toBe('tik workspace decisions');
    expect(snapshot.state?.currentPhase).toBe('FEEDBACK_ITERATION');
    expect(snapshot.state?.workspaceFeedback?.required).toBe(true);
    expect(snapshot.state?.workspaceFeedback?.nextPhase).toBe('PARALLEL_CLARIFY');
    expect(snapshot.state?.summary?.pendingClarificationProjects).toBe(1);
    expect(snapshot.state?.summary?.clarifiedProjects).toBe(0);
    expect(snapshot.state?.decisions?.[0]).toMatchObject({
      status: 'pending',
      kind: 'clarification',
      projectName: 'service-a',
      phase: 'PARALLEL_CLARIFY',
    });
  });

  it('preserves a clarifier-provided decision instead of re-synthesizing one from the blocker summary', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '不要假设，先澄清 service-a 的范围',
    });

    const suppliedDecision: WorkspaceDecisionRequest = {
      id: 'decision-clarify-1',
      status: 'pending',
      phase: 'PARALLEL_CLARIFY',
      projectName: 'service-a',
      kind: 'clarification',
      title: 'Clarify service-a before specify',
      prompt: 'Use deep-interview style clarification before moving to specify.',
      options: [
        {
          id: 'clarify-and-rerun',
          label: 'Clarify and continue to specify',
          nextPhase: 'PARALLEL_SPECIFY',
          recommended: true,
        },
      ],
      recommendedOptionId: 'clarify-and-rerun',
      allowFreeform: true,
      confidence: 'low',
      rationale: 'Provided by the clarify executor.',
      signals: ['clarify-method:deep-interview', 'clarify-category:generic'],
      createdAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
    };

    const snapshot = await orchestrator.markClarifyBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(resolution.workspace!.rootPath, '.workspace/clarifications/service-a/clarify-1.md'),
      'Clarification category: generic\nClarification method: deep-interview',
      'task-clarify-a',
      'awaiting_decision',
      suppliedDecision,
    );

    expect(snapshot.state?.decisions?.[0]).toMatchObject({
      id: 'decision-clarify-1',
      title: 'Clarify service-a before specify',
      confidence: 'low',
      rationale: 'Provided by the clarify executor.',
      signals: expect.arrayContaining(['clarify-method:deep-interview']),
    });
  });

  it('creates structured approach-choice decisions for ambiguous artifact blockers and resolves them back into feedback', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成技术规格',
    });

    const snapshot = await orchestrator.markProjectBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      'PARALLEL_SPECIFY',
      'Multiple feature specs found; unable to choose automatically: /tmp/specs/feature-a/spec.md, /tmp/specs/feature-b/spec.md',
      'task-spec-a',
    );

    const decision = snapshot.state?.decisions?.find((item) => item.status === 'pending');
    expect(decision?.kind).toBe('approach_choice');
    expect(decision?.options).toHaveLength(2);
    expect(decision?.options?.[0]?.artifactField).toBe('specPath');

    const resolved = await orchestrator.resolveDecision(
      resolution.workspace!.rootPath,
      {
        decisionId: decision!.id,
        optionId: decision!.options?.[1]?.id,
        message: 'Use the newer feature spec.',
      },
    );

    const project = resolved.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.specPath).toBe('/tmp/specs/feature-b/spec.md');
    expect(project?.recommendedCommand).toBe('tik workspace next');
    expect(resolved.state?.workspaceFeedback?.required).toBe(true);
    expect(resolved.state?.workspaceFeedback?.nextPhase).toBe('PARALLEL_SPECIFY');
    expect(resolved.state?.decisions?.find((item) => item.id === decision!.id)?.status).toBe('resolved');
  });

  it('marks clarify decisions as resolved in project state after decide', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '不要假设，先澄清 service-a 的范围',
    });

    const blocked = await orchestrator.markClarifyBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(resolution.workspace!.rootPath, '.workspace/clarifications/service-a/clarify-1.md'),
      'Clarification category: generic\nClarification method: deep-interview',
      'task-clarify-a',
    );
    const decision = blocked.state?.decisions?.[0];
    const resolved = await orchestrator.resolveDecision(
      resolution.workspace!.rootPath,
      {
        decisionId: decision!.id,
        optionId: decision!.options?.[0]?.id,
        message: '按澄清结果继续',
      },
    );

    const project = resolved.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.clarificationStatus).toBe('resolved');
    expect(project?.blockerKind).toBeUndefined();
    expect(project?.recommendedCommand).toBe('tik workspace next');
    expect(resolved.state?.workspaceFeedback?.nextPhase).toBe('PARALLEL_SPECIFY');
    expect(resolved.state?.summary?.pendingClarificationProjects).toBe(0);
    expect(resolved.state?.summary?.clarifiedProjects).toBe(1);
    expect(resolved.state?.decisions?.find((item) => item.id === decision!.id)?.status).toBe('resolved');
  });

  it('persists executionMode on completed document phases', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成技术实现计划',
    });

    const serviceA = resolution.workspace!.projects[0]!;
    const snapshot = await orchestrator.markSpecifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/spec.md'),
      'spec a',
      'task-spec-a',
      'fallback',
    );

    const project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.executionMode).toBe('fallback');
  });

  it('persists executionMode on completed ace phases', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 执行 ACE',
    });

    const serviceA = resolution.workspace!.projects[0]!;
    await orchestrator.markSpecifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/spec.md'),
      'spec a',
      'task-spec-a',
      'native',
    );
    await orchestrator.markPlanResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/plan.md'),
      'plan a',
      'task-plan-a',
      'native',
    );

    const snapshot = await orchestrator.markAceResult(
      resolution.workspace!.rootPath,
      'service-a',
      'task-ace-a',
      'completed',
      'ACE task completed',
      'native',
    );

    const project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.executionMode).toBe('native');
  });

  it('updates workflow policy after bootstrap for later workspace iterations', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 执行 ACE',
    });

    const snapshot = await orchestrator.updateWorkflowPolicy(
      resolution.workspace!.rootPath,
      { profile: 'fast-feedback' },
    );

    expect(snapshot.settings?.workflowPolicy?.profile).toBe('fast-feedback');
    expect(snapshot.settings?.workflowPolicy?.phaseBudgetsMs?.PARALLEL_SPECIFY).toBe(180_000);
    expect(snapshot.settings?.workflowPolicy?.phaseBudgetsMs?.PARALLEL_ACE).toBe(420_000);
  });

  it('preserves ace task ids and raises workspace feedback when ace fails', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 执行 ACE',
    });

    const serviceA = resolution.workspace!.projects[0]!;
    await orchestrator.markSpecifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/spec.md'),
      'spec a',
      'task-spec-a',
    );
    await orchestrator.markPlanResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/plan.md'),
      'plan a',
      'task-plan-a',
    );

    const snapshot = await orchestrator.markAceResult(
      resolution.workspace!.rootPath,
      'service-a',
      'task-ace-a',
      'failed',
      'ACE task failed',
    );

    const project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.aceTaskId).toBe('task-ace-a');
    expect(project?.taskId).toBe('task-ace-a');
    expect(project?.workflowContract).toBe('ACE_SUBTASK');
    expect(project?.recommendedCommand).toBe('tik workspace decisions');
    expect(snapshot.state?.currentPhase).toBe('FEEDBACK_ITERATION');
    expect(snapshot.state?.workspaceFeedback?.required).toBe(true);
    expect(snapshot.state?.workspaceFeedback?.nextPhase).toBe('PARALLEL_ACE');
  });

  it('classifies timed-out ACE blockers as execution failures with actionable retry guidance', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 执行 ACE',
    });

    const serviceA = resolution.workspace!.projects[0]!;
    await orchestrator.markSpecifyResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/spec.md'),
      'spec a',
      'task-spec-a',
    );
    await orchestrator.markPlanResult(
      resolution.workspace!.rootPath,
      'service-a',
      path.join(serviceA.path, '.specify/specs/plan.md'),
      'plan a',
      'task-plan-a',
    );

    const snapshot = await orchestrator.markProjectBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      'PARALLEL_ACE',
      'ACE execution failed: Codex exec fallback did not finish within 90s.',
      'task-ace-a',
    );

    const project = snapshot.state?.projects?.find((item) => item.projectName === 'service-a');
    expect(project?.blockerKind).toBe('EXECUTION_FAILED');
    expect(project?.recommendedCommand).toBe('tik workspace decisions');
  });

  it('uses a cross-instance lock so concurrent state mutations do not lose updates', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestratorA = new WorkspaceOrchestrator();
    const orchestratorB = new WorkspaceOrchestrator();
    await orchestratorA.bootstrap({
      resolution,
      demand: '给 service-a 生成 spec，并给 service-b 生成 spec',
    });

    const serviceA = resolution.workspace!.projects[0]!;
    const serviceB = resolution.workspace!.projects[1]!;

    await Promise.all([
      orchestratorA.markSpecifyResult(
        resolution.workspace!.rootPath,
        'service-a',
        path.join(serviceA.path, '.specify/specs/spec.md'),
        'spec a',
        'task-spec-a',
      ),
      orchestratorB.markSpecifyResult(
        resolution.workspace!.rootPath,
        'service-b',
        path.join(serviceB.path, '.specify/specs/spec.md'),
        'spec b',
        'task-spec-b',
      ),
    ]);

    const statePath = path.join(resolution.workspace!.rootPath, '.workspace', 'state.json');
    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    const projects = persisted.projects as Array<{ projectName: string; status: string; specTaskId?: string }>;
    expect(projects.find((project) => project.projectName === 'service-a')?.specTaskId).toBe('task-spec-a');
    expect(projects.find((project) => project.projectName === 'service-b')?.specTaskId).toBe('task-spec-b');
    expect(persisted.currentPhase).toBe('PARALLEL_PLAN');
  });
});
