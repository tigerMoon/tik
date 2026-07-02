import type { Tool } from '@tik/shared';
type FrontendPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
interface FrontendCommandCatalog {
    packageManager: FrontendPackageManager;
    availableScripts: string[];
    scripts: Record<string, string>;
    defaultPreviewScript?: string;
    suggestedCommands: Record<string, string>;
}
export declare function getFrontendCommandCatalog(projectPath: string): FrontendCommandCatalog;
export declare const frontendProjectInfoTool: Tool;
export declare const frontendCommandCatalogTool: Tool;
export declare const frontendRunScriptTool: Tool;
export declare const frontendPreviewProbeTool: Tool;
export declare const frontendHtmlSnapshotTool: Tool;
export declare const frontendDomQueryTool: Tool;
export declare const frontendAccessibilityAuditTool: Tool;
export declare const frontendBrowserScreenshotTool: Tool;
export declare const frontendTools: Tool[];
export {};
//# sourceMappingURL=tools-frontend.d.ts.map