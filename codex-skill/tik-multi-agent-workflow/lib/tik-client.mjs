const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3300/api';

export async function tikFetch(options, route, input = {}) {
  const baseUrl = (options.apiBaseUrl || process.env.TIK_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const headers = {
    accept: 'application/json',
  };
  if (input.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const token = options.apiToken || process.env.TIK_API_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (input.ifMatch) {
    headers['if-match'] = input.ifMatch;
  }
  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
  const method = input.method || 'GET';
  const retryable = input.retryable === true || method === 'GET';
  const attempts = retryable ? 2 : 1;
  const timeoutMs = input.timeoutMs ?? (method === 'GET' ? 15_000 : 30_000);
  let response;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Tik API request timed out after ${timeoutMs}ms.`)), timeoutMs);
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!response) throw lastError || new Error(`Tik API ${method} ${route} failed without a response.`);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error?.message || payload.guard?.message || payload.error || text || response.statusText;
    const error = new Error(`Tik API ${method} ${route} failed (${response.status}): ${detail}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  // Surface 202 Accepted + Retry-After so callers can install cooldown locks
  // when Tik reports awaiting_native_runtime. `retryAfterMs` is derived from
  // the header (integer seconds) but falls back to the body field if missing.
  if (response.status === 202) {
    const headerVal = response.headers.get('retry-after');
    const headerMs = headerVal ? Number.parseInt(headerVal, 10) * 1000 : NaN;
    const bodyMs = typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : NaN;
    payload.__http = {
      status: 202,
      retryAfterMs: Number.isFinite(headerMs) ? headerMs : Number.isFinite(bodyMs) ? bodyMs : undefined,
    };
  }
  return payload;
}

export async function readWorkflow(options, workflowId) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}`);
}

/**
 * List workflows visible to this Tik API server. `filter` accepts the same
 * querystring the server understands: `status` (`open` = any non-terminal),
 * `workspaceRoot`, `effectiveProjectPath`, `repo`, `mode`, `headRef`, `stale`.
 * All fields are optional; unset fields return every workflow.
 */
export async function listWorkflows(options, filter = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  return tikFetch(options, `/v1/multi-agent/workflows${query}`);
}

/**
 * Patch workflow metadata / head-sha / policy. Note the server rejects
 * status transitions except through decisions; use dedicated action routes
 * (e.g. `complete-workflow`) instead of PATCH for status changes.
 */
export async function patchWorkflow(options, workflowId, patch) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export async function preflightEnvironment(options, input) {
  return tikFetch(options, '/v1/multi-agent/preflight', {
    method: 'POST',
    body: input,
  });
}

export async function readNextAction(options, workflowId, input = {}) {
  const params = new URLSearchParams();
  if (input.subtaskId) params.set('subtaskId', input.subtaskId);
  if (input.headSha) params.set('headSha', input.headSha);
  const query = params.toString() ? `?${params.toString()}` : '';
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/next-action${query}`);
}

export async function recordDecision(options, workflowId, decision, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions`, {
    method: 'POST',
    body: { decision },
    ifMatch: input.ifMatch,
  });
}

export async function preflightDecision(options, workflowId, decision, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions/preflight`, {
    method: 'POST',
    body: { decision },
    ifMatch: input.ifMatch,
  });
}

export async function recordEvidence(options, workflowId, evidence) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/evidence`, {
    method: 'POST',
    body: evidence,
  });
}

export async function executeSubtask(options, workflowId, input, concurrency = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/actions/execute-subtask`, {
    method: 'POST',
    body: input,
    ifMatch: concurrency.ifMatch,
  });
}

export async function recordReview(options, workflowId, input, concurrency = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/actions/record-review`, {
    method: 'POST',
    body: input,
    ifMatch: concurrency.ifMatch,
  });
}

export async function synthesizeReview(options, workflowId, input, concurrency = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/actions/synthesize-review`, {
    method: 'POST',
    body: input,
    ifMatch: concurrency.ifMatch,
  });
}

