import type { EnvironmentPackManifest, EnvironmentPackSnapshot, EnvironmentPackTaskLabel, EnvironmentPackTaskLabelAction } from '../types/environment-pack.js';
export type WorkbenchLabelAction = EnvironmentPackTaskLabelAction;
export type WorkbenchLabelTone = 'blue' | 'green' | 'yellow' | 'red' | 'neutral';
export type WorkbenchLabelDefinition = EnvironmentPackTaskLabel;
export interface WorkbenchLabelActionDefinition {
    action: WorkbenchLabelAction;
    label: string;
    description: string;
    tone: WorkbenchLabelTone;
}
export type WorkbenchLabelEnvironment = Pick<EnvironmentPackManifest | EnvironmentPackSnapshot, 'taskLabels'> | null | undefined;
export declare const WORKBENCH_LABEL_ACTIONS: readonly WorkbenchLabelActionDefinition[];
export declare function normalizeWorkbenchLabel(label: string): string;
export declare function getWorkbenchLabelDefinitions(environment: WorkbenchLabelEnvironment): WorkbenchLabelDefinition[];
export declare function getWorkbenchLabelDefinition(environment: WorkbenchLabelEnvironment, label: string): WorkbenchLabelDefinition | null;
export declare function getWorkbenchLabelActionDefinition(action: WorkbenchLabelAction): WorkbenchLabelActionDefinition;
export declare function getWorkbenchLabelAction(environment: WorkbenchLabelEnvironment, label: string): WorkbenchLabelAction;
export declare function getWorkbenchLabelActionTone(environment: WorkbenchLabelEnvironment, label: string): WorkbenchLabelTone;
//# sourceMappingURL=workbench-labels.d.ts.map