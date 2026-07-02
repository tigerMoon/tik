/**
 * Control Panel Component
 *
 * Human-in-the-loop controls: pause, resume, stop, inject constraint, change strategy.
 */
import React from 'react';
interface Props {
    taskId: string | null;
    onControl: (taskId: string, command: unknown) => void;
}
export declare function ControlPanel({ taskId, onControl }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=ControlPanel.d.ts.map