export async function updateSubtask(options, workflowId, subtaskId, patch) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export async function createContract(options, workflowId, subtaskId, contract) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}/contracts`, {
    method: 'POST',
    body: contract,
  });
}

export async function acceptContract(options, workflowId, subtaskId, contractId, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}/contracts/${encodeURIComponent(contractId)}/accept`, {
    method: 'POST',
    body: input,
  });
}

export async function acceptContracts(options, workflowId, contracts, concurrency = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/actions/accept-contracts`, {
    method: 'POST',
    body: { contracts },
    ifMatch: concurrency.ifMatch,
  });
}

export async function createEvaluationRun(options, workflowId, subtaskId, evaluationRun) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}/evaluations`, {
    method: 'POST',
    body: evaluationRun,
  });
}

export async function updateEvaluationRun(options, workflowId, subtaskId, evaluationRunId, patch) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}/evaluations/${encodeURIComponent(evaluationRunId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export async function createInvocation(options, workflowId, invocation) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations`, {
    method: 'POST',
    body: invocation,
  });
}

export async function launchNativeInvocation(options, workflowId, invocation) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/native-launch`, {
    method: 'POST',
    body: invocation,
    idempotencyKey: invocation.id,
    retryable: Boolean(invocation.id),
    timeoutMs: 100_000,
  });
}

export async function linkNativeInvocationResult(options, workflowId, invocationId, result) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(invocationId)}/native-result`, {
    method: 'POST',
    body: result,
  });
}

export async function startInvocation(options, workflowId, invocationId, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(invocationId)}/start`, {
    method: 'POST',
    body: input,
  });
}

export async function hookStartInvocation(options, workflowId, invocationId, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(invocationId)}/hook-start`, {
    method: 'POST',
    body: input,
  });
}

export async function completeInvocation(options, workflowId, invocationId, result) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(invocationId)}/result`, {
    method: 'POST',
    body: result,
  });
}

export async function hookStopInvocation(options, workflowId, invocationId, result) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/agent-invocations/${encodeURIComponent(invocationId)}/hook-stop`, {
    method: 'POST',
    body: result,
  });
}

export async function recordEvaluationResult(options, workflowId, subtaskId, evaluationRunId, result) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}/evaluations/${encodeURIComponent(evaluationRunId)}/result`, {
    method: 'POST',
    body: { result },
  });
}

export async function validateEvaluationReadonly(options, workflowId, subtaskId, evaluationRunId, input) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}/evaluations/${encodeURIComponent(evaluationRunId)}/validate-readonly`, {
    method: 'POST',
    body: input,
  });
}

export async function recordQuestionerOutput(options, workflowId, output) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/questioner-outputs`, {
    method: 'POST',
    body: output,
  });
}

export async function createQuestionerRun(options, workflowId, input) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/questioner-runs`, {
    method: 'POST',
    body: input,
  });
}

export async function launchNativeQuestionerRun(options, workflowId, input) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/questioner-runs/native-launch`, {
    method: 'POST',
    body: input,
    idempotencyKey: input.id,
    retryable: Boolean(input.id),
    timeoutMs: 100_000,
  });
}

export async function runWorkflowAction(options, workflowId, actionId, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/actions/${encodeURIComponent(actionId)}/run`, {
    method: 'POST',
    body: input,
  });
}

export async function saveContextSnapshot(options, workflowId, snapshot, input = {}) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/context-snapshots`, {
    method: 'POST',
    body: { snapshot },
    ifMatch: input.ifMatch,
  });
}

export async function readContextSnapshot(options, workflowId, target) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/context-snapshots/${encodeURIComponent(target)}`);
}

export async function createTask(options, task) {
  return tikFetch(options, '/v1/tasks', {
    method: 'POST',
    body: task,
  });
}

export async function readTask(options, taskId) {
  const payload = await tikFetch(options, '/v1/tasks', { method: 'GET' });
  const task = (payload.tasks || []).find((item) =>
    item.id === taskId || item.shortIdentifier === taskId || item.identifier === taskId
  );
  if (!task) {
    throw new Error(`Tik task not found: ${taskId}`);
  }
  return task;
}

export async function commentTask(options, taskId, comment) {
  return tikFetch(options, `/v1/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: 'POST',
    body: comment,
  });
}

