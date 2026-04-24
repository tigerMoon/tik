import { describe, expect, it } from 'vitest';
import {
  buildDelegateDocumentationContract,
  buildDelegateImplementationContract,
  mapCodexCommandExecution,
  normalizeCodexShellCommand,
  shouldStopForPostPatchReadLoop,
  shouldStopForPostPatchValidation,
} from '../src/commands/codex-cli.js';

describe('codex native command mapping', () => {
  it('normalizes zsh -lc wrapper commands', () => {
    expect(normalizeCodexShellCommand(`/bin/zsh -lc 'cat foo.txt'`)).toBe('cat foo.txt');
  });

  it('maps cat to read_file', () => {
    const mapped = mapCodexCommandExecution(`/bin/zsh -lc 'cat packages/cli/package.json'`, '{"name":"@tik/cli"}');
    expect(mapped.toolName).toBe('read_file');
    expect(mapped.input).toMatchObject({ path: 'packages/cli/package.json' });
    expect(mapped.output).toContain('@tik/cli');
  });

  it('maps sed file reads to read_file', () => {
    const mapped = mapCodexCommandExecution(`/bin/zsh -lc "sed -n '1,200p' packages/shared/src/types/task.ts"`, 'export type TaskStatus = ...');
    expect(mapped.toolName).toBe('read_file');
    expect(mapped.input).toMatchObject({ path: 'packages/shared/src/types/task.ts' });
  });

  it('maps rg to grep', () => {
    const mapped = mapCodexCommandExecution(`/bin/zsh -lc 'rg "codex" packages/cli/src'`, 'packages/cli/src/index.ts:1:codex');
    expect(mapped.toolName).toBe('grep');
    expect(mapped.input).toMatchObject({ pattern: 'codex', path: 'packages/cli/src' });
  });

  it('maps rg --files and find -name to glob', () => {
    const rgFiles = mapCodexCommandExecution(`/bin/zsh -lc 'rg --files packages/dashboard/src/components'`, 'packages/dashboard/src/components/Foo.tsx');
    expect(rgFiles.toolName).toBe('glob');
    expect(rgFiles.input).toMatchObject({ pattern: 'packages/dashboard/src/components/**/*' });

    const find = mapCodexCommandExecution(`/bin/zsh -lc 'find catalog-suite-one-api/src -type f -name "*Query*.java"'`, 'catalog-suite-one-api/src/FooQuery.java');
    expect(find.toolName).toBe('glob');
    expect(find.input).toMatchObject({ cwd: 'catalog-suite-one-api/src', pattern: '*Query*.java' });
  });

  it('maps git inspection commands to git tools', () => {
    const status = mapCodexCommandExecution(`/bin/zsh -lc 'git status --short --branch'`, '## main');
    expect(status.toolName).toBe('git_status');

    const diff = mapCodexCommandExecution(`/bin/zsh -lc 'git diff --stat'`, ' foo.ts | 2 +-');
    expect(diff.toolName).toBe('git_diff');

    const log = mapCodexCommandExecution(`/bin/zsh -lc 'git log -1 --oneline'`, 'abc123 test');
    expect(log.toolName).toBe('git_log');
  });

  it('stops after a failed first validation attempt once a patch exists', () => {
    const decision = shouldStopForPostPatchValidation(
      'mvn -pl catalog-suite-application test',
      true,
      true,
      1,
      1,
    );
    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain('failed post-patch validation attempt');
  });

  it('stops before a repeated validation attempt once a patch exists', () => {
    const decision = shouldStopForPostPatchValidation(
      'mvn -pl catalog-suite-application test',
      true,
      true,
      2,
      null,
    );
    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain('repeated post-patch validation attempts');
  });

  it('does not stop non-validation commands after a patch exists', () => {
    const decision = shouldStopForPostPatchValidation(
      'git diff -- catalog-suite-application/src/main/java',
      true,
      true,
      0,
      0,
    );
    expect(decision.stop).toBe(false);
  });

  it('stops after too many post-patch read-only steps without new writes', () => {
    const decision = shouldStopForPostPatchReadLoop(
      'read_file',
      true,
      2,
      2,
      12,
    );
    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain('excessive post-patch read-only exploration');
  });

  it('does not stop post-patch read loop when a new file changed', () => {
    const decision = shouldStopForPostPatchReadLoop(
      'read_file',
      true,
      3,
      2,
      20,
    );
    expect(decision.stop).toBe(false);
  });

  it('builds a delegate implementation contract for autonomous subtask completion', () => {
    const contract = buildDelegateImplementationContract(
      '我想针对票务业务的查询接口做缓存，one-api目录',
      [
        '- Key files: catalog-suite-application/src/main/java/com/example/TicketCatalogQueryServiceImpl.java',
        '- Pending work: implement ticket query cache',
        '- Current focus: implementation',
      ].join('\n'),
      'Implementation mode is active.',
      true,
    );

    expect(contract).toContain('Delegate Implementation Contract');
    expect(contract).toContain('delegated subtask');
    expect(contract).toContain('Complete this delegated subtask end-to-end');
    expect(contract).toContain('evidence-based conclusion');
    expect(contract).toContain('Key Files / Target Paths');
    expect(contract).toContain('Pending Work');
    expect(contract).toContain('Tik has granted write-capable tools');
  });

  it('keeps delegate contract concise when no context hints are available', () => {
    const contract = buildDelegateImplementationContract(
      'implement caching',
      '',
      '',
      false,
    );

    expect(contract).toContain('Primary Objective');
    expect(contract).not.toContain('Key Files / Target Paths');
    expect(contract).not.toContain('Pending Work');
  });

  it('builds a documentation contract for workspace specify/plan subtasks', () => {
    const contract = buildDelegateDocumentationContract(
      [
        'Workspace PARALLEL_SPECIFY subtask.',
        'Single-project workflow route:',
        '- Skill: sdd-specify',
        'Target spec path: /tmp/service-a/.specify/specs/service-a-feature/spec.md',
        'Expected output: .specify/specs/{feature}/spec.md',
      ].join('\n'),
      [
        '- Likely Target Paths: .specify/specs [directory]',
      ].join('\n'),
      true,
    );

    expect(contract).toContain('Delegate Documentation Contract');
    expect(contract).toContain('markdown artifact');
    expect(contract).toContain('Explicit Artifact Targets');
    expect(contract).toContain('/tmp/service-a/.specify/specs/service-a-feature/spec.md');
    expect(contract).toContain('Do not treat this as a business-code implementation task');
    expect(contract).toContain('Do not run validation/build/test commands');
    expect(contract).toContain('Do not write to a generic `.specify/specs/spec.md`');
    expect(contract).toContain('Tik has granted write-capable tools');
  });
});
