import React from 'react';
import type { EnvironmentPackManifest, SkillManifestRegistryEntry } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import { type SkillManifestRecord } from '../view-models/skills';
interface WorkbenchSkillsViewProps {
    packs: EnvironmentPackManifest[];
    tasks: WorkbenchTaskResponse[];
    activePackId: string | null;
    activeTask: WorkbenchTaskResponse | null;
    registryEntries: SkillManifestRegistryEntry[];
    savingDraftSkillId?: string | null;
    publishingSkillId?: string | null;
    onSaveDraft: (skillId: string, notes: string, skill: SkillManifestRecord) => Promise<void>;
    onPublish: (skillId: string, notes: string, skill: SkillManifestRecord) => Promise<void>;
    onOpenTask: (taskId: string) => void;
}
export declare function WorkbenchSkillsView({ packs, tasks, activePackId, activeTask, registryEntries, savingDraftSkillId, publishingSkillId, onSaveDraft, onPublish, onOpenTask, }: WorkbenchSkillsViewProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkbenchSkillsView.d.ts.map