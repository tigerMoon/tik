import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextEngine } from '../src/context/context-engine.js';
import { ContextRenderer } from '../src/renderer/context-renderer.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('environment pack runtime context', () => {
  it('loads the active environment pack into agent context and renderer output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-sight-env-pack-'));
    tempDirs.push(root);

    await fs.mkdir(path.join(root, 'env-packs', 'base-engineering'), { recursive: true });
    await fs.writeFile(path.join(root, 'env-packs', 'base-engineering', 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
      description: 'General delivery pack',
      tools: ['github', 'shell'],
      skills: ['coder', 'pr-review'],
      knowledge: [{ id: 'repo-index', kind: 'repo-index', label: 'Repo Index' }],
      policies: ['approval-for-high-risk-actions'],
      workflowBindings: [{
        workflow: 'feature-delivery',
        phases: {
          clarify: ['requirements-clarifier'],
          implement: ['coder'],
        },
      }],
      evaluators: ['risk-evaluator'],
    }, null, 2), 'utf-8');
    await fs.mkdir(path.join(root, 'env-packs', 'commerce-ops'), { recursive: true });
    await fs.writeFile(path.join(root, 'env-packs', 'commerce-ops', 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'commerce-ops',
      name: 'Commerce Ops',
      version: '0.2.0',
      description: 'Service delivery pack',
      tools: ['jira'],
      skills: ['release-review'],
      knowledge: [{ id: 'runbook', kind: 'runbook', label: 'Operations Runbook' }],
      policies: ['release-approval'],
      workflowBindings: [],
      evaluators: ['release-risk'],
    }, null, 2), 'utf-8');

    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'environment-pack.json'), JSON.stringify({
      activePackId: 'commerce-ops',
      updatedAt: '2026-04-09T00:00:00.000Z',
    }, null, 2), 'utf-8');

    const engine = new ContextEngine(root);
    const context = await engine.buildContext('task-1', 1);
    expect(context.environment?.activePack.id).toBe('commerce-ops');
    expect(context.environment?.activePack.skills).toContain('release-review');

    const renderer = new ContextRenderer();
    const output = renderer.render({
      bootstrap: {
        cwd: root,
        currentDate: '2026-04-09',
      },
      execution: context,
      conversation: {
        recentMessages: [],
      },
      meta: {
        taskId: 'task-1',
        sessionId: 'session-1',
        iteration: 1,
        agent: 'planner',
        strategy: 'incremental',
      },
    });

    expect(output).toContain('# Environment Pack');
    expect(output).toContain('Commerce Ops');
    expect(output).toContain('release-approval');
  });

  it('prefers a task-bound environment pack over the global active pack during session context builds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-sight-env-pack-'));
    tempDirs.push(root);

    await fs.mkdir(path.join(root, 'env-packs', 'base-engineering'), { recursive: true });
    await fs.writeFile(path.join(root, 'env-packs', 'base-engineering', 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
      description: 'General delivery pack',
      tools: ['github', 'shell'],
      skills: ['coder'],
      knowledge: [{ id: 'repo-index', kind: 'repo-index', label: 'Repo Index' }],
      policies: ['approval-for-high-risk-actions'],
      workflowBindings: [{
        workflow: 'feature-delivery',
        phases: {
          implement: ['coder'],
        },
      }],
      evaluators: ['risk-evaluator'],
    }, null, 2), 'utf-8');
    await fs.mkdir(path.join(root, 'env-packs', 'commerce-ops'), { recursive: true });
    await fs.writeFile(path.join(root, 'env-packs', 'commerce-ops', 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'commerce-ops',
      name: 'Commerce Ops',
      version: '0.2.0',
      description: 'Service delivery pack',
      tools: ['jira'],
      skills: ['release-review'],
      knowledge: [{ id: 'runbook', kind: 'runbook', label: 'Operations Runbook' }],
      policies: ['release-approval'],
      workflowBindings: [],
      evaluators: ['release-risk'],
    }, null, 2), 'utf-8');

    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'environment-pack.json'), JSON.stringify({
      activePackId: 'commerce-ops',
      updatedAt: '2026-04-09T00:00:00.000Z',
    }, null, 2), 'utf-8');

    const engine = new ContextEngine(root);
    const envelope = await engine.buildFromSession?.(
      {
        id: 'task-1',
        description: 'Implement feature delivery',
        environmentPackSnapshot: {
          id: 'base-engineering',
          name: 'Base Engineering',
          version: '0.1.0',
        },
        environmentPackSelection: {
          selectedSkills: ['coder'],
          selectedKnowledgeIds: [],
        },
      },
      {
        sessionId: 'session-1',
        step: 1,
        currentAgent: 'planner',
        messages: [],
      },
      { agent: 'planner' },
    );

    expect(envelope?.execution.environment?.activePack.id).toBe('base-engineering');
    expect(envelope?.execution.environment?.activePack.skills).toContain('coder');
    expect(envelope?.execution.environment?.activePack.knowledge).toEqual([]);
  });

  it('filters environment pack skills and knowledge to the task-level selection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-sight-env-pack-'));
    tempDirs.push(root);

    await fs.mkdir(path.join(root, 'env-packs', 'design-to-code'), { recursive: true });
    await fs.writeFile(path.join(root, 'env-packs', 'design-to-code', 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
      description: 'Frontend delivery pack',
      tools: ['frontend-preview'],
      skills: ['figma-to-react', 'ui-review', 'frontend-implementation'],
      knowledge: [
        { id: 'design-system', kind: 'design-system', label: 'Design System' },
        { id: 'ui-guidelines', kind: 'docs', label: 'UI Guidelines' },
      ],
      policies: ['design-review-before-publish'],
      workflowBindings: [{
        workflow: 'feature-delivery',
        phases: {
          implement: ['figma-to-react', 'frontend-implementation'],
          review: ['ui-review'],
        },
      }],
      evaluators: ['token-consistency-check'],
    }, null, 2), 'utf-8');

    const engine = new ContextEngine(root);
    const envelope = await engine.buildFromSession?.(
      {
        id: 'task-2',
        description: 'Implement console redesign',
        environmentPackSnapshot: {
          id: 'design-to-code',
          name: 'Design To Code',
          version: '0.1.0',
        },
        environmentPackSelection: {
          selectedSkills: ['ui-review'],
          selectedKnowledgeIds: ['ui-guidelines'],
        },
      },
      {
        sessionId: 'session-2',
        step: 1,
        currentAgent: 'planner',
        messages: [],
      },
      { agent: 'planner' },
    );

    expect(envelope?.execution.environment?.activePack.skills).toEqual(['ui-review']);
    expect(envelope?.execution.environment?.activePack.knowledge).toEqual([
      { id: 'ui-guidelines', kind: 'docs', label: 'UI Guidelines' },
    ]);
    expect(envelope?.execution.environment?.activePack.workflowBindings[0]?.phases.review).toEqual(['ui-review']);
    expect(envelope?.execution.environment?.activePack.workflowBindings[0]?.phases.implement).toEqual([]);
  });
});
