import { describe, expect, it } from 'vitest';
import { WorkspaceContextAssembler } from '../src/workspace-context-assembler.js';

describe('WorkspaceContextAssembler', () => {
  it('pins delegated specify output to the target spec path', () => {
    const assembler = new WorkspaceContextAssembler();

    const spec = assembler.buildSpecifySubtaskSpec({
      projectName: 'catalog-suite',
      projectPath: '/workspace/worktrees/catalog-suite',
      sourceProjectPath: '/repo/catalog-suite',
      effectiveProjectPath: '/workspace/worktrees/catalog-suite',
      demand: '替换 catalog-suite 本地类目DB访问为 catalog-items 外部接口，并补齐类目属性查询与缓存方案',
      workspaceRoot: '/workspace',
      workspaceFile: '/workspace/demo.code-workspace',
      targetSpecPath: '/workspace/worktrees/catalog-suite/.specify/specs/feature/spec.md',
    });

    expect(spec.projectPath).toBe('/workspace/worktrees/catalog-suite');
    expect(spec.inputs.sourceProjectPath).toBe('/repo/catalog-suite');
    expect(spec.inputs.effectiveProjectPath).toBe('/workspace/worktrees/catalog-suite');
    expect(spec.inputs.targetSpecPath).toBe('/workspace/worktrees/catalog-suite/.specify/specs/feature/spec.md');
    expect(spec.description).toContain('Source project path: /repo/catalog-suite');
    expect(spec.description).toContain('Execution project path: /workspace/worktrees/catalog-suite');
    expect(spec.description).toContain('Target spec path: /workspace/worktrees/catalog-suite/.specify/specs/feature/spec.md');
    expect(spec.description).toContain('Create or update the target spec file directly');
  });

  it('embeds the synthesized execution contract into ace delegated tasks', () => {
    const assembler = new WorkspaceContextAssembler();

    const spec = assembler.buildAceSubtaskSpec({
      projectName: 'catalog-suite',
      projectPath: '/workspace/worktrees/catalog-suite',
      sourceProjectPath: '/repo/catalog-suite',
      effectiveProjectPath: '/workspace/worktrees/catalog-suite',
      demand: '替换 catalog-suite 本地类目DB访问为 catalog-items 外部接口，并补齐类目属性查询与缓存方案',
      specContent: '# spec',
      planContent: '# plan',
      specPath: '/workspace/worktrees/catalog-suite/.specify/specs/feature/spec.md',
      planPath: '/workspace/worktrees/catalog-suite/.specify/specs/feature/plan.md',
    });

    expect(spec.inputs.executionContract?.targetFiles).toContain(
      'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
    );
    expect(spec.description).toContain('Execution-ready target files:');
    expect(spec.description).toContain('Source project path: /repo/catalog-suite');
    expect(spec.description).toContain('Execution project path: /workspace/worktrees/catalog-suite');
    expect(spec.description).toContain('Read /workspace/worktrees/catalog-suite/.specify/specs/feature/spec.md directly from disk.');
  });
});
