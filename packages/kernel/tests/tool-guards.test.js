import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bashTool, globTool, readFileTool, writeFileTool } from '../src/tools.js';
import { editFileTool, grepTool } from '../src/tools-search.js';
const tempDirs = [];
async function makeRepo() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tool-guards-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'catalog-suite-one-api', 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'unrelated', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'catalog-suite-one-api', 'src', 'CatalogQueryService.java'), 'class CatalogQueryService { String cacheKey = "query-cache"; }\n', 'utf-8');
    await fs.writeFile(path.join(root, 'unrelated', 'src', 'OtherService.java'), 'class OtherService { String nothing = "noop"; }\n', 'utf-8');
    return root;
}
function createContext(root, likelyTargetPaths) {
    return {
        cwd: root,
        taskId: 'task-test',
        likelyTargetPaths,
    };
}
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('tool search guards', () => {
    it('file tools reject parent traversal, absolute paths, and symlink escapes', async () => {
        const root = await makeRepo();
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tool-outside-'));
        tempDirs.push(outside);
        await fs.writeFile(path.join(outside, 'secret.txt'), 'do not read\n', 'utf-8');
        await fs.symlink(outside, path.join(root, 'linked-outside'));
        const context = createContext(root);
        const attempts = await Promise.all([
            readFileTool.execute({ path: '../outside.txt' }, context),
            readFileTool.execute({ path: path.join(outside, 'secret.txt') }, context),
            readFileTool.execute({ path: 'linked-outside/secret.txt' }, context),
            writeFileTool.execute({ path: '../outside.txt', content: 'escape' }, context),
            editFileTool.execute({
                path: 'linked-outside/secret.txt',
                old_string: 'do not read',
                new_string: 'escaped',
            }, context),
        ]);
        for (const result of attempts) {
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/outside the workspace|absolute paths are not allowed|parent traversal/i);
        }
        await expect(fs.readFile(path.join(outside, 'secret.txt'), 'utf-8')).resolves.toBe('do not read\n');
    });
    it('read_file refuses to read directories', async () => {
        const root = await makeRepo();
        const result = await readFileTool.execute({ path: 'catalog-suite-one-api' }, createContext(root));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Refusing to read directory');
    });
    it('glob auto-scopes broad searches to likely target paths', async () => {
        const root = await makeRepo();
        const result = await globTool.execute({ pattern: '**/*', cwd: '.' }, createContext(root, [path.join(root, 'catalog-suite-one-api')]));
        expect(result.success).toBe(true);
        const files = result.output;
        expect(files.some((file) => file.includes('catalog-suite-one-api/src/CatalogQueryService.java'))).toBe(true);
        expect(files.some((file) => file.includes('unrelated/src/OtherService.java'))).toBe(false);
    });
    it('glob supports path-aware patterns like claw glob_search', async () => {
        const root = await makeRepo();
        const result = await globTool.execute({ pattern: 'catalog-suite-one-api/**/*' }, createContext(root, [path.join(root, 'catalog-suite-one-api')]));
        expect(result.success).toBe(true);
        const files = result.output;
        expect(files.some((file) => file.endsWith('catalog-suite-one-api/src/CatalogQueryService.java'))).toBe(true);
    });
    it('glob rejects cwd traversal, absolute paths, and symlink escapes', async () => {
        const root = await makeRepo();
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tool-outside-'));
        tempDirs.push(outside);
        await fs.writeFile(path.join(outside, 'secret.txt'), 'do not glob\n', 'utf-8');
        await fs.symlink(outside, path.join(root, 'linked-outside'));
        const context = createContext(root);
        const attempts = await Promise.all([
            globTool.execute({ pattern: '**/*', cwd: '..' }, context),
            globTool.execute({ pattern: '**/*', cwd: path.join(outside) }, context),
            globTool.execute({ pattern: '**/*', cwd: path.join(root, 'catalog-suite-one-api') }, context),
            globTool.execute({ pattern: '**/*', cwd: 'linked-outside' }, context),
        ]);
        for (const result of attempts) {
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/outside the workspace|parent traversal|absolute paths are not allowed/i);
        }
    });
    it('grep auto-scopes broad searches to likely target paths', async () => {
        const root = await makeRepo();
        const result = await grepTool.execute({ pattern: 'cacheKey' }, createContext(root, [path.join(root, 'catalog-suite-one-api')]));
        expect(result.success).toBe(true);
        const output = String(result.output);
        expect(output).toContain('CatalogQueryService.java');
        expect(output).not.toContain('OtherService.java');
    });
    it('grep rejects path traversal, absolute paths, and symlink escapes', async () => {
        const root = await makeRepo();
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-tool-outside-'));
        tempDirs.push(outside);
        await fs.writeFile(path.join(outside, 'secret.txt'), 'do not grep\n', 'utf-8');
        await fs.symlink(outside, path.join(root, 'linked-outside'));
        const context = createContext(root);
        const attempts = await Promise.all([
            grepTool.execute({ pattern: 'grep', path: '..' }, context),
            grepTool.execute({ pattern: 'grep', path: path.join(outside, 'secret.txt') }, context),
            grepTool.execute({ pattern: 'cacheKey', path: path.join(root, 'catalog-suite-one-api') }, context),
            grepTool.execute({ pattern: 'grep', path: 'linked-outside/secret.txt' }, context),
        ]);
        for (const result of attempts) {
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/outside the workspace|parent traversal|absolute paths are not allowed/i);
        }
    });
    it('bash rewrites broad repo-wide find to the likely target path', async () => {
        const root = await makeRepo();
        const result = await bashTool.execute({ command: 'find . -type f | sort' }, createContext(root, [path.join(root, 'catalog-suite-one-api')]));
        expect(result.success).toBe(true);
        const stdout = String(result.output.stdout || '');
        expect(stdout).toContain('catalog-suite-one-api/src/CatalogQueryService.java');
        expect(stdout).not.toContain('unrelated/src/OtherService.java');
    });
    it('bash blocks broad repo-wide find when there is no likely target path', async () => {
        const root = await makeRepo();
        const result = await bashTool.execute({ command: 'find . -type f | sort' }, createContext(root));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Refusing broad repo-wide `find`');
    });
    it('bash blocks low-value file probes once implementation is ready', async () => {
        const root = await makeRepo();
        const result = await bashTool.execute({ command: 'wc -l catalog-suite-one-api/src/CatalogQueryService.java' }, {
            ...createContext(root, [path.join(root, 'catalog-suite-one-api')]),
            implementationReady: true,
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Refusing low-value shell file probe');
    });
    it('bash blocks find -name when structured search is available', async () => {
        const root = await makeRepo();
        const result = await bashTool.execute({ command: 'find catalog-suite-one-api/src -type f -name "*Query*.java"' }, createContext(root, [path.join(root, 'catalog-suite-one-api')]));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Refusing `bash find -name`');
    });
    it('bash blocks grep when structured search is available', async () => {
        const root = await makeRepo();
        const result = await bashTool.execute({ command: 'grep -n "cacheKey" catalog-suite-one-api/src/CatalogQueryService.java' }, createContext(root, [path.join(root, 'catalog-suite-one-api')]));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Refusing shell grep/rg');
    });
});
//# sourceMappingURL=tool-guards.test.js.map