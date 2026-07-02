import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';
interface WorkbenchConsoleHeaderProps {
    packs: EnvironmentPackManifest[];
    activePackId: string | null;
    activeTask: WorkbenchTaskResponse | null;
    waitingCount: number;
    highRiskCount: number;
    selectedLens: WorkbenchLens;
    bootstrapping?: boolean;
    refreshing?: boolean;
    liveStatus?: 'live' | 'connecting' | 'offline' | 'idle';
    publishingReviewRound?: boolean;
    onToggleFilter: () => void;
    onNewTask: () => void;
    onPublishReviewRound?: () => Promise<void>;
    onRefresh?: () => Promise<void>;
}
export declare function WorkbenchConsoleHeader({ packs, activePackId, activeTask, waitingCount, highRiskCount, selectedLens, bootstrapping, refreshing, liveStatus, publishingReviewRound, onToggleFilter, onNewTask, onPublishReviewRound, onRefresh, }: WorkbenchConsoleHeaderProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkbenchConsoleHeader.d.ts.map