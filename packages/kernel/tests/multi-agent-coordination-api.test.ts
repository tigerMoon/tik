import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunCompletion, AgentRuntimeRunner, PreparedRun } from '../src/agent-runners/agent-runtime-runner.js';
import { EventBus } from '../src/event-bus.js';
import { MultiAgentNativeRuntimeLauncher } from '../src/multi-agent/native-runtime-launcher.js';
import { FileMultiAgentWorkflowStore } from '../src/multi-agent/workflow-store.js';
import { createServer } from '../src/server.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('multi-agent coordination API', () => {
  it('preflights environment capabilities without creating durable workflow state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root, { runtimeRunners: {} });
    servers.push(server);

    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/preflight',
      payload: {
        mode: 'review',
        headSha: 'head-1',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'tik',
          effectiveProjectPath: root,
          sourceProjectPath: root,
          worktreeKind: 'root',
        },
        clientCapabilities: {
          codexHookAttestation: false,
          codexCli: true,
          claudeCode: true,
          claudeQuestionerPlugin: true,
          packageManagerSatisfied: true,
        },
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: 'preflight_failed' },
      report: { accepted: false, mode: 'review' },
    });

    const workflows = await server.inject({ method: 'GET', url: '/api/v1/multi-agent/workflows' });
    expect(workflows.json().workflows).toEqual([]);
  });

  it('launches Tik-owned Codex native threads with server attestation and role-specific sandboxes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const started: PreparedRun[] = [];
    const codex = fakeRuntimeRunner('codex', started, { threadPrefix: 'codex-thread' });
    const claude = fakeRuntimeRunner('claude-code', []);
    const server = await createTestServer(root, { runtimeRunners: { codex, 'claude-code': claude } });
    servers.push(server);

    const preflight = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/preflight',
      payload: {
        mode: 'implementation',
        headSha: 'head-1',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          effectiveProjectPath: root,
          sourceProjectPath: root,
          worktreeKind: 'root',
        },
        clientCapabilities: {
          codexHookAttestation: false,
          codexCli: true,
          claudeCode: true,
          claudeQuestionerPlugin: true,
          packageManagerSatisfied: true,
        },
      },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json().report.checks).toContainEqual(expect.objectContaining({
      id: 'native_subagent_runtime',
      passed: true,
    }));

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-native-launch',
        goal: 'Launch native Codex roles',
        headSha: 'head-1',
        metadata: { parentCodexThreadId: 'parent-thread' },
      },
    });

    for (const [role, runner] of [['executor', 'codex'], ['evaluator', 'codex-evaluator']] as const) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/multi-agent/workflows/wf-native-launch/agent-invocations/native-launch',
        payload: {
          id: `inv-${role}`,
          role,
          runner,
          promptContract: `${role}.v1`,
          headSha: 'head-1',
          readonlyPolicy: role === 'evaluator' ? { enforced: true, violations: [] } : undefined,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        invocation: {
          id: `inv-${role}`,
          status: 'started',
          nativeRuntimeOwned: true,
          cleanContext: true,
          contextBundleHash: expect.stringMatching(/^sha256:/),
          estimatedContextTokens: expect.any(Number),
          hookAttested: true,
          parentThreadId: 'parent-thread',
          runtimeAttestation: {
            source: 'codex-subagent-runtime',
            actualSubagentThreadId: `codex-thread-inv-${role}`,
          },
        },
        runtime: { status: 'running', runtimeRef: `codex-thread-inv-${role}` },
      });
      expect(response.json().invocation).not.toHaveProperty('attestationToken');
    }

    expect(started).toHaveLength(2);
    expect(started[0].allowWrites).toBe(true);
    expect(started[1].allowWrites).toBe(true);
    expect(started[0]).toMatchObject({ cleanContext: true, contextTokenBudget: 24_000 });
    expect(started[1]).toMatchObject({ cleanContext: true, contextTokenBudget: 16_000 });

    const oversized = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-native-launch/agent-invocations/native-launch',
      payload: {
        id: 'inv-oversized-context',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        headSha: 'head-1',
        prompt: 'x'.repeat(120_000),
      },
    });
    expect(oversized.statusCode).toBe(409);
    expect(oversized.json().error).toMatchObject({ code: 'context_budget_exceeded' });
    expect(started).toHaveLength(2);
  });

  it('rejects dirty committed evidence before creating a native Evaluator invocation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-committed-evidence-'));
    tempDirs.push(root);
    const { baseSha, headSha } = await createCommittedEvidenceRepo(root);
    const codexRuns: PreparedRun[] = [];
    const server = await createTestServer(root, {
      runtimeRunners: {
        codex: fakeRuntimeRunner('codex', codexRuns, {
          threadPrefix: 'codex-thread',
          completion: Promise.resolve({ status: 'completed', result: { content: '{"verdict":"pass"}' } }),
          onStart: async (prepared) => {
            if (prepared.runId === 'inv-evaluator-generated') {
              await fs.mkdir(path.join(prepared.cwd, 'module/target'), { recursive: true });
              await fs.writeFile(path.join(prepared.cwd, 'module/target/report.txt'), 'generated\n', 'utf-8');
              await fs.writeFile(path.join(prepared.cwd, '.risk.env'), 'RISK=checked\n', 'utf-8');
            }
            if (prepared.runId === 'inv-evaluator-custom-artifact') {
              await fs.mkdir(path.join(prepared.cwd, 'custom-artifacts'), { recursive: true });
              await fs.writeFile(path.join(prepared.cwd, 'custom-artifacts/result.json'), '{}\n', 'utf-8');
            }
            if (prepared.runId === 'inv-evaluator-source-mutation') {
              await fs.writeFile(
                path.join(prepared.cwd, 'src/main/java/example/Example.java'),
                'package example; class Example { int value = 99; }\n',
                'utf-8',
              );
            }
          },
        }),
        'claude-code': fakeRuntimeRunner('claude-code', []),
      },
    });
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-committed-evidence',
        goal: 'Reject stale or uncommitted evaluator evidence',
        baseRef: baseSha,
        headSha,
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'fixture',
          effectiveProjectPath: root,
          sourceProjectPath: root,
          worktreeKind: 'root',
        },
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/task-graph',
      payload: { graph: buildTaskGraph('wf-committed-evidence', 1, [{ id: 'st-api', dependsOn: [] }]) },
    });
    await acceptContractForSubtask(server, 'wf-committed-evidence', 'st-api', headSha, ['src/main/java/example/**']);
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/evidence',
      payload: {
        id: 'ev-committed-implementation',
        kind: 'implementation',
        title: 'Committed implementation evidence',
        subtaskId: 'st-api',
        headSha,
        payload: {
          observedChangedFiles: [{ path: 'src/main/java/example/Example.java', changeType: 'modified' }],
        },
      },
    });

    const launchPayload = {
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      headSha,
      validationCommands: [
        'mvn test -Dtest=ExampleTest -Dsurefire.failIfNoSpecifiedTests=true',
      ],
      readonlyPolicy: { enforced: true, violations: [] },
    };
    const accepted = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/native-launch',
      payload: { id: 'inv-evaluator-clean', ...launchPayload },
    });
    expect(accepted.statusCode).toBe(200);
    expect(codexRuns).toHaveLength(1);
    expect(codexRuns[0].cwd).not.toBe(root);
    expect(codexRuns[0].allowWrites).toBe(true);

    await fs.writeFile(path.join(root, 'src/main/java/example/Example.java'), 'package example; class Example { int value = 3; }\n', 'utf-8');
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/native-launch',
      payload: { id: 'inv-evaluator-dirty', ...launchPayload },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({ code: 'committed_evidence_invalid' });
    expect(codexRuns).toHaveLength(1);

    await fs.writeFile(path.join(root, 'src/main/java/example/Example.java'), 'package example; class Example { int value = 2; }\n', 'utf-8');
    const generated = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/native-launch',
      payload: { id: 'inv-evaluator-generated', ...launchPayload },
    });
    expect(generated.statusCode).toBe(200);
    await waitForCondition(async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/inv-evaluator-generated',
      });
      return response.json().invocation.status === 'completed';
    });
    const generatedInvocation = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/inv-evaluator-generated',
    });
    expect(generatedInvocation.json().invocation.readonlyPolicy).toMatchObject({
      enforced: true,
      violations: [],
      workspaceFingerprintBefore: expect.stringMatching(/^sha256:/),
      workspaceFingerprintAfter: expect.stringMatching(/^sha256:/),
    });

    const customArtifact = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/native-launch',
      payload: {
        id: 'inv-evaluator-custom-artifact',
        ...launchPayload,
        allowedPaths: ['custom-artifacts/'],
      },
    });
    expect(customArtifact.statusCode).toBe(200);
    await waitForCondition(async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/inv-evaluator-custom-artifact',
      });
      return response.json().invocation.status === 'completed';
    });
    const customInvocation = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/inv-evaluator-custom-artifact',
    });
    expect(customInvocation.json().invocation.readonlyPolicy).toMatchObject({
      enforced: true,
      violations: [],
    });

    const sourceMutation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/native-launch',
      payload: { id: 'inv-evaluator-source-mutation', ...launchPayload },
    });
    expect(sourceMutation.statusCode).toBe(200);
    await waitForCondition(async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/inv-evaluator-source-mutation',
      });
      return response.json().invocation.status === 'failed';
    });
    const mutatedInvocation = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-committed-evidence/agent-invocations/inv-evaluator-source-mutation',
    });
    expect(mutatedInvocation.json().invocation.readonlyPolicy).toMatchObject({
      enforced: false,
      violations: expect.arrayContaining([
        'tracked_source_changed',
        'forbidden_write:src/main/java/example/Example.java',
      ]),
    });
  });

  it('records implementation evidence from a completed Tik-owned invocation without exposing a token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const codex = fakeRuntimeRunner('codex', [], {
      threadPrefix: 'codex-thread',
      completion: Promise.resolve({ status: 'completed', result: { content: 'implemented' } }),
    });
    const server = await createTestServer(root, {
      runtimeRunners: { codex, 'claude-code': fakeRuntimeRunner('claude-code', []) },
    });
    servers.push(server);
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-native-evidence', goal: 'Record native evidence', headSha: 'head-1' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-native-evidence/task-graph',
      payload: { graph: buildTaskGraph('wf-native-evidence', 1, [{ id: 'st-api', dependsOn: [] }]) },
    });
    await acceptContractForSubtask(server, 'wf-native-evidence', 'st-api', 'head-1');

    const launched = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-native-evidence/agent-invocations/native-launch',
      payload: {
        id: 'inv-native-builder',
        subtaskId: 'st-api',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        headSha: 'head-1',
        allowedPaths: ['packages/kernel/src'],
      },
    });
    expect(launched.statusCode).toBe(200);
    await waitForCondition(async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/multi-agent/workflows/wf-native-evidence/agent-invocations/inv-native-builder',
      });
      return response.statusCode === 200 && response.json().invocation?.status === 'completed';
    });

    const mismatchedLink = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-native-evidence/agent-invocations/inv-native-builder/native-result',
      payload: { headSha: 'different-head' },
    });
    expect(mismatchedLink.statusCode).toBe(409);
    expect(mismatchedLink.json().error).toMatchObject({ code: 'head_sha_mismatch' });

    const recorded = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-native-evidence/actions/execute-subtask',
      headers: { 'if-match': 'none' },
      payload: {
        decision: buildDecision('wf-native-evidence', {
          id: 'dec-native-evidence',
          action: 'record_implementation',
          subtaskId: 'st-api',
          reason: 'Record native Builder evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
        invocation: {
          id: 'inv-native-builder',
          status: 'completed',
          headSha: 'head-1',
          evidenceRefs: ['ev-native-implementation'],
        },
        evidence: {
          id: 'ev-native-implementation',
          kind: 'implementation',
          title: 'Native implementation',
          subtaskId: 'st-api',
          headSha: 'head-1',
          payload: {
            observedChangedFiles: [{ path: 'packages/kernel/src/server.ts', changeType: 'modified' }],
          },
        },
      },
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toMatchObject({
      invocation: {
        id: 'inv-native-builder',
        status: 'completed',
        evidenceRefs: ['ev-native-implementation'],
        runtimeAttestation: { source: 'codex-subagent-runtime' },
      },
      subtask: { status: 'implemented' },
      guard: { accepted: true },
    });
  });

  it('launches Questioner with a server-only token injected into the Claude runtime', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const claudeRuns: PreparedRun[] = [];
    const server = await createTestServer(root, {
      runtimeRunners: {
        codex: fakeRuntimeRunner('codex', [], { threadPrefix: 'codex-thread' }),
        'claude-code': fakeRuntimeRunner('claude-code', claudeRuns, { pid: 4242 }),
      },
    });
    servers.push(server);
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-native-questioner', goal: 'Launch Questioner', headSha: 'head-1' },
    });

    const launched = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-native-questioner/questioner-runs/native-launch',
      payload: {
        id: 'qr-native',
        invocationId: 'inv-questioner-native',
        intent: 'question_requirement',
        headSha: 'head-1',
        runtimeAudit: { gitStatusBefore: 'forged-client-status' },
      },
    });
    expect(launched.statusCode).toBe(200);
    expect(launched.json()).toMatchObject({
      questionerRunId: 'qr-native',
      invocation: { id: 'inv-questioner-native', status: 'started', nativeRuntimeOwned: true },
      runtime: { status: 'running', runtimeRef: 'pid:4242' },
    });
    expect(launched.json()).not.toHaveProperty('token');
    expect(claudeRuns).toHaveLength(1);
    expect(claudeRuns[0].timeoutMs).toBe(30 * 60 * 1000);
    expect(claudeRuns[0].cwd).not.toBe(root);
    expect(claudeRuns[0].env?.TIK_QUESTIONER_TOKEN).toMatch(/^tqr_/);
    expect(claudeRuns[0].env?.TIK_QUESTIONER_CONTEXT_URL).toContain('/api/v1/multi-agent/workflows/wf-native-questioner/questioner-runs/qr-native/context');
    expect(JSON.stringify(launched.json())).not.toContain(claudeRuns[0].env?.TIK_QUESTIONER_TOKEN);
    expect(launched.json().questionerRun.readonlyAudit).toMatchObject({
      gitStatusBefore: '',
      workspaceFingerprintBefore: expect.any(String),
    });
  });

  it('does not report a rejected Questioner retry as still running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const claudeRuns: PreparedRun[] = [];
    const server = await createTestServer(root, {
      runtimeRunners: {
        codex: fakeRuntimeRunner('codex', []),
        'claude-code': fakeRuntimeRunner('claude-code', claudeRuns, {
          completion: Promise.resolve({ status: 'failed', error: 'runtime failed' }),
          pid: 4243,
        }),
      },
    });
    servers.push(server);
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-rejected-questioner', goal: 'Retry Questioner', headSha: 'head-1' },
    });
    const payload = {
      id: 'qr-rejected',
      invocationId: 'inv-questioner-rejected',
      intent: 'question_requirement',
      headSha: 'head-1',
    };
    const launched = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-rejected-questioner/questioner-runs/native-launch',
      payload,
    });
    expect(launched.statusCode).toBe(200);
    await waitForCondition(async () => {
      const bundle = await server.inject({
        method: 'GET',
        url: '/api/v1/multi-agent/workflows/wf-rejected-questioner',
      });
      return bundle.json().questionerRuns.some((run: { id: string; status: string }) => run.id === 'qr-rejected' && run.status === 'rejected');
    });

    const retry = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-rejected-questioner/questioner-runs/native-launch',
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      questionerRun: { id: 'qr-rejected', status: 'rejected' },
      runtime: { status: 'failed' },
    });
    expect(claudeRuns).toHaveLength(1);
  });

  it('reserves native invocation ids atomically under concurrent launch requests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const codexRuns: PreparedRun[] = [];
    const server = await createTestServer(root, {
      runtimeRunners: {
        codex: fakeRuntimeRunner('codex', codexRuns, { threadPrefix: 'codex-thread' }),
        'claude-code': fakeRuntimeRunner('claude-code', []),
      },
    });
    servers.push(server);
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-native-concurrent', goal: 'Launch once', headSha: 'head-1' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-native-concurrent/task-graph',
      payload: { graph: buildTaskGraph('wf-native-concurrent', 1, [{ id: 'st-api', dependsOn: [] }]) },
    });
    const launch = () => server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-native-concurrent/agent-invocations/native-launch',
      payload: {
        id: 'inv-native-once',
        subtaskId: 'st-api',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        headSha: 'head-1',
      },
    });

    const responses = await Promise.all([launch(), launch()]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(codexRuns).toHaveLength(1);
    const retry = await launch();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ invocation: { id: 'inv-native-once' } });
    expect(codexRuns).toHaveLength(1);
  });

  it('does not report an orphaned Tik-owned created invocation as running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-owned-created-'));
    tempDirs.push(root);
    const store = new FileMultiAgentWorkflowStore(root);
    await store.createWorkflow({ id: 'wf-owned-created-retry', goal: 'Recover native launch', headSha: 'head-1' });
    const request = {
      id: 'inv-owned-created-retry',
      role: 'executor' as const,
      runner: 'codex' as const,
      promptContract: 'codex-builder.v1',
      headSha: 'head-1',
    };
    await store.createInvocation('wf-owned-created-retry', { ...request, nativeRuntimeOwned: true });
    const started: PreparedRun[] = [];
    const launcher = new MultiAgentNativeRuntimeLauncher(
      store,
      root,
      'http://127.0.0.1:3300/api',
      {
        codex: fakeRuntimeRunner('codex', started),
        'claude-code': fakeRuntimeRunner('claude-code', []),
      },
    );

    await expect(launcher.launchCodexInvocation('wf-owned-created-retry', { invocation: request }))
      .rejects.toMatchObject({ code: 'native_runtime_not_started' });
    expect(started).toHaveLength(0);
  });

  it('times out owned created invocations while preserving hook-created compatibility records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-created-timeout-'));
    tempDirs.push(root);
    const store = new FileMultiAgentWorkflowStore(root);
    await store.createWorkflow({
      id: 'wf-created-timeout',
      goal: 'Recover stalled invocations',
      headSha: 'head-1',
      policy: { stalledInvocationTimeoutMs: 1 },
    });
    await store.createInvocation('wf-created-timeout', {
      id: 'inv-owned-created',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      nativeRuntimeOwned: true,
    });
    await store.createInvocation('wf-created-timeout', {
      id: 'inv-hook-created',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
    });
    await store.createInvocation('wf-created-timeout', {
      id: 'inv-started',
      role: 'questioner',
      runner: 'claude-code',
      promptContract: 'claude-questioner.v2',
    });
    await store.updateInvocation('wf-created-timeout', 'inv-started', { status: 'started' });

    const reconciled = await store.reconcileStalledInvocations('wf-created-timeout', {
      now: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(reconciled.stalled.map((invocation) => invocation.id).sort()).toEqual([
      'inv-owned-created',
      'inv-started',
    ]);
    expect((await store.readInvocation('wf-created-timeout', 'inv-owned-created'))?.status).toBe('failed');
    expect((await store.readInvocation('wf-created-timeout', 'inv-started'))?.status).toBe('failed');
    expect((await store.readInvocation('wf-created-timeout', 'inv-hook-created'))?.status).toBe('created');
  });

  it('fails owned created invocations on restart without touching hook-created records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-created-restart-'));
    tempDirs.push(root);
    const store = new FileMultiAgentWorkflowStore(root);
    await store.createWorkflow({ id: 'wf-created-restart', goal: 'Recover after restart', headSha: 'head-1' });
    for (const [id, nativeRuntimeOwned] of [
      ['inv-owned-created', true],
      ['inv-hook-created', false],
    ] as const) {
      await store.createInvocation('wf-created-restart', {
        id,
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        nativeRuntimeOwned,
      });
    }

    const server = await createTestServer(root, { runtimeRunners: {} });
    servers.push(server);
    const bundle = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-created-restart',
    });

    expect(bundle.statusCode).toBe(200);
    expect(bundle.json().invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inv-owned-created', status: 'failed', nativeRuntimeOwned: true }),
      expect.objectContaining({ id: 'inv-hook-created', status: 'created', nativeRuntimeOwned: false }),
    ]));
  });

  it('serves a workflow bundle from root and review workbench task references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    await fs.mkdir(path.join(root, 'repo'), { recursive: true });
    tempDirs.push(root);
    const { server, workbench } = await createTestServerWithWorkbench(root);
    servers.push(server);

    const rootTask = await workbench.createTask({
      title: 'Workflow root task',
      goal: 'Show workflow evidence from the task page.',
      status: 'in_progress',
      identifier: 'TIK-ROOT',
      labels: ['multi-agent'],
    }, 'task-root');
    const reviewTask = await workbench.createTask({
      title: 'Workflow review task',
      goal: 'Review workflow evidence.',
      status: 'in_review',
      identifier: 'TIK-REVIEW',
      labels: ['external-claude-review'],
      agentLoop: {
        kind: 'human_review',
        phase: 'needs_human_review',
        rootTaskId: 'wf-task-detail',
        round: 1,
        maxRounds: 3,
        idempotencyKey: 'review:wf-task-detail:r1',
        changeRequest: {
          scm: 'internal',
          repo: 'repo',
          id: 'wf-task-detail:abc123',
          type: 'internal_review',
          title: 'Review workflow evidence',
          baseRef: 'main',
          headRef: 'codex/workflow-evidence',
          headSha: 'abc123',
        },
      },
    }, 'task-review');

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-task-detail',
        goal: 'Expose workflow evidence on task detail',
        rootTaskId: rootTask.id,
        repo: 'repo',
        baseRef: 'main',
        headRef: 'codex/workflow-evidence',
        headSha: 'abc123',
        metadata: {
          deployToken: 'workflow-secret',
          safeLabel: 'workflow-visible',
        },
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'repo',
          effectiveProjectPath: path.join(root, 'repo'),
          sourceProjectPath: path.join(root, 'repo'),
          worktreeKind: 'root',
        },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().rootTask).toMatchObject({
      id: rootTask.id,
      labels: expect.arrayContaining(['multi-agent', 'workflow-root']),
    });

    const taskGraph = buildTaskGraph('wf-task-detail', 1, [{ id: 'st-api', dependsOn: [] }]);
    taskGraph.risks = ['credential should-not-leak in task graph risk'];
    const putGraph = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-task-detail/task-graph',
      payload: { graph: taskGraph },
    });
    expect(putGraph.statusCode).toBe(200);

    const evidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-task-detail/evidence',
      payload: {
        id: 'ev-task-detail',
        kind: 'validation',
        title: 'Task detail API tests',
        summary: 'The workflow bundle is available from task detail.',
        subtaskId: 'st-api',
        command: 'pnpm --filter @tik/kernel test -- multi-agent-coordination-api.test.ts',
        passed: true,
        headSha: 'abc123',
        payload: {
          details: {
            apiKey: 'should-not-leak',
            safeNote: 'visible evidence detail',
          },
        },
      },
    });
    expect(evidence.statusCode).toBe(200);

    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-task-detail/agent-invocations',
      payload: {
        id: 'inv-evaluator',
        role: 'evaluator',
        provider: 'codex',
        status: 'pending',
        createdBy: 'codex-workflow',
        promptSummary: 'Verify task detail workflow evidence.',
        attestationToken: 'secret-token',
      },
    });
    expect(invocation.statusCode).toBe(200);

    const fromRootId = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${rootTask.id}/multi-agent-workflow`,
    });
    expect(fromRootId.statusCode).toBe(200);
    expect(fromRootId.json()).toMatchObject({
      workflow: {
        id: 'wf-task-detail',
        rootTaskId: rootTask.id,
      },
      taskGraph,
      subtasks: {
        'st-api': { status: 'ready' },
      },
      evidence: [
        {
          id: 'ev-task-detail',
          kind: 'validation',
          subtaskId: 'st-api',
        },
      ],
    });
    expect(fromRootId.json().invocations[0]).not.toHaveProperty('attestationToken');
    expect(fromRootId.json().workflow.metadata).toEqual({
      deployToken: '[redacted]',
      safeLabel: 'workflow-visible',
    });
    expect(fromRootId.json().taskGraph.risks).toEqual(['credential should-not-leak in task graph risk']);
    expect(fromRootId.json().evidence[0].payload.details).toEqual({
      apiKey: '[redacted]',
      safeNote: 'visible evidence detail',
    });

    const workflowList = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows',
    });
    expect(workflowList.statusCode).toBe(200);
    expect(workflowList.json().workflows).toEqual([
      expect.objectContaining({
        id: 'wf-task-detail',
        rootTaskId: rootTask.id,
      }),
    ]);
    expect(workflowList.json().workflows[0].metadata).toEqual({
      deployToken: '[redacted]',
      safeLabel: 'workflow-visible',
    });

    const fromRootIdentifier = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/TIK-ROOT/multi-agent-workflow',
    });
    expect(fromRootIdentifier.statusCode).toBe(200);
    expect(fromRootIdentifier.json().workflow.id).toBe('wf-task-detail');

    const fromReviewTask = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${reviewTask.id}/multi-agent-workflow`,
    });
    expect(fromReviewTask.statusCode).toBe(200);
    expect(fromReviewTask.json().workflow.id).toBe('wf-task-detail');

    const missing = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/no-workflow/multi-agent-workflow',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('workflow_not_found');
  });

  it('creates and repairs workbench root tasks for standalone workflows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    const repoPath = path.join(root, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    tempDirs.push(root);
    const { server, workbench } = await createTestServerWithWorkbench(root);
    servers.push(server);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-standalone-root-task',
        goal: 'Review standalone workflow root task creation',
        repo: 'repo',
        baseRef: 'main',
        headRef: 'feature/workflow-root-task',
        headSha: 'abc123',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'repo',
          effectiveProjectPath: repoPath,
          sourceProjectPath: repoPath,
          worktreeKind: 'root',
        },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      workflow: {
        id: 'wf-standalone-root-task',
        rootTaskId: 'wf-standalone-root-task',
      },
      rootTask: {
        id: 'wf-standalone-root-task',
        status: 'in_progress',
        labels: expect.arrayContaining(['multi-agent', 'workflow-root']),
        sourceUrl: 'tik://multi-agent/workflows/wf-standalone-root-task',
      },
    });

    const tasks = await workbench.listTasks();
    expect(tasks.find((task) => task.id === 'wf-standalone-root-task')).toMatchObject({
      title: 'Review standalone workflow root task creation',
      workspaceBinding: {
        effectiveProjectPath: repoPath,
      },
    });

    const bundleFromRootTask = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/wf-standalone-root-task/multi-agent-workflow',
    });
    expect(bundleFromRootTask.statusCode).toBe(200);
    expect(bundleFromRootTask.json().workflow.id).toBe('wf-standalone-root-task');

    const repaired = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-standalone-root-task/root-task/repair',
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().rootTask.id).toBe('wf-standalone-root-task');
    expect(repaired.json().rootTask.status).toBe('in_progress');
    expect(await workbench.listTasks()).toHaveLength(1);
  });

  it('syncs terminal workflow decisions onto the workbench root task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const { server, workbench } = await createTestServerWithWorkbench(root);
    servers.push(server);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-root-task-terminal-sync',
        goal: 'Sync terminal workflow status',
        rootTaskId: 'root-terminal-sync',
        headSha: 'head-1',
      },
    });
    expect(created.statusCode).toBe(200);
    expect((await workbench.readTask('root-terminal-sync'))?.status).toBe('in_progress');

    const abort = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-root-task-terminal-sync/decisions',
      payload: {
        decision: buildDecision('wf-root-task-terminal-sync', {
          id: 'dec-abort-terminal-sync',
          action: 'abort_workflow',
          reason: 'Stop the workflow.',
        }),
      },
    });
    expect(abort.statusCode).toBe(200);
    expect(abort.json()).toMatchObject({
      workflow: {
        id: 'wf-root-task-terminal-sync',
        status: 'aborted',
      },
      rootTask: {
        id: 'root-terminal-sync',
        status: 'cancelled',
      },
    });
    expect((await workbench.readTask('root-terminal-sync'))?.status).toBe('cancelled');
  });

  it('persists workflow state, task graph, decisions, evidence, and timeline without choosing policy actions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    await fs.mkdir(path.join(root, 'repo'), { recursive: true });
    tempDirs.push(root);
    const { server, workbench } = await createTestServerWithWorkbench(root);
    servers.push(server);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-auth',
        goal: 'Implement auth flow',
        rootTaskId: 'root-auth',
        repo: 'repo',
        baseRef: 'main',
        headRef: 'codex/auth',
        headSha: 'abc123',
        maxRounds: 2,
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'repo',
          effectiveProjectPath: path.join(root, 'repo'),
          sourceProjectPath: path.join(root, 'repo'),
          worktreeKind: 'root',
        },
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().workflow).toMatchObject({
      id: 'wf-auth',
      driver: 'codex-workflow',
      revision: 1,
      status: 'active',
      goal: 'Implement auth flow',
      rootTaskId: 'root-auth',
      currentHeadSha: 'abc123',
      maxRounds: 2,
    });
    expect(created.json().rootTask).toMatchObject({
      id: 'root-auth',
      status: 'in_progress',
    });
    const immediatelyReadWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-auth',
    });
    expect(immediatelyReadWorkflow.statusCode).toBe(200);
    expect(immediatelyReadWorkflow.json().workflow.revision).toBe(created.json().workflow.revision);

    const taskGraph = {
      workflowId: 'wf-auth',
      version: 1,
      createdBy: 'claude-code',
      risks: ['Auth touches shared middleware.'],
      globalAcceptanceCriteria: ['All auth tests pass.'],
      finalValidationCommands: ['pnpm --filter @tik/kernel test'],
      subtasks: [
        {
          id: 'st-api',
          title: 'Add auth API',
          goal: 'Expose auth endpoints.',
          dependsOn: [],
          allowedPaths: ['packages/kernel/src'],
          acceptanceCriteria: ['API routes exist.'],
          validationCommands: ['pnpm --filter @tik/kernel test'],
          reviewFocus: ['route guards'],
          assignedExecutor: 'codex',
          assignedReviewer: 'claude-code',
        },
        {
          id: 'st-ui',
          title: 'Connect UI',
          goal: 'Wire dashboard auth state.',
          dependsOn: ['st-api'],
          allowedPaths: ['packages/dashboard/src'],
          acceptanceCriteria: ['Dashboard reacts to auth state.'],
          validationCommands: ['pnpm --filter @tik/dashboard typecheck'],
          reviewFocus: ['state transitions'],
          assignedExecutor: 'codex',
          assignedReviewer: 'claude-code',
        },
      ],
    };

    const putGraph = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-auth/task-graph',
      payload: { graph: taskGraph },
    });
    expect(putGraph.statusCode).toBe(200);
    expect(putGraph.json().subtasks).toMatchObject({
      'st-api': { status: 'ready', fixRound: 0 },
      'st-ui': { status: 'pending', fixRound: 0 },
    });

    const validationEvidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-auth/evidence',
      payload: {
        id: 'ev-validation',
        kind: 'validation',
        title: 'Kernel targeted tests',
        summary: 'Targeted tests passed.',
        subtaskId: 'st-api',
        command: 'pnpm --filter @tik/kernel test',
        passed: true,
        headSha: 'abc123',
      },
    });
    expect(validationEvidence.statusCode).toBe(200);
    expect((await workbench.readTask('root-auth'))?.status).toBe('in_progress');

    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'implemented',
        evidenceRefs: ['ev-validation'],
        implementationHeadSha: 'abc123',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'validated',
        validationRunIds: ['ev-validation'],
        lastValidatedHeadSha: 'abc123',
      },
    });

    const decision = {
      id: 'dec-human-review-api',
      workflowId: 'wf-auth',
      rootTaskId: 'root-auth',
      subtaskId: 'st-api',
      decidedBy: 'codex-workflow',
      decidedAt: '2026-06-30T00:00:00.000Z',
      action: 'request_human_review',
      reason: 'Escalate validated evidence for human review.',
      evidenceRefs: ['ev-validation'],
      inputs: {
        currentHeadSha: 'abc123',
      },
      expectedTikMutation: {
        taskStatus: 'human_review_required',
      },
      confidence: 0.91,
    };

    const recordDecision = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-auth/decisions',
      payload: { decision },
    });
    expect(recordDecision.statusCode).toBe(200);
    expect(recordDecision.json()).toMatchObject({
      guard: { accepted: true, code: 'ok' },
      decision,
      workflow: {
        id: 'wf-auth',
        lastDecisionId: 'dec-human-review-api',
      },
      rootTask: {
        id: 'root-auth',
        status: 'in_review',
      },
    });

    const updateSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'human_review_required',
        evidenceRefs: ['ev-validation'],
        lastValidatedHeadSha: 'abc123',
      },
    });
    expect(updateSubtask.statusCode).toBe(200);
    expect(updateSubtask.json().subtask).toMatchObject({
      subtaskId: 'st-api',
      status: 'human_review_required',
      evidenceRefs: ['ev-validation'],
      lastValidatedHeadSha: 'abc123',
    });
    expect(updateSubtask.json().rootTask).toMatchObject({
      id: 'root-auth',
      status: 'in_review',
    });

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-auth',
    });
    expect(readWorkflow.statusCode).toBe(200);
    expect(readWorkflow.json()).toMatchObject({
      workflow: {
        id: 'wf-auth',
        driver: 'codex-workflow',
        status: 'active',
      },
      taskGraph,
      subtasks: {
        'st-api': { status: 'human_review_required' },
        'st-ui': { status: 'pending' },
      },
    });
    expect(readWorkflow.json().decisions).toHaveLength(1);
    expect(readWorkflow.json().evidence).toHaveLength(1);

    const timeline = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-auth/timeline',
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
      'workflow.created',
      'task_graph.created',
      'evidence.recorded',
      'decision.recorded',
      'subtask.updated',
    ]));

    const storedWorkflow = JSON.parse(
      await fs.readFile(path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-auth', 'workflow.json'), 'utf-8'),
    );
    expect(storedWorkflow.driver).toBe('codex-workflow');
  });

  it('rejects unsafe decision records with guard results instead of inventing a next policy action', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-guard',
        goal: 'Review round guard',
        rootTaskId: 'root-guard',
        headSha: 'head-1',
        maxRounds: 1,
      },
    });

    const missingEvidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-guard/decisions',
      payload: {
        decision: {
          id: 'dec-missing-evidence',
          workflowId: 'wf-guard',
          rootTaskId: 'root-guard',
          decidedBy: 'codex-workflow',
          decidedAt: '2026-06-30T00:00:00.000Z',
          action: 'complete_workflow',
          reason: 'Pretend completion.',
          evidenceRefs: ['ev-does-not-exist'],
        },
      },
    });

    expect(missingEvidence.statusCode).toBe(409);
    expect(missingEvidence.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'missing_evidence',
      },
    });

    const removedLegacyAction = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-guard/decisions',
      payload: {
        decision: {
          id: 'dec-legacy-review-action',
          workflowId: 'wf-guard',
          rootTaskId: 'root-guard',
          decidedBy: 'codex-workflow',
          decidedAt: '2026-06-30T00:00:00.000Z',
          action: 'request_re_review',
          reason: 'Legacy multi-agent review action should be gone.',
          evidenceRefs: [],
        },
      },
    });

    expect(removedLegacyAction.statusCode).toBe(409);
    expect(removedLegacyAction.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'invalid_transition',
      },
    });
    expect(removedLegacyAction.json().guard.message).toMatch(/Unsupported workflow decision action/);
  });

  it('preflights workflow decisions without appending decision history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-preflight',
        goal: 'Preflight decisions',
        rootTaskId: 'root-preflight',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-preflight/task-graph',
      payload: {
        graph: buildTaskGraph('wf-preflight', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await acceptContractForSubtask(server, 'wf-preflight', 'st-api', 'head-1');

    const decision = buildDecision('wf-preflight', {
      id: 'dec-preflight-execute',
      action: 'execute_subtask',
      subtaskId: 'st-api',
      reason: 'Preflight execution.',
      inputs: { currentHeadSha: 'head-1' },
    });
    const preflight = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-preflight/decisions/preflight',
      payload: { decision },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      guard: { accepted: true, code: 'ok' },
      decision,
    });

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-preflight',
    });
    expect(readWorkflow.json().decisions).toHaveLength(0);
    expect(readWorkflow.json().workflow.lastDecisionId).toBeUndefined();
  });

  it('serializes decision writes and reports stale If-Match values as version conflicts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-decision-version', goal: 'Protect concurrent decisions', headSha: 'head-1' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-decision-version/decisions',
      payload: {
        decision: buildDecision('wf-decision-version', {
          id: 'dec-version-base',
          action: 'request_human_review',
          reason: 'Establish the decision version.',
        }),
      },
    });

    const responses = await Promise.all(['dec-version-left', 'dec-version-right'].map((decisionId) => server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-decision-version/decisions',
      headers: { 'if-match': 'dec-version-base' },
      payload: {
        decision: buildDecision('wf-decision-version', {
          id: decisionId,
          action: 'request_human_review',
          reason: 'Only one concurrent decision may commit.',
        }),
      },
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(conflict?.json().guard).toMatchObject({ accepted: false, code: 'version_conflict' });

    const stored = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-decision-version',
    });
    expect(stored.json().decisions).toHaveLength(2);
  });

  it('rejects invalid TaskGraph scope and review-mode change declarations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-invalid-graph',
        goal: 'Reject contradictory graph scope',
        headSha: 'head-1',
      },
    });
    const overlap = buildTaskGraph('wf-invalid-graph', 1, [{ id: 'st-api', dependsOn: [] }]);
    overlap.subtasks[0].allowedPaths = ['packages/kernel/src/**'];
    overlap.subtasks[0].blockedPaths = ['**/*'];
    const overlapResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-invalid-graph/task-graph',
      payload: { graph: overlap },
    });
    expect(overlapResponse.statusCode).toBe(400);
    expect(overlapResponse.json().error).toMatchObject({ code: 'invalid_task_graph' });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-review-invalid-graph',
        mode: 'review',
        goal: 'Reject implementation declarations in review mode',
        headSha: 'head-1',
      },
    });
    const reviewGraph = buildTaskGraph('wf-review-invalid-graph', 1, [{ id: 'st-api', dependsOn: [] }]);
    reviewGraph.subtasks[0].kind = 'review';
    reviewGraph.subtasks[0].expectedChangedFiles = ['packages/kernel/src/server.ts'];
    reviewGraph.subtasks[0].assignedReviewer = 'codex';
    const reviewResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-review-invalid-graph/task-graph',
      payload: { graph: reviewGraph },
    });
    expect(reviewResponse.statusCode).toBe(400);
    expect(reviewResponse.json().error).toMatchObject({ code: 'invalid_task_graph' });
  });

  it('rejects unattested atomic execution without changing subtask or evidence state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-atomic-execute', goal: 'Record implementation atomically', headSha: 'head-1' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/task-graph',
      payload: {
        graph: buildTaskGraph('wf-atomic-execute', 1, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-other', dependsOn: [] },
        ]),
      },
    });
    await acceptContractForSubtask(server, 'wf-atomic-execute', 'st-api', 'head-1');
    const createdInvocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/agent-invocations',
      payload: {
        id: 'inv-builder',
        subtaskId: 'st-api',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/agent-invocations/inv-builder/hook-start',
      payload: {
        attestationToken: createdInvocation.json().invocation.attestationToken,
        nonce: 'nonce-builder',
        parentThreadId: 'parent-thread',
        actualSubagentThreadId: 'builder-thread',
        role: 'executor',
      },
    });

    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/actions/execute-subtask',
      payload: {
        decision: buildDecision('wf-atomic-execute', {
          id: 'dec-record-implementation',
          action: 'record_implementation',
          subtaskId: 'st-api',
          reason: 'Record implementation evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
        invocation: {
          id: 'inv-builder',
          attestationToken: 'invalid-token',
          status: 'completed',
          headSha: 'head-1',
          evidenceRefs: ['ev-implementation'],
        },
        evidence: {
          id: 'ev-implementation',
          kind: 'implementation',
          title: 'Implementation',
          subtaskId: 'st-api',
          headSha: 'head-1',
          payload: {
            observedChangedFiles: [{ path: 'packages/kernel/src/server.ts', changeType: 'modified' }],
          },
        },
      },
    });
    expect(rejected.statusCode).toBe(409);

    const stored = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute',
    });
    expect(stored.json().subtasks['st-api'].status).toBe('contract_accepted');
    expect(stored.json().subtasks['st-api'].evidenceRefs).toEqual([]);
    expect(stored.json().evidence).toEqual([]);
    expect(stored.json().invocations[0].status).toBe('started');

    const wrongSubtaskInvocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/agent-invocations',
      payload: {
        id: 'inv-wrong-subtask',
        subtaskId: 'st-other',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/agent-invocations/inv-wrong-subtask/hook-start',
      payload: {
        attestationToken: wrongSubtaskInvocation.json().invocation.attestationToken,
        nonce: 'nonce-wrong-subtask',
        parentThreadId: 'parent-thread',
        actualSubagentThreadId: 'wrong-subtask-thread',
        role: 'executor',
      },
    });
    const mismatched = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/actions/execute-subtask',
      payload: {
        decision: buildDecision('wf-atomic-execute', {
          id: 'dec-mismatched-implementation',
          action: 'record_implementation',
          subtaskId: 'st-api',
          reason: 'A different subtask invocation must not provide evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
        invocation: {
          id: 'inv-wrong-subtask',
          attestationToken: wrongSubtaskInvocation.json().invocation.attestationToken,
          status: 'completed',
          headSha: 'head-1',
          evidenceRefs: ['ev-mismatched'],
        },
        evidence: {
          id: 'ev-mismatched',
          kind: 'implementation',
          title: 'Mismatched implementation',
          subtaskId: 'st-api',
          headSha: 'head-1',
          payload: {
            observedChangedFiles: [{ path: 'packages/kernel/src/server.ts', changeType: 'modified' }],
          },
        },
      },
    });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json().error).toMatchObject({ code: 'missing_subagent_invocation' });
    const afterMismatch = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute',
    });
    expect(afterMismatch.json().evidence).toEqual([]);
    expect(afterMismatch.json().subtasks['st-api'].status).toBe('contract_accepted');
    expect(afterMismatch.json().invocations.find((item: { id: string }) => item.id === 'inv-wrong-subtask').status).toBe('started');

    for (const decisionId of ['dec-version-1', 'dec-version-2']) {
      const recorded = await server.inject({
        method: 'POST',
        url: '/api/v1/multi-agent/workflows/wf-atomic-execute/decisions',
        payload: {
          decision: buildDecision('wf-atomic-execute', {
            id: decisionId,
            action: 'execute_subtask',
            subtaskId: 'st-api',
            reason: 'Advance decision history for optimistic locking.',
            inputs: { currentHeadSha: 'head-1' },
          }),
        },
      });
      expect(recorded.statusCode).toBe(200);
    }
    const stale = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute/actions/execute-subtask',
      headers: { 'if-match': 'dec-version-1' },
      payload: {
        decision: buildDecision('wf-atomic-execute', {
          id: 'dec-stale-implementation',
          action: 'record_implementation',
          subtaskId: 'st-api',
          reason: 'Stale implementation must not commit.',
          inputs: { currentHeadSha: 'head-1' },
        }),
        invocation: {
          id: 'inv-builder',
          attestationToken: createdInvocation.json().invocation.attestationToken,
          status: 'completed',
          headSha: 'head-1',
          evidenceRefs: ['ev-stale'],
        },
        evidence: {
          id: 'ev-stale',
          kind: 'implementation',
          title: 'Stale implementation',
          subtaskId: 'st-api',
          headSha: 'head-1',
          payload: {
            observedChangedFiles: [{ path: 'packages/kernel/src/server.ts', changeType: 'modified' }],
          },
        },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'version_conflict' });
    const afterStale = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-atomic-execute',
    });
    expect(afterStale.json().evidence).toEqual([]);
    expect(afterStale.json().invocations[0].status).toBe('started');
  });

  it('records attested readonly review evidence and advances to focused evaluation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-review-record', mode: 'review', goal: 'Review pinned API changes', headSha: 'head-1' },
    });
    const graph = buildTaskGraph('wf-review-record', 1, [{ id: 'st-api', dependsOn: [] }]);
    graph.subtasks[0].kind = 'review';
    graph.subtasks[0].assignedReviewer = 'codex';
    graph.subtasks[0].expectedChangedFiles = undefined;
    const storedGraph = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-review-record/task-graph',
      payload: { graph },
    });
    expect(storedGraph.statusCode).toBe(200);

    const createdInvocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-review-record/agent-invocations',
      payload: {
        id: 'inv-reviewer',
        subtaskId: 'st-api',
        role: 'reviewer',
        runner: 'codex-evaluator',
        promptContract: 'codex-reviewer.v1',
        headSha: 'head-1',
        readonlyPolicy: { enforced: true, violations: [] },
      },
    });
    const token = createdInvocation.json().invocation.attestationToken;
    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-review-record/agent-invocations/inv-reviewer/hook-start',
      payload: {
        attestationToken: token,
        nonce: 'nonce-reviewer',
        parentThreadId: 'parent-thread',
        actualSubagentThreadId: 'reviewer-thread',
        role: 'reviewer',
      },
    });
    expect(started.statusCode).toBe(200);

    const recorded = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-review-record/actions/record-review',
      payload: {
        decision: buildDecision('wf-review-record', {
          id: 'dec-record-review',
          action: 'record_review',
          subtaskId: 'st-api',
          reason: 'Record candidate findings.',
          inputs: { currentHeadSha: 'head-1' },
        }),
        invocation: {
          id: 'inv-reviewer',
          attestationToken: token,
          status: 'completed',
          headSha: 'head-1',
          evidenceRefs: ['ev-review'],
          readonlyPolicy: { enforced: true, violations: [] },
        },
        evidence: {
          id: 'ev-review',
          kind: 'review',
          title: 'API review candidates',
          subtaskId: 'st-api',
          headSha: 'head-1',
          payload: { findings: [{ id: 'finding-1', severity: 'high' }] },
        },
      },
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toMatchObject({
      subtask: { status: 'reviewed', evidenceRefs: ['ev-review'] },
      evidence: { id: 'ev-review', kind: 'review' },
      invocation: { id: 'inv-reviewer', status: 'completed' },
      guard: { accepted: true },
    });

    const next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-review-record/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 'run_codex_evaluator',
      subtaskId: 'st-api',
      inputs: { reviewEvidenceId: 'ev-review' },
    });
  });

  it('allocates a new SprintContract version instead of overwriting an accepted contract', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-contract-versioning',
        goal: 'Keep accepted contract history intact',
        rootTaskId: 'root-contract-versioning',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/task-graph',
      payload: {
        graph: buildTaskGraph('wf-contract-versioning', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });

    const firstDraft = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts',
      payload: buildSprintContractPayload({
        id: 'contract-st-api-v1',
        version: 1,
        goal: 'Initial scope',
      }),
    });
    expect(firstDraft.statusCode).toBe(200);
    expect(firstDraft.json().contract).toMatchObject({
      id: 'contract-st-api-v1',
      version: 1,
      status: 'draft',
      goal: 'Initial scope',
    });

    const acceptFirst = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts/contract-st-api-v1/accept',
    });
    expect(acceptFirst.statusCode).toBe(200);
    expect(acceptFirst.json().contract).toMatchObject({
      id: 'contract-st-api-v1',
      version: 1,
      status: 'accepted',
      goal: 'Initial scope',
    });

    const secondDraft = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts',
      payload: buildSprintContractPayload({
        id: 'contract-st-api-v1',
        version: 1,
        goal: 'Expanded scope',
      }),
    });
    expect(secondDraft.statusCode).toBe(200);
    expect(secondDraft.json().contract).toMatchObject({
      id: 'contract-st-api-v2',
      version: 2,
      status: 'draft',
      goal: 'Expanded scope',
    });

    const latest = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts/latest',
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().contract).toMatchObject({
      id: 'contract-st-api-v2',
      version: 2,
      status: 'draft',
    });

    const firstAfterRedraft = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts/contract-st-api-v1/accept',
    });
    expect(firstAfterRedraft.statusCode).toBe(409);
    expect(firstAfterRedraft.json().error).toMatchObject({ code: 'version_conflict' });
  });

  it('accepts independent SprintContracts atomically and rolls back the entire batch on failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-contract-batch', goal: 'Accept contracts atomically', headSha: 'head-1' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch/task-graph',
      payload: {
        graph: buildTaskGraph('wf-contract-batch', 1, [
          { id: 'st-a', dependsOn: [] },
          { id: 'st-b', dependsOn: [] },
        ]),
      },
    });
    for (const subtaskId of ['st-a', 'st-b']) {
      await server.inject({
        method: 'POST',
        url: `/api/v1/multi-agent/workflows/wf-contract-batch/subtasks/${subtaskId}/contracts`,
        payload: buildSprintContractPayload({ id: `contract-${subtaskId}-v1`, goal: `Implement ${subtaskId}` }),
      });
      await server.inject({
        method: 'PATCH',
        url: `/api/v1/multi-agent/workflows/wf-contract-batch/subtasks/${subtaskId}`,
        payload: { status: 'contract_drafting' },
      });
    }
    const beforeBatch = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch',
    });
    const batchRevision = String(beforeBatch.json().workflow.revision);

    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch/actions/accept-contracts',
      headers: { 'if-match': batchRevision },
      payload: {
        contracts: [
          { subtaskId: 'st-a', contractId: 'contract-st-a-v1', headShaAtAcceptance: 'head-1' },
          { subtaskId: 'st-b', contractId: 'missing-contract', headShaAtAcceptance: 'head-1' },
        ],
      },
    });
    expect(rejected.statusCode).toBe(404);
    const afterRejected = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch',
    });
    expect(afterRejected.json().contracts.map((contract: { status: string }) => contract.status)).toEqual(['draft', 'draft']);
    expect(afterRejected.json().subtasks['st-a'].status).toBe('contract_drafting');
    expect(afterRejected.json().subtasks['st-b'].status).toBe('contract_drafting');
    expect(afterRejected.json().decisions).toHaveLength(0);

    const accepted = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch/actions/accept-contracts',
      headers: { 'if-match': batchRevision },
      payload: {
        contracts: [
          { subtaskId: 'st-a', contractId: 'contract-st-a-v1', headShaAtAcceptance: 'head-1' },
          { subtaskId: 'st-b', contractId: 'contract-st-b-v1', headShaAtAcceptance: 'head-1' },
        ],
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers.etag).toBe(String(accepted.json().workflow.revision));
    expect(accepted.json().contracts).toHaveLength(2);
    expect(accepted.json().decisions).toHaveLength(2);
    expect(accepted.json().subtasks).toMatchObject([
      { subtaskId: 'st-a', status: 'contract_accepted' },
      { subtaskId: 'st-b', status: 'contract_accepted' },
    ]);

    const stale = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch/actions/accept-contracts',
      headers: { 'if-match': batchRevision },
      payload: { contracts: [{ subtaskId: 'st-a', contractId: 'contract-st-a-v1' }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'version_conflict' });

    const missingRevision = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch/actions/accept-contracts',
      payload: { contracts: [{ subtaskId: 'st-a', contractId: 'contract-st-a-v1' }] },
    });
    expect(missingRevision.statusCode).toBe(409);
    expect(missingRevision.json().error).toMatchObject({ code: 'version_conflict' });

    const malformed = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-batch/actions/accept-contracts',
      payload: { contracts: [null] },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('restores every batch file when persistence fails after the first Contract write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-store-'));
    tempDirs.push(root);
    const store = new FileMultiAgentWorkflowStore(root);
    await store.createWorkflow({ id: 'wf-contract-rollback', goal: 'Rollback partial writes', headSha: 'head-1' });
    await store.putTaskGraph('wf-contract-rollback', buildTaskGraph('wf-contract-rollback', 1, [
      { id: 'st-a', dependsOn: [] },
      { id: 'st-b', dependsOn: [] },
    ]));
    for (const subtaskId of ['st-a', 'st-b']) {
      await store.createContract('wf-contract-rollback', subtaskId, buildSprintContractPayload({
        id: `contract-${subtaskId}-v1`,
        goal: `Implement ${subtaskId}`,
      }));
      await store.updateSubtask('wf-contract-rollback', subtaskId, { status: 'contract_drafting' });
    }
    const before = await store.readBundle('wf-contract-rollback');
    expect(before).not.toBeNull();

    const mutableStore = store as unknown as {
      writeJsonFileAtomic: (filePath: string, value: unknown) => Promise<void>;
    };
    const originalWrite = mutableStore.writeJsonFileAtomic.bind(store);
    mutableStore.writeJsonFileAtomic = async (filePath, value) => {
      if (filePath.endsWith('contract-st-b-v1.json') && (value as { status?: string }).status === 'accepted') {
        throw new Error('injected second Contract write failure');
      }
      await originalWrite(filePath, value);
    };

    await expect(store.acceptContractsAtomically('wf-contract-rollback', ['st-a', 'st-b'].map((subtaskId, index) => ({
      subtaskId,
      contractId: `contract-${subtaskId}-v1`,
      decision: {
        id: `dec-${index + 1}`,
        workflowId: 'wf-contract-rollback',
        rootTaskId: 'wf-contract-rollback',
        subtaskId,
        decidedBy: 'codex-workflow' as const,
        decidedAt: new Date().toISOString(),
        action: 'accept_contract' as const,
        reason: 'Accept in rollback test',
        evidenceRefs: [],
        inputs: { contractId: `contract-${subtaskId}-v1`, currentHeadSha: 'head-1' },
      },
    })), String(before?.workflow.revision))).rejects.toThrow('injected second Contract write failure');
    mutableStore.writeJsonFileAtomic = originalWrite;

    const after = await store.readBundle('wf-contract-rollback');
    expect(after?.contracts.map((contract) => contract.status)).toEqual(['draft', 'draft']);
    expect(after?.subtasks['st-a'].status).toBe('contract_drafting');
    expect(after?.subtasks['st-b'].status).toBe('contract_drafting');
    expect(after?.decisions).toEqual([]);
    expect(after?.workflow.revision).toBe(before?.workflow.revision);
  });

  it('stores a planner TaskGraph automatically when a planner invocation completes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-planner-auto',
        goal: 'Planner writes TaskGraph',
        rootTaskId: 'root-planner-auto',
        headSha: 'head-1',
      },
    });
    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-planner-auto/agent-invocations',
      payload: {
        role: 'planner',
        runner: 'claude-code',
        promptContract: 'task-graph.v1',
      },
    });
    const invocationId = invocation.json().invocation.id;
    await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-planner-auto/agent-invocations/${invocationId}/start`,
    });

    const graph = buildTaskGraph('wf-planner-auto', 1, [
      { id: 'st-api', dependsOn: [] },
      { id: 'st-ui', dependsOn: ['st-api'] },
    ]);
    const completed = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-planner-auto/agent-invocations/${invocationId}/result`,
      payload: {
        status: 'completed',
        result: {
          taskGraph: graph,
        },
      },
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json().taskGraph).toMatchObject({
      graph,
      subtasks: {
        'st-api': { status: 'ready' },
        'st-ui': { status: 'pending' },
      },
    });

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-planner-auto',
    });
    expect(readWorkflow.json().taskGraph).toMatchObject(graph);
  });

  it('rejects workflow completion without v1 final evaluation evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-v1-completion-gate',
        goal: 'Missing final evaluation gate',
        rootTaskId: 'root-v1-completion-gate',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-v1-completion-gate/task-graph',
      payload: {
        graph: buildTaskGraph('wf-v1-completion-gate', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await moveSubtaskToDoneWithoutReview(server, 'wf-v1-completion-gate', 'st-api', 'head-1');

    const withoutFinalEvaluation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-v1-completion-gate/decisions',
      payload: {
        decision: buildDecision('wf-v1-completion-gate', {
          id: 'dec-complete-without-final-evaluation',
          action: 'complete_workflow',
          reason: 'Should need v1 final evaluation evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(withoutFinalEvaluation.statusCode).toBe(409);
    expect(withoutFinalEvaluation.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_evaluation_result',
    });
  });

  it('allows DAG-ready pending subtasks to start only after dependencies are done', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-dag-ready',
        goal: 'Advance DAG subtasks',
        rootTaskId: 'root-dag-ready',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/task-graph',
      payload: {
        graph: buildTaskGraph('wf-dag-ready', 1, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-ui', dependsOn: ['st-api'] },
        ]),
      },
    });
    const beforeDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-draft-ui-too-early',
          action: 'draft_contract',
          subtaskId: 'st-ui',
          reason: 'Dependent subtask should not draft before st-api is done.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(beforeDependency.statusCode).toBe(200);
    expect(beforeDependency.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });

    await moveSubtaskToDone(server, 'wf-dag-ready', 'st-api', 'head-1');
    const draftAfterDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-draft-ui-after-api',
          action: 'draft_contract',
          subtaskId: 'st-ui',
          reason: 'Dependency is done, so the pending subtask can draft a contract.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(draftAfterDependency.statusCode).toBe(200);
    expect(draftAfterDependency.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });

    await acceptContractForSubtask(server, 'wf-dag-ready', 'st-ui', 'head-1');
    const afterDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-execute-ui-after-contract',
          action: 'execute_subtask',
          subtaskId: 'st-ui',
          reason: 'Dependency and contract are ready, so the subtask can start.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(afterDependency.statusCode).toBe(200);
    expect(afterDependency.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });



  it('rejects removed legacy review actions and enforces v1 evaluator evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-action-guard',
        goal: 'Guard v1 action-specific transitions',
        rootTaskId: 'root-action-guard',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/task-graph',
      payload: {
        graph: buildTaskGraph('wf-action-guard', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await acceptContractForSubtask(server, 'wf-action-guard', 'st-api', 'head-1');

    const legacyReview = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-legacy-review',
          action: 'request_claude_review',
          subtaskId: 'st-api',
          reason: 'Legacy review action should not be accepted in v1.1.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(legacyReview.statusCode).toBe(409);
    expect(legacyReview.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });
    expect(legacyReview.json().guard.message).toMatch(/Unsupported workflow decision action/);

    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: { status: 'executing' },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'implemented',
        implementationHeadSha: 'head-1',
      },
    });

    const evaluatorWithoutImplementationEvidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions/preflight',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-evaluate-without-impl-evidence',
          action: 'run_codex_evaluator',
          subtaskId: 'st-api',
          reason: 'Evaluator needs implementation evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(evaluatorWithoutImplementationEvidence.statusCode).toBe(200);
    expect(evaluatorWithoutImplementationEvidence.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_implementation_evidence',
    });
  });

  it('rejects workflow creation when the effective worktree is outside the workspace root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-outside-'));
    tempDirs.push(root, outside);
    const server = await createTestServer(root);
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-outside',
        goal: 'Reject unsafe worktree',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'repo',
          effectiveProjectPath: outside,
          sourceProjectPath: outside,
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_workspace_binding',
      },
    });
  });

  it('accepts an external source project explicitly listed by the code workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    const externalProject = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-external-project-'));
    tempDirs.push(root, externalProject);
    await fs.writeFile(path.join(root, 'merchant.code-workspace'), JSON.stringify({
      folders: [{ name: 'merchant', path: externalProject }],
    }), 'utf-8');
    const server = await createTestServer(root);
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-external-allowlisted',
        goal: 'Review an allowlisted sibling repository',
        headSha: 'head-1',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'merchant',
          projectName: 'merchant',
          effectiveProjectPath: externalProject,
          sourceProjectPath: externalProject,
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().workflow.workspaceBinding).toMatchObject({
      workspaceRoot: root,
      sourceProjectPath: externalProject,
      effectiveProjectPath: externalProject,
    });
  });

  it('derives workflow workspace root from the server instead of trusting caller input', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-root-normalized',
        goal: 'Normalize root',
        workspaceBinding: {
          workspaceRoot: '/',
          workspaceName: 'attacker-root',
          projectName: 'repo',
          effectiveProjectPath: repo,
          sourceProjectPath: repo,
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().workflow.workspaceBinding).toMatchObject({
      workspaceRoot: root,
      workspaceName: path.basename(root),
      effectiveProjectPath: repo,
    });
  });

  it('preserves existing subtask runtime state when a new TaskGraph version keeps the same subtask id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-replan', goal: 'Preserve replan state' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-replan/task-graph',
      payload: {
        graph: buildTaskGraph('wf-replan', 1, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-ui', dependsOn: ['st-api'] },
        ]),
      },
    });
    let transition = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-replan/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    expect(transition.statusCode).toBe(200);
    transition = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-replan/subtasks/st-api',
      payload: {
        status: 'implemented',
        evidenceRefs: ['ev-implementation'],
        implementationHeadSha: 'head-1',
        fixRound: 1,
      },
    });
    expect(transition.statusCode).toBe(200);

    const replan = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-replan/task-graph',
      payload: {
        graph: buildTaskGraph('wf-replan', 2, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-docs', dependsOn: ['st-api'] },
        ]),
      },
    });

    expect(replan.statusCode).toBe(200);
    expect(replan.json().subtasks['st-api']).toMatchObject({
      status: 'implemented',
      evidenceRefs: ['ev-implementation'],
      implementationHeadSha: 'head-1',
      fixRound: 1,
    });
    expect(replan.json().subtasks['st-docs']).toMatchObject({
      status: 'pending',
      fixRound: 0,
    });
    expect(replan.json().subtasks['st-ui']).toBeUndefined();
  });

  it('rejects illegal subtask and invocation state transitions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-transitions', goal: 'Guard transitions' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-transitions/task-graph',
      payload: {
        graph: buildTaskGraph('wf-transitions', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });

    const illegalSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-transitions/subtasks/st-api',
      payload: {
        status: 'done',
      },
    });
    expect(illegalSubtask.statusCode).toBe(409);
    expect(illegalSubtask.json().error.code).toBe('invalid_transition');

    const legalSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-transitions/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    expect(legalSubtask.statusCode).toBe(200);

    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-transitions/agent-invocations',
      payload: {
        role: 'planner',
        runner: 'claude-code',
        promptContract: 'task-graph.v1',
      },
    });
    const invocationId = invocation.json().invocation.id;

    const illegalInvocation = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/result`,
      payload: {
        status: 'completed',
        result: { ok: true },
      },
    });
    expect(illegalInvocation.statusCode).toBe(409);
    expect(illegalInvocation.json().error.code).toBe('invalid_transition');

    const started = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/start`,
    });
    expect(started.statusCode).toBe(200);

    const completed = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/result`,
      payload: {
        status: 'completed',
        result: { ok: true },
      },
    });
    expect(completed.statusCode).toBe(200);

    const restart = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/start`,
    });
    expect(restart.statusCode).toBe(409);
    expect(restart.json().error.code).toBe('invalid_transition');
  });

  it('rejects foreign subtask identity fields and preserves stored arrays', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-subtask-sanitize', goal: 'Sanitize subtask patches' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-subtask-sanitize/task-graph',
      payload: {
        graph: buildTaskGraph('wf-subtask-sanitize', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });

    const polluted = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-subtask-sanitize/subtasks/st-api',
      payload: {
        subtaskId: 'st-attacker',
        workflowId: 'wf-attacker',
        status: 'executing',
        evidenceRefs: ['ev-a'],
        validationRunIds: ['vr-a'],
        blockerFindingIds: ['bf-a'],
        fixRound: 99,
        createdAt: '2000-01-01T00:00:00.000Z',
      },
    });

    expect(polluted.statusCode).toBe(400);
    expect(polluted.json().error.code).toBe('invalid_subtask_patch');

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-subtask-sanitize',
    });
    expect(readWorkflow.json().subtasks['st-api']).toMatchObject({
      subtaskId: 'st-api',
      status: 'ready',
      evidenceRefs: [],
      validationRunIds: [],
      blockerFindingIds: [],
      fixRound: 0,
    });
  });

  it('requires explicit invocation result status so failed runs cannot default to completed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-invocation-status', goal: 'Require invocation status' },
    });
    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations',
      payload: {
        role: 'questioner',
        runner: 'claude-code',
        promptContract: 'questioner.v1',
      },
    });
    const invocationId = invocation.json().invocation.id;
    await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations/${invocationId}/start`,
    });

    const missingStatus = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations/${invocationId}/result`,
      payload: {
        error: 'Claude runtime failed before ReviewResult.',
      },
    });

    expect(missingStatus.statusCode).toBe(400);
    expect(missingStatus.json().error.code).toBe('invalid_invocation_status');

    const stored = await server.inject({
      method: 'GET',
      url: `/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations/${invocationId}`,
    });
    expect(stored.json().invocation).toMatchObject({
      status: 'started',
    });
    expect(stored.json().invocation).not.toHaveProperty('error');
  });
});

