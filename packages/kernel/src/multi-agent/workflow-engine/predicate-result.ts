import type { GuardResultCode } from '@tik/shared';

export interface PredicateRef {
  kind:
    | 'contract'
    | 'evidence'
    | 'evaluation'
    | 'questioner_run'
    | 'questioner_output'
    | 'subtask'
    | 'workflow'
    | 'artifact'
    | 'invocation';
  id: string;
}

export interface PredicateResult {
  ok: boolean;
  code?: GuardResultCode;
  message?: string;
  refs?: PredicateRef[];
  currentState?: unknown;
}

export function pass(refs: PredicateRef[] = []): PredicateResult {
  return { ok: true, code: 'ok', refs };
}

export function fail(
  code: GuardResultCode,
  message: string,
  options: { refs?: PredicateRef[]; currentState?: unknown } = {},
): PredicateResult {
  return {
    ok: false,
    code,
    message,
    refs: options.refs,
    currentState: options.currentState,
  };
}

