import { describe, expect, it } from 'vitest';
import { collectCompletionEvidence, summarizeCompletionEvidence } from '../src/workspace-completion-evidence.js';

describe('workspace completion evidence', () => {
  it('collects changed contract targets and validation artifacts', () => {
    const evidence = collectCompletionEvidence(
      [
        'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
        'catalog-suite-application/src/test/java/com/example/catalog/service/category/impl/CategoryQueryServiceImplTest.java',
      ],
      {
        summary: 'Category integration path',
        targetFiles: [
          'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
        ],
      },
    );

    expect(evidence).toMatchObject({
      matchedTargets: [
        'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
      ],
      artifacts: [
        'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
      ],
      changedTests: [
        'catalog-suite-application/src/test/java/com/example/catalog/service/category/impl/CategoryQueryServiceImplTest.java',
      ],
      validationRuns: [
        'changed-test:catalog-suite-application/src/test/java/com/example/catalog/service/category/impl/CategoryQueryServiceImplTest.java',
      ],
    });
    expect(summarizeCompletionEvidence(evidence!)).toContain('Detected implementation artifacts matching the ACE execution contract');
  });

  it('returns null when no contract targets were changed', () => {
    const evidence = collectCompletionEvidence(
      ['catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/OtherService.java'],
      {
        summary: 'Category integration path',
        targetFiles: [
          'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
        ],
      },
    );

    expect(evidence).toBeNull();
  });

  it('treats js/ts test paths as validation artifacts', () => {
    const evidence = collectCompletionEvidence(
      [
        'src/greet.js',
        'test/greet.test.js',
      ],
      {
        summary: 'greet behavior change',
        targetFiles: [
          'src/greet.js',
        ],
      },
    );

    expect(evidence?.changedTests).toEqual(['test/greet.test.js']);
    expect(evidence?.validationRuns).toEqual(['changed-test:test/greet.test.js']);
    expect(evidence?.validationSummary).toContain('test/greet.test.js');
  });
});
