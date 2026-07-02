/**
 * Execution Stream Component
 *
 * Real-time display of tool calls, results, and events.
 * The core differentiating feature of Tik.
 */
import React from 'react';
import type { AgentEvent } from '../api/client';
interface Props {
    events: AgentEvent[];
}
export declare function ExecutionStream({ events }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=ExecutionStream.d.ts.map