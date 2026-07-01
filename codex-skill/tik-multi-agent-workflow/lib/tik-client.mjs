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
  const response = await fetch(`${baseUrl}${route}`, {
    method: input.method || 'GET',
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error?.message || payload.guard?.message || payload.error || text || response.statusText;
    const error = new Error(`Tik API ${input.method || 'GET'} ${route} failed (${response.status}): ${detail}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function readWorkflow(options, workflowId) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}`);
}

export async function recordDecision(options, workflowId, decision) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/decisions`, {
    method: 'POST',
    body: { decision },
  });
}

export async function recordEvidence(options, workflowId, evidence) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/evidence`, {
    method: 'POST',
    body: evidence,
  });
}

export async function updateSubtask(options, workflowId, subtaskId, patch) {
  return tikFetch(options, `/v1/multi-agent/workflows/${encodeURIComponent(workflowId)}/subtasks/${encodeURIComponent(subtaskId)}`, {
    method: 'PATCH',
    body: patch,
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
