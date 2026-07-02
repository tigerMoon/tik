import React, { useState } from 'react';
export function ChipMultiSelect({ values, options = [], placeholder, disabled, onChange }) {
    const [draft, setDraft] = useState('');
    const normalizedValues = values.map(normalizeChipValue);
    const remainingOptions = options.filter((option) => !normalizedValues.includes(normalizeChipValue(option.value)));
    const commitValue = (value) => {
        const normalized = normalizeChipValue(value);
        if (!normalized) {
            setDraft('');
            return;
        }
        if (normalizedValues.includes(normalized)) {
            setDraft('');
            return;
        }
        onChange([...values, normalized].sort());
        setDraft('');
    };
    return (<div className="chip-multi-select-wrap">
      <div className={`chip-multi-select ${disabled ? 'is-disabled' : ''}`}>
        {values.map((value) => (<span key={value} className="chip-multi-select-chip">
            <span>{value}</span>
            <button type="button" className="chip-multi-select-remove" disabled={disabled} aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((entry) => entry !== value))}>
              ×
            </button>
          </span>))}
        <input type="text" className="chip-multi-select-input" value={draft} placeholder={values.length === 0 ? placeholder : ''} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                commitValue(draft);
            }
            else if (event.key === 'Backspace' && draft.length === 0 && values.length > 0) {
                onChange(values.slice(0, -1));
            }
        }} onBlur={() => commitValue(draft)}/>
      </div>
      {remainingOptions.length > 0 ? (<div className="chip-multi-select-options" aria-label="Suggested labels">
          {remainingOptions.map((option) => (<button key={option.value} type="button" className={`chip-multi-select-option tone-${option.tone || 'neutral'}`} disabled={disabled} title={option.description} onClick={() => commitValue(option.value)}>
              {option.label || option.value}
            </button>))}
        </div>) : null}
    </div>);
}
function normalizeChipValue(value) {
    return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}
//# sourceMappingURL=ChipMultiSelect.js.map