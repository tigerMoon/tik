import { spawnSync } from 'node:child_process';
import type { WorkflowExecutionReadyContract } from '@tik/shared';

export interface ExecutionContractSynthesisInput {
  projectPath: string;
  demand: string;
  specContent?: string;
  planContent?: string;
}

export class WorkspaceExecutionContractSynthesizer {
  synthesize(input: ExecutionContractSynthesisInput): WorkflowExecutionReadyContract | undefined {
    const { projectPath } = input;
    const sourceText = `${input.demand}\n${input.specContent || ''}\n${input.planContent || ''}`;
    const tokens = sourceText.toLowerCase();
    const categoryModernization = projectPath.includes('catalog-suite')
      && tokens.includes('catalog-items')
      && (tokens.includes('类目') || tokens.includes('category') || tokens.includes('cate'));

    const genericContract = this.buildGenericContract(projectPath, sourceText, input.demand);

    if (categoryModernization) {
      return this.mergeContracts(genericContract, {
        summary: 'Constrain the first ACE implementation attempt to the category query/category property integration path so Codex updates catalog-items-backed category reads before exploring unrelated modules.',
        targetFiles: [
          'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategoryQueryServiceImpl.java',
          'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategorySnapshotServiceImpl.java',
          'catalog-suite-application/src/main/java/com/example/catalog/service/category/impl/CategorySnapshotAdapterImpl.java',
          'catalog-suite-application/src/main/java/com/example/catalog/service/openapi/impl/OpenApiCategoryServiceImpl.java',
          'catalog-suite-application/src/main/java/com/example/catalog/manager/convert/category/CategoryConverter.java',
          'catalog-suite-infrastructure/catalog-suite-integration/src/main/java/com/example/catalog/integration/feign/mng/itemsb/CatalogCategoryPropConsumer.java',
          'catalog-suite-application/src/test/java/com/example/catalog/service/category/impl/CategoryQueryServiceImplTest.java',
          'catalog-suite-application/src/test/java/com/example/catalog/service/category/CategorySnapshotServiceImplTest.java',
        ],
        targetMethods: [
          'CategoryQueryServiceImpl category read path',
          'CategorySnapshotServiceImpl snapshot/cache refresh path',
          'OpenApiCategoryServiceImpl category response path',
        ],
        cachePatternReferences: [
          'CategorySnapshotServiceImpl snapshot refresh fallback',
          'CategoryCacheWarmUpServiceImpl warmup flow',
        ],
        validationTargets: [
          'category query/application tests covering catalog-items-backed category reads',
          'category property cache behavior or fallback validation',
        ],
        searchHints: [
          'Keep CategoryQualificationHelper focused on access qualification rules unless a plan step explicitly replaces it.',
          'Prefer CategoryConverter/CategoryDTO alignment over introducing new outward response shapes.',
          'Treat CatalogCategoryPropConsumer as the category-property integration boundary and add cache semantics around that path.',
        ],
      });
    }

    if (projectPath.includes('catalog-suite') && tokens.includes('one-api') && (tokens.includes('ticket') || tokens.includes('票务'))) {
      return this.mergeContracts(genericContract, {
        summary: 'Narrow the first implementation attempt to the one-api ticket auth query path and reuse existing Redis cache conventions before widening exploration.',
        targetFiles: [
          'catalog-suite-one-api/src/main/java/com/example/catalog/one/api/service/config/CatalogConfigService.java',
          'catalog-suite-application/src/main/java/com/example/catalog/service/config/CatalogConfigServiceImpl.java',
          'catalog-suite-infrastructure/catalog-suite-dal/src/main/java/com/example/catalog/infra/dal/dal/redis/RedisKeyHelper.java',
        ],
        targetMethods: [
          'CatalogConfigServiceImpl#getUserAuth',
          'CatalogConfigServiceImpl#checkCompassAuth',
        ],
        cachePatternReferences: [
          'ProfileCheckServiceImpl#getProfileInfoCacheable',
          'OpenApiCommonServiceImpl#checkAndSetApiQps',
        ],
        validationTargets: [
          'catalog-suite-application test covering CatalogConfigServiceImpl ticket auth query cache behavior',
          'minimal git diff showing concrete cache integration in one-api ticket query path',
        ],
        searchHints: [
          'Treat TicketShopQueryServiceImpl as behavior reference only for compass auth semantics.',
          'Prefer RedisKeyHelper.queryAccountByMid/queryPermissionByMid if they fit cache key semantics.',
        ],
      });
    }

    return genericContract;
  }

