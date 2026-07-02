import type { DiffSummary, TranscriptRef } from '@tik/shared';
import type { PreparedRun } from './agent-runtime-runner.js';
export declare function collectTranscriptFromRunLogs(input: PreparedRun): Promise<TranscriptRef[]>;
export declare function collectGitDiffSummary(input: PreparedRun): Promise<DiffSummary>;
//# sourceMappingURL=runtime-collection.d.ts.map