async function createTestServer(
  root: string,
  options: { runtimeRunners?: Record<string, AgentRuntimeRunner> } = {},
) {
  return (await createTestServerWithWorkbench(root, options)).server;
}

async function createTestServerWithWorkbench(
  root: string,
  options: { runtimeRunners?: Record<string, AgentRuntimeRunner> } = {},
) {
  const workbench = new WorkbenchService({
    rootPath: root,
    eventBus: new EventBus(),
    store: new WorkbenchStore(root),
  });
  const mockKernel = {
    projectPath: root,
    environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
    taskManager: { create: () => ({ id: 'unused' }) },
    runTask: async () => ({ status: 'pending' }),
    listTasks: () => [],
    getTask: () => null,
    getSession: () => null,
    control: () => undefined,
    getEvents: () => [],
    streamEvents: async function* streamEvents() {},
    workbench,
  };
  const server = await createServer(
    mockKernel as any,
    { port: 0, host: '127.0.0.1' },
    { workspaceRoot: root, runtimeRunners: options.runtimeRunners },
  );
  return { server, workbench };
}

function buildTaskGraph(
  workflowId: string,
  version: number,
  subtasks: Array<{ id: string; dependsOn: string[] }>,
) {
  return {
    workflowId,
    version,
    createdBy: 'claude-code',
    risks: [],
    globalAcceptanceCriteria: [],
    finalValidationCommands: [],
    subtasks: subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.id,
      goal: `Implement ${subtask.id}`,
      dependsOn: subtask.dependsOn,
      allowedPaths: ['packages/kernel/src'],
      acceptanceCriteria: ['Works as specified.'],
      validationCommands: ['pnpm --filter @tik/kernel test'],
      reviewFocus: ['correctness'],
      assignedExecutor: 'codex',
      assignedReviewer: 'claude-code',
    })),
  };
}

