import { describe, expect, it } from 'vitest';
import type { EnvironmentPackSnapshot } from '../types/environment-pack.js';
import type { WorkbenchDispatchEnvironmentTask } from './workbench-dispatch.js';
import {
  getWorkbenchLabelAction,
  getWorkbenchLabelDefinition,
  isWorkbenchTaskCodexDispatchable,
  isWorkbenchTaskWorkflowDispatchable,
  isWorkbenchTaskMaintenance,
  normalizeWorkbenchLabel,
} from './index.js';

const engineeringSnapshot: EnvironmentPackSnapshot = {
  id: 'engineering',
  name: 'Engineering',
  version: '1.0.0',
  taskLabels: [
    {
      value: 'needs-claude-review',
      label: 'Claude review',
      action: 'claude_code_review',
      description: 'Review with Claude Code.',
      aliases: ['claude-review'],
    },
    {
      value: 'codex-fix',
      label: 'Codex fix',
      action: 'codex_fix',
      description: 'Fix review blockers.',
      aliases: ['needs-codex-fix'],
    },
    {
      value: 'worktree',
      label: 'Worktree',
      action: 'maintenance_manual',
      description: 'Manual workspace maintenance.',
      aliases: ['workspace-maintenance'],
    },
  ],
};

describe('workbench label routing', () => {
  it('normalizes labels and maps aliases from the bound environment', () => {
    expect(normalizeWorkbenchLabel(' Needs_Claude Review ')).toBe('needs-claude-review');
    expect(getWorkbenchLabelDefinition(engineeringSnapshot, 'claude_review')?.value).toBe('needs-claude-review');
    expect(getWorkbenchLabelAction(engineeringSnapshot, 'claude-review')).toBe('claude_code_review');
    expect(getWorkbenchLabelAction(engineeringSnapshot, 'needs-codex-fix')).toBe('codex_fix');
    expect(getWorkbenchLabelAction(engineeringSnapshot, 'workspace-maintenance')).toBe('maintenance_manual');
    expect(getWorkbenchLabelAction(engineeringSnapshot, 'custom-search-label')).toBe('metadata');
  });

  it('does not infer actions or dispatch without an environment label declaration', () => {
    expect(getWorkbenchLabelAction(undefined, 'worktree')).toBe('metadata');
    expect(isWorkbenchTaskMaintenance({
      labels: ['worktree'],
      agentLoop: undefined,
      environmentPackSnapshot: undefined,
    })).toBe(false);
    expect(isWorkbenchTaskCodexDispatchable({
      status: 'todo',
      labels: ['needs-claude-review'],
      agentLoop: undefined,
      environmentPackSnapshot: undefined,
    })).toBe(false);
  });

  it('keeps environment-declared maintenance work out of the Codex dispatch lane', () => {
    const task = {
      status: 'todo' as const,
      labels: ['worktree'],
      agentLoop: undefined,
      environmentPackSnapshot: engineeringSnapshot,
    };

    expect(isWorkbenchTaskMaintenance(task)).toBe(true);
    expect(isWorkbenchTaskCodexDispatchable(task)).toBe(false);
  });

  it('routes environment-declared Claude review labels away from Codex dispatch', () => {
    const task: WorkbenchDispatchEnvironmentTask = {
      status: 'todo',
      labels: ['needs-claude-review'],
      agentLoop: undefined,
      environmentPackSnapshot: engineeringSnapshot,
    };

    expect(isWorkbenchTaskCodexDispatchable(task)).toBe(false);
    expect(isWorkbenchTaskWorkflowDispatchable(task)).toBe(true);
  });

  it('allows environment-declared codex fix labels through the Codex dispatch lane', () => {
    const task: WorkbenchDispatchEnvironmentTask = {
      status: 'todo',
      labels: ['needs-codex-fix'],
      agentLoop: undefined,
      environmentPackSnapshot: engineeringSnapshot,
    };

    expect(isWorkbenchTaskCodexDispatchable(task)).toBe(true);
    expect(isWorkbenchTaskWorkflowDispatchable(task)).toBe(true);
  });
});