  private buildGenericContract(
    projectPath: string,
    sourceText: string,
    demand: string,
  ): WorkflowExecutionReadyContract | undefined {
    const explicitPaths = extractExplicitPaths(sourceText);
    const explicitMethods = extractExplicitMethods(sourceText);
    const functionCalls = extractFunctionCalls(sourceText);
    const classCandidates = this.resolveClassCandidates(projectPath, extractClassNames(sourceText));
    const functionCandidates = this.resolveFunctionCandidates(projectPath, functionCalls);
    const validationTargets = extractValidationTargets(sourceText);
    const inferredTests = inferTestTargets({
      targetFiles: [...explicitPaths, ...classCandidates, ...functionCandidates],
      validationTargets,
      sourceText,
    });

    const candidateFiles = rankCandidateFiles(
      [...explicitPaths, ...classCandidates, ...functionCandidates, ...inferredTests],
      sourceText,
      validationTargets,
    );
    const targetFiles = candidateFiles.map((candidate) => candidate.path);
    const targetMethods = dedupe([...explicitMethods, ...functionCalls]);
    const validations = dedupe(validationTargets.length > 0
      ? validationTargets
      : buildValidationTargetsFromDemand(demand, inferredTests, functionCalls));
    const signals = dedupe([
      explicitPaths.length > 0 ? `explicit-paths:${explicitPaths.length}` : '',
      classCandidates.length > 0 ? `class-candidates:${classCandidates.length}` : '',
      functionCandidates.length > 0 ? `function-candidates:${functionCandidates.length}` : '',
      inferredTests.length > 0 ? `inferred-tests:${inferredTests.length}` : '',
      targetMethods.length > 0 ? `target-methods:${targetMethods.length}` : '',
      validations.length > 0 ? `validation-targets:${validations.length}` : '',
    ]);
    const confidence = candidateFiles.length > 0
      ? Math.min(0.95, 0.35 + (candidateFiles[0]?.score || 0) / 20 + validations.length * 0.05)
      : undefined;

    if (!targetFiles.length && !targetMethods.length && !validations.length) {
      return undefined;
    }

    return {
      summary: `Focus the first ACE implementation attempt on the highest-signal files and methods referenced by the current demand/spec/plan for: ${demand}`,
      confidence,
      rationale: confidence && confidence >= 0.75
        ? 'High-signal contract derived from explicit paths/symbols and repository matches.'
        : 'Contract derived from inferred symbols and repository candidate ranking; validate before widening scope.',
      targetFiles,
      candidateFiles,
      targetMethods,
      validationTargets: validations,
      artifacts: targetFiles,
      signals,
      searchHints: [
        'Prefer the explicitly referenced files and classes extracted from the current spec/plan before widening repository exploration.',
        'Treat inferred target files as the first implementation frontier and promote matching git evidence to completion only after validation signals exist.',
      ],
    };
  }