function buildDecision(
  workflowId: string,
  patch: {
    id: string;
    action: string;
    reason: string;
    subtaskId?: string;
    evidenceRefs?: string[];
    inputs?: Record<string, unknown>;
  },
) {
  return {
    workflowId,
    rootTaskId: `root-${workflowId}`,
    decidedBy: 'codex-workflow',
    decidedAt: '2026-07-01T00:00:00.000Z',
    evidenceRefs: [],
    ...patch,
  };
}

function buildSprintContractPayload(patch: {
  id?: string;
  version?: number;
  goal?: string;
  allowedPaths?: string[];
} = {}) {
  return {
    id: patch.id,
    version: patch.version,
    status: 'draft',
    goal: patch.goal || 'Implement st-api',
    scope: {
      allowedPaths: patch.allowedPaths || ['packages/kernel/src'],
      blockedPaths: [],
    },
    deliverables: [{
      id: 'deliver-st-api',
      description: patch.goal || 'Implement st-api',
      expectedFiles: ['packages/kernel/src/multi-agent/workflow-store.ts'],
    }],
    acceptanceCriteria: [{
      id: 'ac-1',
      statement: 'Contract behavior is auditable.',
      priority: 'must',
      verificationMethod: 'test',
    }],
    verificationPlan: {
      commands: [{
        id: 'cmd-1',
        command: 'pnpm --filter @tik/kernel test',
        required: true,
      }],
    },
  };
}

