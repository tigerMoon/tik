import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeResolveWorkspacePath } from '../src/path-safety.js';
const tempDirs = [];
async function makeWorkspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-path-safety-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const app = true;\n', 'utf-8');
    return root;
}
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('safeResolveWorkspacePath', () => {
    it('rejects empty, absolute, and parent-traversal paths', async () => {
        const root = await makeWorkspace();
        await expect(safeResolveWorkspacePath(root, '')).rejects.toThrow(/path is required/i);
        await expect(safeResolveWorkspacePath(root, path.join(root, 'src', 'app.ts'))).rejects.toThrow(/absolute/i);
        await expect(safeResolveWorkspacePath(root, '../outside.txt')).rejects.toThrow(/parent traversal/i);
    });
    it('allows directories only when requested', async () => {
        const root = await makeWorkspace();
        await expect(safeResolveWorkspacePath(root, 'src')).rejects.toThrow(/directory/i);
        await expect(safeResolveWorkspacePath(root, 'src', { allowDirectory: true })).resolves.toBe(await fs.realpath(path.join(root, 'src')));
    });
    it('preserves nested missing paths inside the workspace', async () => {
        const root = await makeWorkspace();
        await expect(safeResolveWorkspacePath(root, 'new/deep/file.ts')).resolves.toBe(path.join(root, 'new', 'deep', 'file.ts'));
    });
    it('rejects symlink parent escapes for existing and missing paths', async () => {
        const root = await makeWorkspace();
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-path-outside-'));
        tempDirs.push(outside);
        await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf-8');
        await fs.symlink(outside, path.join(root, 'linked-outside'));
        await expect(safeResolveWorkspacePath(root, 'linked-outside/secret.txt')).rejects.toThrow(/workspace/i);
        await expect(safeResolveWorkspacePath(root, 'linked-outside/new.txt')).rejects.toThrow(/workspace/i);
    });
});
//# sourceMappingURL=path-safety.test.js.map