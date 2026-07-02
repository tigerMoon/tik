import { describe, expect, it } from 'vitest';
import { extractModifiedFilesFromEvidenceBody } from './workbench-evidence.js';
describe('extractModifiedFilesFromEvidenceBody', () => {
    it('extracts modified files from explicit evidence, git status, and git diff output', () => {
        expect(extractModifiedFilesFromEvidenceBody([
            'Tool: bash',
            '',
            'Files modified:',
            '- packages/dashboard/src/App.tsx',
            '',
            'Output:',
            ' M packages/dashboard/src/styles/workbench-inbox.css',
            '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
            'R  old-name.ts -> packages/dashboard/src/renamed.ts',
            'diff --git a/packages/dashboard/src/App.tsx b/packages/dashboard/src/App.tsx',
            '!! ignored-local-file',
        ].join('\n'))).toEqual([
            'packages/dashboard/src/App.tsx',
            'packages/dashboard/src/styles/workbench-inbox.css',
            'packages/dashboard/src/styles/workbench-inbox.test.ts',
            'packages/dashboard/src/renamed.ts',
        ]);
    });
    it('extracts modified files from JSON bash output stdout', () => {
        expect(extractModifiedFilesFromEvidenceBody([
            'Tool: bash',
            '',
            'Output:',
            JSON.stringify({
                command: 'git status --short && git diff -- packages/dashboard/src/styles/workbench-inbox.css',
                stdout: [
                    '/Users/huyuehui/ace/tik/.workspace/worktrees/tik-805562e6--tik-83',
                    ' M packages/dashboard/src/styles/workbench-inbox.css',
                    '?? packages/dashboard/src/styles/workbench-inbox.test.ts',
                    'diff --git a/packages/dashboard/src/styles/workbench-inbox.css b/packages/dashboard/src/styles/workbench-inbox.css',
                ].join('\n'),
                exitCode: 0,
            }, null, 2),
        ].join('\n'))).toEqual([
            'packages/dashboard/src/styles/workbench-inbox.css',
            'packages/dashboard/src/styles/workbench-inbox.test.ts',
        ]);
    });
});
//# sourceMappingURL=workbench-evidence.test.js.map