function fakeRuntimeRunner(
  name: 'codex' | 'claude-code',
  started: PreparedRun[],
  options: {
    threadPrefix?: string;
    pid?: number;
    completion?: Promise<AgentRunCompletion>;
    onStart?: (prepared: PreparedRun) => Promise<void>;
  } = {},
): AgentRuntimeRunner {
  return {
    name,
    prepare: vi.fn(async (input) => ({
      runId: input.runId,
      runner: name,
      mode: input.runnerMode,
      cwd: input.projectPath,
      prompt: input.renderedPrompt,
      cleanContext: input.cleanContext,
      contextTokenBudget: input.contextTokenBudget,
      timeoutMs: input.timeoutMs,
    })),
    start: vi.fn(async (prepared) => {
      started.push(prepared);
      await options.onStart?.(prepared);
      return {
        runId: prepared.runId,
        threadId: options.threadPrefix ? `${options.threadPrefix}-${prepared.runId}` : undefined,
        pid: options.pid,
        startedAt: '2026-07-11T00:00:00.000Z',
        completion: options.completion || new Promise(() => undefined),
        stop: async () => undefined,
      };
    }),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => 'running'),
    collectTranscript: vi.fn(async () => []),
    collectDiff: vi.fn(async () => ({ changedFiles: [] })),
    collectArtifacts: vi.fn(async () => []),
    cleanup: vi.fn(async () => undefined),
  };
}