export async function transitionTask(options, taskId, transition) {
  return tikFetch(options, `/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
    method: 'POST',
    body: transition,
  });
}

/**
 * Fail-fast client-side lint for QuestionerOutputV2 payloads. Prevents the
 * three protocol misses we've seen in the wild:
 *   1. legacy field names (`id`/`label`/`evidence`) sneaking past into the
 *      kernel POST body, which the kernel rejects as evaluation_evidence_insufficient
 *   2. verdicts outside the enum
 *   3. coverageMatrix criterionId sets that don't match the required set the
 *      kernel derived from context (e.g. `global-1` vs `global-ac-1`).
 *
 * `expectedCriterionIds` is optional: pass it when the caller has already
 * retrieved the QuestionerContext and knows exactly which IDs must appear.
 * Returns { ok: true } on success or { ok: false, errors: [...] } with a
 * plain-text list of what needs to change. Never throws.
 */
export function validateQuestionerOutputShape(output, expectedCriterionIds) {
  const errors = [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, errors: ['output must be a JSON object.'] };
  }
  if (output.schemaVersion !== 'questioner-output.v2') {
    errors.push(`schemaVersion must be "questioner-output.v2" (got ${JSON.stringify(output.schemaVersion)}).`);
  }
  const allowedVerdicts = new Set([
    'questions_blocking',
    'evidence_needed',
    'risk_found',
    'no_blocking_questions',
    'evidence_sufficient',
  ]);
  if (!allowedVerdicts.has(output.verdict)) {
    errors.push(`verdict must be one of ${Array.from(allowedVerdicts).join(', ')} (got ${JSON.stringify(output.verdict)}).`);
  }
  if (!Array.isArray(output.coverageMatrix) || output.coverageMatrix.length === 0) {
    errors.push('coverageMatrix must be a non-empty array.');
  } else {
    const legacyFields = ['id', 'label', 'evidence'];
    const requiredFields = ['criterionId', 'criterionText', 'required', 'status', 'evidenceRefs', 'comment'];
    const allowedStatus = new Set(['covered', 'partially_covered', 'missing', 'not_applicable']);
    output.coverageMatrix.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`coverageMatrix[${index}] must be an object.`);
        return;
      }
      const usedLegacy = legacyFields.filter((field) => field in entry);
      if (usedLegacy.length > 0) {
        errors.push(`coverageMatrix[${index}] uses legacy field(s) ${usedLegacy.join(', ')}; QuestionerOutputV2 requires ${requiredFields.join(', ')}.`);
      }
      const missing = requiredFields.filter((field) => !(field in entry));
      if (missing.length > 0) {
        errors.push(`coverageMatrix[${index}] is missing field(s): ${missing.join(', ')}.`);
      }
      if ('status' in entry && !allowedStatus.has(entry.status)) {
        errors.push(`coverageMatrix[${index}].status must be one of ${Array.from(allowedStatus).join(', ')} (got ${JSON.stringify(entry.status)}).`);
      }
      if ('evidenceRefs' in entry && !Array.isArray(entry.evidenceRefs)) {
        errors.push(`coverageMatrix[${index}].evidenceRefs must be an array.`);
      }
      if ('required' in entry && typeof entry.required !== 'boolean') {
        errors.push(`coverageMatrix[${index}].required must be a boolean.`);
      }
    });
  }
  if (Array.isArray(expectedCriterionIds) && expectedCriterionIds.length > 0
      && Array.isArray(output.coverageMatrix)) {
    // Kernel-side validateCoverageMatrix only requires the expected set to be
    // COVERED — extra criteria are fine. We used to also reject "unexpected"
    // criterionIds here, which blocked valid supersets that the kernel would
    // have accepted. Only check the missing direction.
    const actualIds = new Set(output.coverageMatrix.map((entry) => entry?.criterionId).filter(Boolean));
    const missing = expectedCriterionIds.filter((id) => !actualIds.has(id));
    if (missing.length > 0) {
      errors.push(`coverageMatrix is missing required criterionId(s): ${missing.join(', ')}. Expected at minimum: ${expectedCriterionIds.join(', ')}.`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
