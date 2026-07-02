/**
 * Task Panel Component
 *
 * Displays task list with status and allows task submission.
 */
import React from 'react';
import type { Task } from '../api/client';
interface Props {
    tasks: Task[];
    activeTaskId: string | null;
    onSelectTask: (id: string) => void;
    onSubmitTask: (description: string, mode: 'single' | 'multi') => void;
}
export declare function TaskPanel({ tasks, activeTaskId, onSelectTask, onSubmitTask }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=TaskPanel.d.ts.map