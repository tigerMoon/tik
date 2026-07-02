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
export declare function inspectFrontendProject(projectPath: string): FrontendProjectReport;
export declare function isLikelyFrontendTask(taskDescription: string, report?: FrontendProjectReport): boolean;
//# sourceMappingURL=frontend-project.d.ts.map