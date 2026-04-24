/**
 * SIGHT Plugin Types
 *
 * Pluggable context/memory provider interface.
 * Implementations: Local (default), Letta, Degradable.
 */

import type { ContextFragment } from '../context/types.js';

// ─── Context Provider ────────────────────────────────────────

export interface IContextProvider {
  name: string;
  /** Get context fragments for a task */
  getFragments(projectPath: string, taskId: string, iteration: number): Promise<ContextFragment[]>;
}

// ─── Memory Provider ─────────────────────────────────────────

export interface IMemoryProvider {
  name: string;
  recordRun(data: unknown): Promise<void>;
  recordFailure(data: unknown): Promise<void>;
  recordDecision(data: unknown): Promise<void>;
  getPatterns(): Promise<unknown[]>;
}

// ─── Block Provider (Letta-style) ────────────────────────────

export interface IBlockProvider {
  getBlock(label: string): Promise<string | null>;
  setBlock(label: string, value: string): Promise<void>;
  appendToBlock(label: string, text: string): Promise<void>;
  listBlocks(): Promise<Array<{ label: string; size: number }>>;
}

// ─── Archival Provider ───────────────────────────────────────

export interface IArchivalProvider {
  insert(text: string, tags: string[], source: string): Promise<string>;
  search(query: string, tags?: string[], topK?: number): Promise<Array<{ id: string; text: string; score: number }>>;
}

// ─── Unified Plugin Interface ────────────────────────────────

export interface IContextMemoryPlugin {
  name: string;
  version: string;
  context: IContextProvider;
  memory: IMemoryProvider;
  blocks?: IBlockProvider;
  archival?: IArchivalProvider;
  initialize?(config: Record<string, unknown>): Promise<void>;
  dispose?(): Promise<void>;
}
