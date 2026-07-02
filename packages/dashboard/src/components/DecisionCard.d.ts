import React from 'react';
import type { WorkbenchDecisionResponse } from '../api/client';
interface DecisionCardProps {
    decision: WorkbenchDecisionResponse;
    resolving?: boolean;
    onResolve?: (body: {
        optionId?: string;
        message?: string;
    }) => Promise<void>;
    compact?: boolean;
}
export declare function DecisionCard({ decision, resolving, onResolve, compact, }: DecisionCardProps): React.JSX.Element;
export {};
//# sourceMappingURL=DecisionCard.d.ts.map