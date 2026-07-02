/**
 * API Client
 *
 * Connects to Tik API server for tasks, events, and control.
 */
const LOCAL_API_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
function normalizeApiBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, '');
}
export function resolveApiBaseUrlForLocation(location, explicitBaseUrl) {
    const normalizedExplicitBaseUrl = explicitBaseUrl?.trim();
    if (normalizedExplicitBaseUrl) {
        return normalizeApiBaseUrl(normalizedExplicitBaseUrl);
    }
    if (!location) {
        return '/api';
    }
    if (location.port === '3300') {
        return '/api';
    }
    if (LOCAL_API_HOSTNAMES.has(location.hostname)) {
        return `${location.protocol}//${location.hostname}:3300/api`;
    }
    return `${location.origin}/api`;
}
function resolveApiBaseUrl() {
    const explicitBaseUrl = typeof import.meta !== 'undefined'
        ? import.meta.env?.VITE_API_BASE_URL
        : undefined;
    return typeof window === 'undefined'
        ? resolveApiBaseUrlForLocation(null, explicitBaseUrl)
        : resolveApiBaseUrlForLocation(window.location, explicitBaseUrl);
}
const BASE_URL = resolveApiBaseUrl();
async function readJsonOrThrow(res) {
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error(resolveApiErrorMessage(payload, res.statusText, res.status));
    }
    return payload;
}
export function resolveApiErrorMessage(payload, statusText, status) {
    if (payload && typeof payload === 'object') {
        const record = payload;
        if (record.error && typeof record.error === 'object') {
            const error = record.error;
            if (typeof error.message === 'string' && error.message.trim()) {
                return error.message;
            }
            if (typeof error.code === 'string' && error.code.trim()) {
                return error.code;
            }
        }
        if (typeof record.message === 'string' && record.message.trim()) {
            return record.message;
        }
        if (typeof record.error === 'string' && record.error.trim()) {
            return record.error;
        }
    }
    return statusText || `Request failed: ${status}`;
}
export async function fetchTasks() {
    const res = await fetch(`${BASE_URL}/tasks`);
    return readJsonOrThrow(res);
}
export async function fetchTask(id) {
    const res = await fetch(`${BASE_URL}/tasks/${id}`);
    return readJsonOrThrow(res);
}
export async function submitTask(description, strategy = 'incremental', mode = 'single') {
    const res = await fetch(`${BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, strategy, mode }),
    });
    return readJsonOrThrow(res);
}
export async function controlTask(id, command) {
    const res = await fetch(`${BASE_URL}/tasks/${id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
    });
    await readJsonOrThrow(res);
}
export async function controlWorkbenchTask(taskId, command) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function fetchWorkbenchTasks() {
    const res = await fetch(`${BASE_URL}/v1/tasks`);
    return (await readJsonOrThrow(res)).tasks;
}
export async function createWorkbenchTask(title, goal, input) {
    const res = await fetch(`${BASE_URL}/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, goal, ...input }),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function createWorktreeReviewRound(input) {
    const res = await fetch(`${BASE_URL}/v1/agent-loop/worktree-review-rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function updateTrackerTask(taskId, input) {
    const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function transitionTrackerTask(taskId, to, reason) {
    const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, reason }),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function addTrackerTaskComment(taskId, body) {
    const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function setTrackerTaskLabels(taskId, input) {
    const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function setTrackerTaskDependencies(taskId, input) {
    const res = await fetch(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function fetchTrackerState() {
    const res = await fetch(`${BASE_URL}/v1/tracker/state`);
    return readJsonOrThrow(res);
}
export async function refreshTracker() {
    const res = await fetch(`${BASE_URL}/v1/tracker/refresh`, { method: 'POST' });
    return readJsonOrThrow(res);
}
export async function fetchWorkflowFile() {
    const res = await fetch(`${BASE_URL}/v1/workflow`);
    return readJsonOrThrow(res);
}
export async function saveWorkflowFile(content) {
    const res = await fetch(`${BASE_URL}/v1/workflow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    return readJsonOrThrow(res);
}
export async function updateWorkbenchTaskConfiguration(taskId, selection) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/configuration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
    });
    return (await readJsonOrThrow(res)).task;
}
export async function updateWorkbenchTaskBrief(taskId, input) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return readJsonOrThrow(res);
}
export async function revertWorkbenchTaskBrief(taskId) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/brief/revert`, {
        method: 'POST',
    });
    return (await readJsonOrThrow(res)).task;
}
export async function retryWorkbenchTask(taskId) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/retry`, {
        method: 'POST',
    });
    return (await readJsonOrThrow(res)).task;
}
export async function archiveWorkbenchTask(taskId) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/archive`, {
        method: 'POST',
    });
    return (await readJsonOrThrow(res)).task;
}
export async function fetchWorkbenchTimeline(taskId) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/timeline`);
    return (await readJsonOrThrow(res)).timeline;
}
export async function fetchWorkbenchDecisions(taskId) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/decisions`);
    return (await readJsonOrThrow(res)).decisions;
}
export async function fetchWorkbenchArtifacts(input = {}) {
    const query = new URLSearchParams();
    Object.entries(input).forEach(([key, value]) => {
        if (value) {
            query.set(key, value);
        }
    });
    const res = await fetch(`${BASE_URL}/workbench/artifacts${query.size ? `?${query}` : ''}`);
    return (await readJsonOrThrow(res)).artifacts;
}
export async function fetchWorkbenchTaskArtifacts(taskId) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/artifacts`);
    return (await readJsonOrThrow(res)).artifacts;
}
export async function fetchWorkbenchArtifact(artifactId) {
    const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}`);
    return (await readJsonOrThrow(res)).artifact;
}
export async function fetchWorkbenchArtifactVersions(artifactId) {
    const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/versions`);
    return (await readJsonOrThrow(res)).versions;
}
export async function generateWorkbenchTaskArtifact(taskId, template = 'task-review') {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/artifacts/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template }),
    });
    return (await readJsonOrThrow(res)).artifact;
}
export async function acceptWorkbenchArtifact(artifactId) {
    const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'dashboard' }),
    });
    return (await readJsonOrThrow(res)).artifact;
}
export async function rejectWorkbenchArtifact(artifactId, reason) {
    const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'dashboard', reason }),
    });
    return (await readJsonOrThrow(res)).artifact;
}
export async function archiveWorkbenchArtifact(artifactId) {
    const res = await fetch(`${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'dashboard' }),
    });
    return (await readJsonOrThrow(res)).artifact;
}
export async function resolveWorkbenchDecision(taskId, decisionId, body) {
    const res = await fetch(`${BASE_URL}/workbench/tasks/${encodeURIComponent(taskId)}/decisions/${encodeURIComponent(decisionId)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJsonOrThrow(res);
}
export function buildWorkbenchArtifactPreviewUrl(filePath) {
    return `${BASE_URL}/workbench/artifacts/preview?path=${encodeURIComponent(filePath)}`;
}
export function buildWorkbenchArtifactVersionPreviewUrl(artifactId, versionId) {
    return `${BASE_URL}/workbench/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview`;
}
export function buildWorkbenchArtifactLinkPreviewUrl(input) {
    if (input.artifactId && input.versionId) {
        return buildWorkbenchArtifactVersionPreviewUrl(input.artifactId, input.versionId);
    }
    return input.filePath ? buildWorkbenchArtifactPreviewUrl(input.filePath) : null;
}
export async function fetchEnvironmentPacks() {
    const res = await fetch(`${BASE_URL}/environment-packs`);
    return readJsonOrThrow(res);
}
export async function fetchEnvironmentPackDashboard() {
    const res = await fetch(`${BASE_URL}/environment-packs/dashboard`);
    return readJsonOrThrow(res);
}
export async function switchEnvironmentPack(packId) {
    const res = await fetch(`${BASE_URL}/environment-packs/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
    });
    return (await readJsonOrThrow(res)).activePack;
}
export async function fetchSkillManifestRegistry() {
    const res = await fetch(`${BASE_URL}/skills/registry`);
    return readJsonOrThrow(res);
}
export async function saveSkillManifestDraft(skillId, input) {
    const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(skillId)}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await readJsonOrThrow(res)).skill;
}
export async function publishSkillManifest(skillId, input) {
    const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(skillId)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await readJsonOrThrow(res)).skill;
}
export function subscribeToEvents(taskId, handlers) {
    const es = new EventSource(`${BASE_URL}/tasks/${taskId}/events`);
    es.onopen = () => {
        handlers.onOpen?.();
    };
    es.onmessage = (msg) => {
        try {
            const event = JSON.parse(msg.data);
            handlers.onEvent(event);
        }
        catch { /* skip */ }
    };
    es.onerror = () => {
        handlers.onError?.();
    };
    return () => es.close();
}
export function subscribeToWorkbenchEvents(handlers) {
    const es = new EventSource(`${BASE_URL}/workbench/events`);
    es.onopen = () => {
        handlers.onOpen?.();
    };
    es.onmessage = (msg) => {
        try {
            const event = JSON.parse(msg.data);
            handlers.onEvent(event);
        }
        catch { /* skip */ }
    };
    es.onerror = () => {
        handlers.onError?.();
    };
    return () => es.close();
}
export async function fetchWorkspaceStatus(rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/status${search}`);
    return readJsonOrThrow(res);
}
export async function fetchWorkspaceReport(rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/report${search}`);
    return readJsonOrThrow(res);
}
export async function fetchWorkspaceBoard(rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/board${search}`);
    return readJsonOrThrow(res);
}
export async function fetchWorkspaceDecisions(rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/decisions${search}`);
    return readJsonOrThrow(res);
}
export async function fetchWorkspaceWorktrees(rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/worktrees${search}`);
    return readJsonOrThrow(res);
}
export async function createWorkspaceWorktree(body, rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/worktrees/create${search}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJsonOrThrow(res);
}
export async function useWorkspaceWorktree(body, rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/worktrees/use${search}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJsonOrThrow(res);
}
export async function removeWorkspaceWorktree(body, rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/worktrees/remove${search}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJsonOrThrow(res);
}
export async function resolveWorkspaceDecision(decisionId, body, rootPath) {
    const search = rootPath ? `?rootPath=${encodeURIComponent(rootPath)}` : '';
    const res = await fetch(`${BASE_URL}/workspace/decisions/${encodeURIComponent(decisionId)}/resolve${search}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJsonOrThrow(res);
}
//# sourceMappingURL=client.js.map