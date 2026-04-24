import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ConvergenceStrategy } from '@tik/shared';
import type { ProviderOption } from './types.js';

export interface PersistedCliSession {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  provider: ProviderOption;
  llmName: string;
  model?: string;
  mode: 'single' | 'multi';
  strategy: ConvergenceStrategy;
  maxIterations: number;
  turns: number;
  compactedEntries?: number;
  compactSummary?: {
    keyFacts: string[];
    pendingWork: string[];
    currentWork?: string;
  };
  lastTaskId?: string;
  lastTaskStatus?: string;
  lastPrompt?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  transcript?: Array<{
    timestamp: string;
    kind: 'user' | 'result' | 'command' | 'system';
    content: string;
  }>;
}

export interface CliSessionSummary {
  sessionId: string;
  projectPath: string;
  updatedAt: string;
  turns: number;
  provider: ProviderOption;
  mode: 'single' | 'multi';
  strategy: ConvergenceStrategy;
  lastTaskId?: string;
  lastTaskStatus?: string;
}

export async function saveCliSession(session: PersistedCliSession): Promise<string> {
  const filePath = sessionFilePath(session.projectPath, session.sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const nowIso = new Date().toISOString();
  const nextSession: PersistedCliSession = {
    ...session,
    updatedAt: nowIso,
    createdAt: session.createdAt || nowIso,
  };
  await fs.writeFile(filePath, JSON.stringify(nextSession, null, 2), 'utf-8');
  return filePath;
}

export async function listCliSessions(projectPath: string): Promise<CliSessionSummary[]> {
  const dir = sessionDir(projectPath);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const sessions: CliSessionSummary[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedCliSession;
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
    } catch {
      // Ignore malformed session files.
    }
  }

  return sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export async function loadCliSession(projectPath: string, sessionIdOrPath: string): Promise<PersistedCliSession> {
  const filePath = await resolveCliSessionPath(projectPath, sessionIdOrPath);
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as PersistedCliSession;
}

export async function resolveCliSessionPath(projectPath: string, sessionIdOrPath: string): Promise<string> {
  const looksLikePath = sessionIdOrPath.includes('/') || sessionIdOrPath.endsWith('.json');
  if (looksLikePath) {
    const filePath = path.resolve(sessionIdOrPath);
    await fs.access(filePath);
    return filePath;
  }

  const sessions = await listCliSessions(projectPath);
  const matches = sessions.filter((session) =>
    session.sessionId === sessionIdOrPath || session.sessionId.startsWith(sessionIdOrPath),
  );

  if (matches.length === 0) {
    throw new Error(`Session not found: ${sessionIdOrPath}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous session id: ${sessionIdOrPath}\n${matches.map((m) => `  - ${m.sessionId}`).join('\n')}`);
  }

  return sessionFilePath(projectPath, matches[0].sessionId);
}

export function createCliSession(input: Omit<PersistedCliSession, 'version' | 'createdAt' | 'updatedAt' | 'turns'>): PersistedCliSession {
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

export function sessionFilePath(projectPath: string, sessionId: string): string {
  return path.join(sessionDir(projectPath), `${sessionId}.json`);
}

export function sessionDir(projectPath: string): string {
  return path.join(projectPath, '.tik', 'sessions');
}