  private resolveClassCandidates(projectPath: string, classNames: string[]): string[] {
    if (classNames.length === 0) return [];
    const files = spawnSync('rg', ['--files', projectPath, '-g', '*.java', '-g', '*.kt', '-g', '*.ts', '-g', '*.tsx'], {
      encoding: 'utf-8',
    });
    if (files.status !== 0) return [];
    const repoFiles = (files.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const candidates: string[] = [];
    for (const className of classNames) {
      const suffixes = [`/${className}.java`, `/${className}.kt`, `/${className}.ts`, `/${className}.tsx`];
      const match = repoFiles.find((file) => suffixes.some((suffix) => file.endsWith(suffix)));
      if (match) candidates.push(match);
    }
    return dedupe(candidates);
  }

  private resolveFunctionCandidates(projectPath: string, functionNames: string[]): string[] {
    if (functionNames.length === 0) return [];
    const files = spawnSync('rg', ['--files', projectPath, '-g', '*.js', '-g', '*.jsx', '-g', '*.ts', '-g', '*.tsx'], {
      encoding: 'utf-8',
    });
    if (files.status !== 0) return [];
    const repoFiles = (files.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const patterns = functionNames.flatMap((functionName) => [
      `export function ${functionName}`,
      `function ${functionName}`,
      `const ${functionName} =`,
      `let ${functionName} =`,
      `${functionName}: (`,
      `${functionName}(`,
    ]);
    const matches = spawnSync('rg', ['-l', ...patterns.flatMap((pattern) => ['-e', pattern]), projectPath, '-g', '*.js', '-g', '*.jsx', '-g', '*.ts', '-g', '*.tsx'], {
      encoding: 'utf-8',
    });
    const contentMatches = matches.status === 0
      ? (matches.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
      : [];
    const basenameMatches = functionNames.flatMap((functionName) => {
      const normalized = functionName.toLowerCase();
      return repoFiles.filter((file) => {
        const base = file.split('/').pop()?.toLowerCase() || '';
        return base === `${normalized}.js`
          || base === `${normalized}.ts`
          || base === `${normalized}.jsx`
          || base === `${normalized}.tsx`
          || base === `${normalized}.test.js`
          || base === `${normalized}.test.ts`
          || base === `${normalized}.spec.js`
          || base === `${normalized}.spec.ts`;
      });
    });
    return dedupe([...contentMatches, ...basenameMatches]).slice(0, 12);
  }

  private mergeContracts(
    base: WorkflowExecutionReadyContract | undefined,
    override: WorkflowExecutionReadyContract,
  ): WorkflowExecutionReadyContract {
    return {
      summary: override.summary || base?.summary,
      confidence: Math.max(override.confidence || 0, base?.confidence || 0) || undefined,
      rationale: override.rationale || base?.rationale,
      targetFiles: dedupe([...(override.targetFiles || []), ...(base?.targetFiles || [])]),
      candidateFiles: mergeCandidateFiles(override.candidateFiles || [], base?.candidateFiles || []),
      targetMethods: dedupe([...(override.targetMethods || []), ...(base?.targetMethods || [])]),
      cachePatternReferences: dedupe([...(override.cachePatternReferences || []), ...(base?.cachePatternReferences || [])]),
      validationTargets: dedupe([...(override.validationTargets || []), ...(base?.validationTargets || [])]),
      searchHints: dedupe([...(override.searchHints || []), ...(base?.searchHints || [])]),
      artifacts: dedupe([...(override.artifacts || []), ...(base?.artifacts || []), ...(override.targetFiles || []), ...(base?.targetFiles || [])]),
      signals: dedupe([...(override.signals || []), ...(base?.signals || [])]),
    };
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractExplicitPaths(sourceText: string): string[] {
  const matches = sourceText.match(/[\w./-]+\.(?:java|kt|ts|tsx|js|jsx|xml|yml|yaml|md)/g) || [];
  return dedupe(matches);
}

function extractExplicitMethods(sourceText: string): string[] {
  const matches = sourceText.match(/\b[A-Z][A-Za-z0-9_]+#[A-Za-z0-9_]+\b/g) || [];
  return dedupe(matches);
}

function extractFunctionCalls(sourceText: string): string[] {
  const matches = sourceText.match(/\b[a-z][A-Za-z0-9_]{2,}\s*\([^)\n]{0,80}\)/g) || [];
  return dedupe(matches
    .map((match) => match.split('(')[0]?.trim() || '')
    .filter((name) => !RESERVED_FUNCTION_NAMES.has(name)));
}

function extractClassNames(sourceText: string): string[] {
  const matches = sourceText.match(/\b[A-Z][A-Za-z0-9]+(?:Service|ServiceImpl|Controller|Manager|Adapter|Converter|Consumer|Facade|Handler|QueryServiceImpl|Repository|Client)\b/g) || [];
  return dedupe(matches).slice(0, 12);
}

function extractValidationTargets(sourceText: string): string[] {
  return sourceText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /test|测试|验证|validation|校验|assert/i.test(line))
    .slice(0, 12);
}

function inferTestTargets(input: {
  targetFiles: string[];
  validationTargets: string[];
  sourceText: string;
}): string[] {
  const wantsTests = /test|测试|验证|validation|assert/i.test(`${input.sourceText}\n${input.validationTargets.join('\n')}`);
  if (!wantsTests) return [];
  const inferred: string[] = [];
  for (const file of input.targetFiles) {
    if (isTestLikePath(file)) continue;
    const extMatch = file.match(/\.(js|jsx|ts|tsx|java|kt)$/);
    if (!extMatch) continue;
    const ext = extMatch[1];
    if (file.includes('/src/')) {
      inferred.push(file.replace('/src/', '/test/').replace(new RegExp(`\\.${ext}$`), `.test.${ext}`));
      inferred.push(file.replace('/src/', '/tests/').replace(new RegExp(`\\.${ext}$`), `.test.${ext}`));
    }
    const basename = file.replace(new RegExp(`\\.${ext}$`), '');
    inferred.push(`${basename}.test.${ext}`);
    inferred.push(`${basename}.spec.${ext}`);
  }
  return dedupe(inferred);
}

function buildValidationTargetsFromDemand(
  demand: string,
  inferredTests: string[],
  functionCalls: string[],
): string[] {
  const targets: string[] = [];
  if (/test|测试|验证|validation|assert/i.test(demand)) {
    if (inferredTests.length > 0) {
      targets.push(`Target test files: ${inferredTests.join(', ')}`);
    }
    if (functionCalls.length > 0) {
      targets.push(`Validate behavior for: ${functionCalls.join(', ')}`);
    }
  }
  return dedupe(targets);
}

function rankCandidateFiles(
  files: string[],
  sourceText: string,
  validationTargets: string[],
): Array<{ path: string; score: number; reason: string }> {
  const lowered = sourceText.toLowerCase();
  return dedupe(files)
    .map((file) => {
      let score = 1;
      const reasons: string[] = [];
      if (extractExplicitPaths(sourceText).includes(file)) {
        score += 8;
        reasons.push('explicit-path');
      }
      if (isTestLikePath(file)) {
        score += validationTargets.length > 0 || /test|测试|验证|validation|assert/i.test(sourceText) ? 5 : 1;
        reasons.push('validation-target');
      } else if (/src\//.test(file) || /\.(js|jsx|ts|tsx|java|kt)$/.test(file)) {
        score += 3;
        reasons.push('source-file');
      }
      const base = file.split('/').pop()?.toLowerCase() || '';
      if (base && lowered.includes(base.replace(/\.(test|spec)\./, '.').replace(/\.[^.]+$/, ''))) {
        score += 4;
        reasons.push('name-mentioned');
      }
      return {
        path: file,
        score,
        reason: reasons.join(', ') || 'repo-candidate',
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 16);
}

function mergeCandidateFiles(
  primary: Array<{ path: string; score: number; reason: string }>,
  secondary: Array<{ path: string; score: number; reason: string }>,
): Array<{ path: string; score: number; reason: string }> {
  const merged = new Map<string, { path: string; score: number; reason: string }>();
  for (const candidate of [...primary, ...secondary]) {
    const existing = merged.get(candidate.path);
    if (!existing || candidate.score > existing.score) {
      merged.set(candidate.path, candidate);
      continue;
    }
    merged.set(candidate.path, {
      path: existing.path,
      score: Math.max(existing.score, candidate.score),
      reason: dedupe([existing.reason, candidate.reason]).join(', '),
    });
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function isTestLikePath(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./i.test(file);
}

const RESERVED_FUNCTION_NAMES = new Set([
  'return',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'assert',
  'expect',
  'test',
  'describe',
  'it',
]);
