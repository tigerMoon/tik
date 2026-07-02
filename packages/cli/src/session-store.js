import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export async function saveCliSession(session) {
    const filePath = sessionFilePath(session.projectPath, session.sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const nowIso = new Date().toISOString();
    const nextSession = {
        ...session,
        updatedAt: nowIso,
        createdAt: session.createdAt || nowIso,
    };
    await fs.writeFile(filePath, JSON.stringify(nextSession, null, 2), 'utf-8');
    return filePath;
}
export async function listCliSessions(projectPath) {
    const dir = sessionDir(projectPath);
    let entries = [];
    try {
        entries = await fs.readdir(dir);
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
        try {
            const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
            const parsed = JSON.parse(raw);
            sessions.push({
                sessionId: parsed.sessionId,
                projectPath: parsed.projectPath,
                updatedAt: parsed.updatedAt,
                turns: parsed.turns,
                provider: parsed.provider,
                mode: parsed.mode,
                strategy: parsed.strategy,
                lastTaskId: parsed.lastTaskId,
                lastTaskStatus: parsed.lastTaskStatus,
            });
        }
        catch {
            // Ignore malformed session files.
        }
    }
    return sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}
export async function loadCliSession(projectPath, sessionIdOrPath) {
    const filePath = await resolveCliSessionPath(projectPath, sessionIdOrPath);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
}
export async function resolveCliSessionPath(projectPath, sessionIdOrPath) {
    const looksLikePath = sessionIdOrPath.includes('/') || sessionIdOrPath.endsWith('.json');
    if (looksLikePath) {
        const filePath = path.resolve(sessionIdOrPath);
        await fs.access(filePath);
        return filePath;
    }
    const sessions = await listCliSessions(projectPath);
    const matches = sessions.filter((session) => session.sessionId === sessionIdOrPath || session.sessionId.startsWith(sessionIdOrPath));
    if (matches.length === 0) {
        throw new Error(`Session not found: ${sessionIdOrPath}`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous session id: ${sessionIdOrPath}\n${matches.map((m) => `  - ${m.sessionId}`).join('\n')}`);
    }
    return sessionFilePath(projectPath, matches[0].sessionId);
}
export function createCliSession(input) {
    const nowIso = new Date().toISOString();
    return {
        ...input,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        turns: 0,
        compactedEntries: 0,
        usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        },
        transcript: [],
    };
}
export function sessionFilePath(projectPath, sessionId) {
    return path.join(sessionDir(projectPath), `${sessionId}.json`);
}
export function sessionDir(projectPath) {
    return path.join(projectPath, '.tik', 'sessions');
}
//# sourceMappingURL=session-store.js.map