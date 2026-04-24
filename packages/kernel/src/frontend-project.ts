import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FrontendProjectReport {
  framework: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
  scripts: Record<string, string>;
  entrypoints: string[];
  componentRoots: string[];
  styleRoots: string[];
  testRoots: string[];
  storyRoots: string[];
  configFiles: string[];
  dependencies: string[];
  designSystemSignals: string[];
  score: number;
  isFrontend: boolean;
}

const FRONTEND_TASK_KEYWORDS = [
  'frontend',
  'ui',
  'ux',
  '页面',
  '组件',
  '样式',
  '布局',
  '交互',
  '动画',
  '响应式',
  'responsive',
  'css',
  'scss',
  'tailwind',
  'hero',
  'tsx',
  'jsx',
  'react',
  'vue',
  'next',
  'vite',
  'storybook',
];

const BACKEND_TASK_KEYWORDS = [
  'api',
  '接口',
  '数据库',
  'db',
  'sql',
  'redis',
  'mq',
  'cache',
  'dal',
  'repository',
  'controller',
  'serviceimpl',
  'rpc',
  'feign',
];

const PACKAGE_LOCKFILES: Record<FrontendProjectReport['packageManager'], string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lockb', 'bun.lock'],
  unknown: [],
};

const FRONTEND_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.ts',
  'astro.config.mjs',
  'tailwind.config.js',
  'tailwind.config.ts',
  'postcss.config.js',
  'postcss.config.cjs',
  '.storybook/main.ts',
  '.storybook/main.js',
];

const ENTRYPOINT_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/App.tsx',
  'src/App.jsx',
  'app/page.tsx',
  'app/layout.tsx',
  'pages/index.tsx',
  'pages/_app.tsx',
];

const COMPONENT_ROOT_CANDIDATES = [
  'src/components',
  'components',
  'app/components',
];

const STYLE_ROOT_CANDIDATES = [
  'src/styles',
  'styles',
  'src/css',
  'app/styles',
];

const TEST_ROOT_CANDIDATES = [
  'src/__tests__',
  'tests',
  'cypress',
  'playwright',
];

const STORY_ROOT_CANDIDATES = [
  '.storybook',
  'stories',
  'src/stories',
];

function existingPaths(projectPath: string, candidates: string[]): string[] {
  return candidates
    .map((candidate) => path.join(projectPath, candidate))
    .filter((candidate) => fs.existsSync(candidate));
}

function readPackageJson(projectPath: string): {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  const filePath = path.join(projectPath, 'package.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: json.scripts || {},
      dependencies: json.dependencies || {},
      devDependencies: json.devDependencies || {},
    };
  } catch {
    return {
      scripts: {},
      dependencies: {},
      devDependencies: {},
    };
  }
}

function detectPackageManager(projectPath: string): FrontendProjectReport['packageManager'] {
  for (const [manager, files] of Object.entries(PACKAGE_LOCKFILES) as Array<[FrontendProjectReport['packageManager'], string[]]>) {
    if (manager === 'unknown') continue;
    if (files.some((file) => fs.existsSync(path.join(projectPath, file)))) {
      return manager;
    }
  }
  return 'unknown';
}

function detectFramework(args: {
  dependencies: string[];
  configFiles: string[];
  entrypoints: string[];
}): string {
  const dependencies = new Set(args.dependencies);
  const configFiles = args.configFiles.map((file) => path.basename(file));
  const hasConfig = (prefix: string) => configFiles.some((file) => file.startsWith(prefix));

  if (dependencies.has('next') || hasConfig('next.config')) return 'next';
  if (dependencies.has('nuxt') || hasConfig('nuxt.config')) return 'nuxt';
  if (dependencies.has('astro') || hasConfig('astro.config')) return 'astro';
  if (dependencies.has('vue') && dependencies.has('vite')) return 'vue-vite';
  if (dependencies.has('react') && dependencies.has('vite')) return 'react-vite';
  if (dependencies.has('react')) return 'react';
  if (dependencies.has('vue')) return 'vue';
  if (args.entrypoints.some((entry) => entry.endsWith('.tsx') || entry.endsWith('.jsx'))) return 'frontend-tsx';
  return 'unknown';
}

function collectDesignSystemSignals(args: {
  dependencies: string[];
  configFiles: string[];
  componentRoots: string[];
  storyRoots: string[];
}): string[] {
  const signals: string[] = [];
  const dependencies = new Set(args.dependencies);
  if (dependencies.has('tailwindcss')) signals.push('tailwindcss');
  if (dependencies.has('@storybook/react') || args.storyRoots.length > 0) signals.push('storybook');
  if (dependencies.has('@radix-ui/react-slot') || dependencies.has('@headlessui/react')) signals.push('headless-ui');
  if (args.componentRoots.length > 0) signals.push('component-root');
  if (args.configFiles.some((file) => file.includes('tailwind.config'))) signals.push('tailwind-config');
  return Array.from(new Set(signals));
}

export function inspectFrontendProject(projectPath: string): FrontendProjectReport {
  const pkg = readPackageJson(projectPath);
  const dependencies = Array.from(new Set([
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.devDependencies),
  ])).sort();
  const configFiles = existingPaths(projectPath, FRONTEND_CONFIG_CANDIDATES);
  const entrypoints = existingPaths(projectPath, ENTRYPOINT_CANDIDATES);
  const componentRoots = existingPaths(projectPath, COMPONENT_ROOT_CANDIDATES);
  const styleRoots = existingPaths(projectPath, STYLE_ROOT_CANDIDATES);
  const testRoots = existingPaths(projectPath, TEST_ROOT_CANDIDATES);
  const storyRoots = existingPaths(projectPath, STORY_ROOT_CANDIDATES);
  const designSystemSignals = collectDesignSystemSignals({
    dependencies,
    configFiles,
    componentRoots,
    storyRoots,
  });
  const framework = detectFramework({ dependencies, configFiles, entrypoints });
  const packageManager = detectPackageManager(projectPath);

  let score = 0;
  if (Object.keys(pkg.scripts).length > 0) score += 1;
  if (framework !== 'unknown') score += 3;
  if (configFiles.length > 0) score += 2;
  if (entrypoints.length > 0) score += 2;
  if (componentRoots.length > 0 || styleRoots.length > 0) score += 1;

  return {
    framework,
    packageManager,
    scripts: pkg.scripts,
    entrypoints,
    componentRoots,
    styleRoots,
    testRoots,
    storyRoots,
    configFiles,
    dependencies,
    designSystemSignals,
    score,
    isFrontend: score >= 4,
  };
}

export function isLikelyFrontendTask(
  taskDescription: string,
  report?: FrontendProjectReport,
): boolean {
  const lowered = taskDescription.toLowerCase();
  const hasFrontendKeyword = FRONTEND_TASK_KEYWORDS.some((keyword) => lowered.includes(keyword));
  const hasBackendKeyword = BACKEND_TASK_KEYWORDS.some((keyword) => lowered.includes(keyword));

  if (hasFrontendKeyword) return true;
  if (hasBackendKeyword) return false;
  return Boolean(report?.isFrontend);
}
