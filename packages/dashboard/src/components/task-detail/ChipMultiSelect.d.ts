import React from 'react';
export interface ChipMultiSelectOption {
    value: string;
    label?: string;
    description?: string;
    tone?: 'blue' | 'green' | 'yellow' | 'red' | 'neutral';
}
interface ChipMultiSelectProps {
    values: string[];
    options?: ChipMultiSelectOption[];
    placeholder?: string;
    disabled?: boolean;
    onChange: (next: string[]) => void;
}
export declare function ChipMultiSelect({ values, options, placeholder, disabled, onChange }: ChipMultiSelectProps): React.JSX.Element;
export {};
//# sourceMappingURL=ChipMultiSelect.d.ts.map