async function createCommittedEvidenceRepo(root: string): Promise<{ baseSha: string; headSha: string }> {
  await fs.mkdir(path.join(root, 'src/main/java/example'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/test/java/example'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), '.tik/\n', 'utf-8');
  await fs.writeFile(path.join(root, 'src/main/java/example/Example.java'), 'package example; class Example { int value = 1; }\n', 'utf-8');
  await fs.writeFile(path.join(root, 'src/test/java/example/ExampleTest.java'), 'package example; class ExampleTest {}\n', 'utf-8');
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Tik Test'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
  const baseSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await fs.writeFile(path.join(root, 'src/main/java/example/Example.java'), 'package example; class Example { int value = 2; }\n', 'utf-8');
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'implementation'], { cwd: root });
  const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  return { baseSha, headSha };
}

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function moveSubtaskToDone(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  headSha: string,
) {
  await acceptContractForSubtask(server, workflowId, subtaskId, headSha);
  await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/evidence`,
    payload: {
      id: `ev-${subtaskId}-validation`,
      kind: 'validation',
      title: `${subtaskId} validation`,
      subtaskId,
      passed: true,
      headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'executing',
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'implemented',
      implementationHeadSha: headSha,
      evidenceRefs: [`ev-${subtaskId}-validation`],
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'validated',
      validationRunIds: [`ev-${subtaskId}-validation`],
      lastValidatedHeadSha: headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'questioning_evidence',
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'done',
    },
  });
}

async function acceptContractForSubtask(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  headSha: string,
  allowedPaths?: string[],
) {
  const created = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}/contracts`,
    payload: buildSprintContractPayload({
      id: `contract-${subtaskId}-v1`,
      goal: `Implement ${subtaskId}`,
      allowedPaths,
    }),
  });
  expect(created.statusCode).toBe(200);
  const accepted = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}/contracts/contract-${subtaskId}-v1/accept`,
    payload: {
      acceptedBy: 'codex-workflow-plugin',
      headShaAtAcceptance: headSha,
    },
  });
  expect(accepted.statusCode).toBe(200);
  const ready = await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'ready',
    },
  });
  expect(ready.statusCode).toBe(200);
  const drafting = await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'contract_drafting',
    },
  });
  expect(drafting.statusCode).toBe(200);
  const patched = await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'contract_accepted',
    },
  });
  expect(patched.statusCode).toBe(200);
}

async function moveSubtaskToDoneWithoutReview(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  headSha: string,
) {
  await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/evidence`,
    payload: {
      id: `ev-${subtaskId}-validation`,
      kind: 'validation',
      title: `${subtaskId} validation`,
      subtaskId,
      passed: true,
      headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'executing',
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'implemented',
      implementationHeadSha: headSha,
      evidenceRefs: [`ev-${subtaskId}-validation`],
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'validated',
      validationRunIds: [`ev-${subtaskId}-validation`],
      lastValidatedHeadSha: headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'done',
    },
  });
}
