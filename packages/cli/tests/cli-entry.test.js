import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
function sourcePath(relativePath) {
    return path.join(sourceRoot, relativePath);
}
describe('CLI entrypoint', () => {
    it('awaits Commander async actions so long-running commands stay alive', async () => {
        const source = await fs.readFile(sourcePath('index.ts'), 'utf-8');
        expect(source).toContain('program.parseAsync');
        expect(source).not.toContain('program.parse();');
    });
    it('registers workflow v2 lifecycle commands', async () => {
        const source = await fs.readFile(sourcePath('index.ts'), 'utf-8');
        const workflowSource = await fs.readFile(sourcePath('cli/workflow-command-registration.ts'), 'utf-8');
        expect(source).toContain('registerWorkflowCommands(program');
        expect(workflowSource).toContain(".command('workflow [command] [taskId]')");
        expect(workflowSource).toContain('initWorkflowV2');
        expect(workflowSource).toContain('validateWorkflow');
        expect(workflowSource).toContain('explainWorkflowTask');
    });
    it('defaults serve to localhost and exposes an explicit host override', async () => {
        const source = await fs.readFile(sourcePath('cli/serve-command.ts'), 'utf-8');
        expect(source).toContain(".option('--host <host>', 'Host interface to bind', 'localhost')");
        expect(source).toContain("host: opts.host");
        expect(source).not.toContain("host: '0.0.0.0'");
    });
    it('uses port 3300 for serve and API client defaults', async () => {
        const source = await fs.readFile(sourcePath('index.ts'), 'utf-8');
        const serveSource = await fs.readFile(sourcePath('cli/serve-command.ts'), 'utf-8');
        expect(source).toContain("const DEFAULT_API_BASE_URL = 'http://localhost:3300'");
        expect(source).not.toContain("'http://localhost:3000'");
        expect(serveSource).toContain(".option('-p, --port <port>', 'Port', '3300')");
        expect(serveSource).not.toContain(".option('-p, --port <port>', 'Port', '3000')");
    });
});
//# sourceMappingURL=cli-entry.test.js.map