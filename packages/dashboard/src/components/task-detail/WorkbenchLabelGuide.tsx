import React from 'react';
import {
  getWorkbenchLabelDefinitions,
  getWorkbenchLabelActionDefinition,
  WORKBENCH_LABEL_ACTIONS,
  type WorkbenchLabelAction,
  type WorkbenchLabelEnvironment,
  type WorkbenchLabelTone,
} from '@tik/shared';
import type { ChipMultiSelectOption } from './ChipMultiSelect';

const ACTION_ORDER: WorkbenchLabelAction[] = [
  'codex_dispatch',
  'codex_fix',
  'claude_code_review',
  'human_review',
  'maintenance_manual',
  'loop_complete',
  'metadata',
];

const ACTION_LABELS = new Map(WORKBENCH_LABEL_ACTIONS.map((action) => [action.action, action]));

export function buildWorkbenchLabelSelectOptions(
  environment: WorkbenchLabelEnvironment,
): ChipMultiSelectOption[] {
  return getWorkbenchLabelDefinitions(environment).map((definition) => {
    const action = getWorkbenchLabelActionDefinition(definition.action);
    return {
      value: definition.value,
      label: definition.label,
      description: `${action.label}: ${definition.description}`,
      tone: action.tone,
    };
  });
}

export function WorkbenchLabelGuide({ environment }: { environment: WorkbenchLabelEnvironment }) {
  const definitions = getWorkbenchLabelDefinitions(environment);
  const groupedLabels = ACTION_ORDER.map((action) => ({
    action,
    actionDefinition: ACTION_LABELS.get(action) || getWorkbenchLabelActionDefinition(action),
    labels: definitions.filter((definition) => definition.action === action),
  })).filter((entry) => entry.labels.length > 0 || entry.action === 'metadata');

  return (
    <div className="workbench-label-guide" aria-label="Label actions">
      <div className="workbench-label-guide-title">Label actions</div>
      <div className="workbench-label-guide-list">
        {groupedLabels.map(({ action, actionDefinition, labels }) => (
          <div key={action} className={`workbench-label-guide-row tone-${actionDefinition.tone}`}>
            <span className={`workbench-label-guide-dot tone-${actionDefinition.tone}`} />
            <div className="workbench-label-guide-body">
              <div className="workbench-label-guide-head">
                <strong>{actionDefinition.label}</strong>
                <span>{labels.map((label) => label.value).join(', ') || 'custom labels'}</span>
              </div>
              <div className="workbench-label-guide-copy">{actionDefinition.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function buildWorkbenchLabelTone(
  environment: WorkbenchLabelEnvironment,
  label: string,
): WorkbenchLabelTone {
  const option = buildWorkbenchLabelSelectOptions(environment).find((entry) => entry.value === label);
  return option?.tone || 'neutral';
}
