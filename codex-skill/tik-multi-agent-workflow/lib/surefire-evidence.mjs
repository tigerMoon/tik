import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function collectSurefireEvidence(input) {
  const selectors = mavenTestSelectors(input.command);
  if (selectors.length === 0) return { reports: [], failureCodes: [] };

  const reportPaths = await findSurefireReports(input.cwd);
  const parsedReports = await Promise.all(reportPaths.map(async (reportPath) => {
    const content = await readFile(reportPath, 'utf-8');
    const metadata = await stat(reportPath);
    return { reportPath, content, metadata, parsed: parseSurefireReport(content) };
  }));
  const reports = [];
  const failureCodes = new Set();
  const startedAtMs = Date.parse(input.startedAt);

  for (const selector of selectors) {
    const matching = parsedReports.filter((report) => reportMatchesSelector(report.reportPath, report.parsed.name, selector));
    if (matching.length === 0) {
      failureCodes.add('test_report_missing');
      continue;
    }
    for (const report of matching) {
      if (Number.isFinite(startedAtMs) && report.metadata.mtimeMs < startedAtMs) failureCodes.add('stale_test_report');
      const executed = report.parsed.tests - report.parsed.skipped;
      if (report.parsed.tests <= 0 || executed <= 0) failureCodes.add('zero_tests_executed');
      if (report.parsed.failures > 0 || report.parsed.errors > 0) failureCodes.add('test_failure');

      await mkdir(input.artifactDir, { recursive: true });
      const destination = path.join(input.artifactDir, path.basename(report.reportPath));
      await cp(report.reportPath, destination);
      reports.push({
        selector,
        className: report.parsed.name || selector,
        tests: report.parsed.tests,
        failures: report.parsed.failures,
        errors: report.parsed.errors,
        skipped: report.parsed.skipped,
        generatedAt: report.metadata.mtime.toISOString(),
        artifactId: path.relative(input.projectRoot, destination).replace(/\\/g, '/'),
        artifactSha256: `sha256:${createHash('sha256').update(report.content).digest('hex')}`,
        artifactBytes: Buffer.byteLength(report.content),
      });
    }
  }
  return { reports, failureCodes: Array.from(failureCodes) };
}

export function parseSurefireReport(xml) {
  const suite = xml.match(/<testsuite\b([^>]*)>/i)?.[1] || '';
  return {
    name: xmlAttribute(suite, 'name'),
    tests: numberAttribute(suite, 'tests'),
    failures: numberAttribute(suite, 'failures'),
    errors: numberAttribute(suite, 'errors'),
    skipped: numberAttribute(suite, 'skipped'),
  };
}

function mavenTestSelectors(command) {
  const match = command.match(/(?:^|\s)-Dtest=("[^"]+"|'[^']+'|[^\s]+)/);
  if (!match) return [];
  return match[1].replace(/^['"]|['"]$/g, '').split(',')
    .map((selector) => selector.split('#')[0].split('.').at(-1)?.trim() || '')
    .filter(Boolean);
}

async function findSurefireReports(root) {
  const reports = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.git' || entry.name === '.tik' || entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && path.basename(path.dirname(absolute)) === 'surefire-reports' && /^TEST-.+\.xml$/.test(entry.name)) {
        reports.push(absolute);
      }
    }
  };
  await visit(root);
  return reports;
}

function reportMatchesSelector(reportPath, suiteName, selector) {
  const reportName = path.basename(reportPath, '.xml').replace(/^TEST-/, '');
  return reportName === selector || reportName.endsWith(`.${selector}`)
    || suiteName === selector || suiteName.endsWith(`.${selector}`);
}

function xmlAttribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || '';
}

function numberAttribute(attributes, name) {
  const value = Number(xmlAttribute(attributes, name));
  return Number.isFinite(value) ? value : 0;
}
