import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  frontendAccessibilityAuditTool,
  frontendDomQueryTool,
  frontendHtmlSnapshotTool,
} from '../src/tools-frontend.js';

const tempDirs: string[] = [];

async function makeBrowserProbeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-frontend-browser-'));
  tempDirs.push(root);

  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'frontend-browser-probe',
      scripts: {
        dev: 'node ./scripts/dev-server.js 43124',
      },
      dependencies: {
        react: '^18.3.0',
      },
      devDependencies: {
        vite: '^6.0.0',
      },
    }, null, 2),
    'utf-8',
  );
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n', 'utf-8');
  await fs.writeFile(
    path.join(root, 'scripts', 'dev-server.js'),
    [
      "const http = require('http');",
      "const port = Number(process.argv[2] || '43124');",
      'const html = `<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8" />',
      '  <title>Frontend Probe</title>',
      '  <link rel="stylesheet" href="/app.css" />',
      '</head>',
      '<body>',
      '  <div id="app" class="shell">',
      '    <header><h1>Probe Home</h1><h2>Hero Section</h2></header>',
      '    <main>',
      '      <button class="cta">Launch</button>',
      '      <button class="icon-only"></button>',
      '      <img src="/hero.png" />',
      '      <a class="ghost-link">Missing href</a>',
      '      <input id="email" type="email" />',
      '      <label for="email">Email</label>',
      '      <section data-testid="hero-panel"><p>Fast preview body</p></section>',
      '    </main>',
      '  </div>',
      '</body>',
      '</html>`;',
      "const server = http.createServer((_req, res) => {",
      "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
      '  res.end(html);',
      '});',
      "server.listen(port, '127.0.0.1', () => {",
      "  console.log(`Local: http://127.0.0.1:${port}/`);",
      '});',
      "const shutdown = () => server.close(() => process.exit(0));",
      "process.on('SIGTERM', shutdown);",
      "process.on('SIGINT', shutdown);",
    ].join('\n'),
    'utf-8',
  );

  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('frontend browser-lite tools', () => {
  it('frontend_html_snapshot captures title, headings, and key page structure from a local preview', async () => {
    const root = await makeBrowserProbeRepo();

    const result = await frontendHtmlSnapshotTool.execute({
      timeoutMs: 10_000,
    }, {
      cwd: root,
      taskId: 'snapshot-task',
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.title).toBe('Frontend Probe');
    expect(output.h1).toEqual(['Probe Home']);
    expect(output.h2).toEqual(['Hero Section']);
    expect(output.landmarkCounts).toMatchObject({ buttons: 2, images: 1, forms: 0 });
    expect(String(output.url || '')).toContain('127.0.0.1:43124');
  });

  it('frontend_dom_query returns matches for simple selector queries against the preview DOM', async () => {
    const root = await makeBrowserProbeRepo();

    const result = await frontendDomQueryTool.execute({
      selector: '#app',
      timeoutMs: 10_000,
    }, {
      cwd: root,
      taskId: 'dom-query-task',
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.matchCount).toBe(1);
    expect(output.matches).toEqual([
      expect.objectContaining({
        tag: 'div',
        id: 'app',
      }),
    ]);
  });

  it('frontend_accessibility_audit reports common structural accessibility issues', async () => {
    const root = await makeBrowserProbeRepo();

    const result = await frontendAccessibilityAuditTool.execute({
      timeoutMs: 10_000,
    }, {
      cwd: root,
      taskId: 'a11y-task',
    });

    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    const issues = output.issues as Array<Record<string, unknown>>;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'image-alt', severity: 'major' }),
      expect.objectContaining({ rule: 'button-name', severity: 'major' }),
      expect.objectContaining({ rule: 'anchor-href', severity: 'moderate' }),
    ]));
  });
});
