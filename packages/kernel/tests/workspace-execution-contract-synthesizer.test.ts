import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceExecutionContractSynthesizer } from '../src/workspace-execution-contract-synthesizer.js';

describe('WorkspaceExecutionContractSynthesizer', () => {
  it('synthesizes the catalog-items category contract for catalog-suite demands', () => {
    const synthesizer = new WorkspaceExecutionContractSynthesizer();

    const contract = synthesizer.synthesize({
      projectPath: '/repo/catalog-suite',
      demand: '替换 catalog-suite 本地类目DB访问为 catalog-items 外部接口，并补齐类目属性查询与缓存方案',
    });

    expect(contract?.summary).toContain('category');
    expect(contract?.targetFiles).toContain(
      'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
    );
    expect(contract?.validationTargets?.[0]).toContain('category');
  });

  it('returns undefined for unrelated projects', () => {
    const synthesizer = new WorkspaceExecutionContractSynthesizer();

    const contract = synthesizer.synthesize({
      projectPath: '/repo/service-a',
      demand: '给 service-a 加一个简单字段',
    });

    expect(contract).toBeUndefined();
  });

  it('extracts generic file, method, artifact, and validation targets from spec and plan text', () => {
    const synthesizer = new WorkspaceExecutionContractSynthesizer();

    const contract = synthesizer.synthesize({
      projectPath: '/repo/service-a',
      demand: '在 UserProfileService 增加缓存并补齐测试',
      specContent: [
        '需要修改 src/main/java/com/example/user/service/UserProfileService.java',
        '并调用 UserProfileService#loadProfile',
      ].join('\n'),
      planContent: [
        '新增验证目标: unit test for UserProfileService',
        '更新 docs/design.md 记录缓存策略',
      ].join('\n'),
    });

    expect(contract).toEqual(expect.objectContaining({
      targetFiles: expect.arrayContaining([
        'src/main/java/com/example/user/service/UserProfileService.java',
        'docs/design.md',
      ]),
      targetMethods: expect.arrayContaining(['UserProfileService#loadProfile']),
      validationTargets: expect.arrayContaining(['新增验证目标: unit test for UserProfileService']),
      artifacts: expect.arrayContaining([
        'src/main/java/com/example/user/service/UserProfileService.java',
        'docs/design.md',
      ]),
    }));
  });

  it('infers js source, test files, and function targets from demand and repo files', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-contract-synth-'));
    try {
      await fs.mkdir(path.join(rootPath, 'src'), { recursive: true });
      await fs.mkdir(path.join(rootPath, 'test'), { recursive: true });
      await fs.writeFile(path.join(rootPath, 'src', 'greet.js'), 'export function greet(name) { return name; }\n', 'utf-8');
      await fs.writeFile(path.join(rootPath, 'test', 'greet.test.js'), 'import { greet } from "../src/greet.js";\n', 'utf-8');

      const synthesizer = new WorkspaceExecutionContractSynthesizer();
      const contract = synthesizer.synthesize({
        projectPath: rootPath,
        demand: '让 greet(name) 对空字符串和空白字符串回退为 Guest，并补齐测试',
      });

      expect(contract).toEqual(expect.objectContaining({
        targetFiles: expect.arrayContaining([
          expect.stringMatching(/src\/greet\.js$/),
          expect.stringMatching(/test\/greet\.test\.js$/),
        ]),
        targetMethods: expect.arrayContaining(['greet']),
      }));
      expect(contract?.confidence).toBeGreaterThan(0.3);
      expect(contract?.candidateFiles?.[0]?.path).toMatch(/greet/);
      expect(contract?.signals).toEqual(expect.arrayContaining([
        expect.stringMatching(/function-candidates/),
      ]));
      expect(contract?.validationTargets?.join('\n')).toMatch(/greet|test/i);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
