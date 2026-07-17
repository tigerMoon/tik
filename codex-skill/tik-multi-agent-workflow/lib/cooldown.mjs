/**
 * CLI-side cooldown lock for `continue` / `next` / `status`.
 *
 * When Tik reports `awaiting_native_runtime`, it also returns
 * `retry-after` (HTTP header) and `retryAfterMs` (body field). We persist a
 * per-workflow cooldown record so subsequent invocations of the same
 * workflow's polling commands in the cooldown window abort early with
 * `exit 3` and `action: 'cooldown'` — matching the skill's async-wait
 * contract that says "don't block the main thread; end the turn and let the
 * callback resume".
 *
 * Bypasses:
 *   - `--force` on the command line
 *   - `TIK_DISABLE_COOLDOWN=1` environment variable
 *
 * Lock files live at `~/.tik/state/cooldown-<workflowId>.json`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const COOLDOWN_MIN_MS = 2_000;
const COOLDOWN_MAX_MS = 60_000;

export function cooldownStateDir() {
  return path.join(os.homedir(), '.tik', 'state');
}

export function cooldownFile(workflowId) {
  if (!workflowId) return null;
  // Path-safe: workflowIds are already `wf_<hex>_<hex>` shaped by Kernel.
  const safe = String(workflowId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(cooldownStateDir(), `cooldown-${safe}.json`);
}

export function cooldownBypassed(options = {}) {
  if (options && options.force === true) return true;
  if (options && options.forceRun === true) return true;
  if (process.env.TIK_DISABLE_COOLDOWN === '1') return true;
  return false;
}

/**
 * Read an existing cooldown record for `workflowId`. Returns null when there
 * is no active cooldown. Silently returns null on any read/parse error — a
 * missing or corrupt lock never blocks the caller (fail-open).
 */
export async function readCooldown(workflowId) {
  const file = cooldownFile(workflowId);
  if (!file || !existsSync(file)) return null;
  try {
    const text = await readFile(file, 'utf8');
    const record = JSON.parse(text);
    if (!record?.nextEligibleAt) return null;
    const nextEligibleAt = Date.parse(record.nextEligibleAt);
    if (!Number.isFinite(nextEligibleAt)) return null;
    return { ...record, nextEligibleAtMs: nextEligibleAt };
  } catch {
    return null;
  }
}

export async function writeCooldown(workflowId, record) {
  const file = cooldownFile(workflowId);
  if (!file) return;
  await mkdir(cooldownStateDir(), { recursive: true });
  await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
}

/** Delete the cooldown record for a workflow (used on expiry / completion). */
export async function removeCooldown(workflowId) {
  const file = cooldownFile(workflowId);
  if (!file || !existsSync(file)) return;
  await rm(file, { force: true }).catch(() => undefined);
}

/**
 * Called by `continue`/`next`/`status` before hitting the API. When a cooldown
 * is active, returns `{ blocked: true, snapshot }` so the caller can emit a
 * cooldown JSON payload and exit(3). Otherwise returns `{ blocked: false }`.
 *
 * Expired records are removed from disk so ~/.tik/state does not accumulate
 * one file per completed workflow.
 */
export async function checkCooldown(workflowId, options = {}) {
  if (!workflowId) return { blocked: false };
  if (cooldownBypassed(options)) return { blocked: false, bypassed: true };
  const record = await readCooldown(workflowId);
  if (!record) return { blocked: false };
  const now = Date.now();
  const remainingMs = record.nextEligibleAtMs - now;
  if (remainingMs <= 0) {
    // Best-effort cleanup so the file doesn't linger for every completed
    // workflow. Errors are ignored — the record is already expired so the
    // next writeCooldown will overwrite anyway.
    await removeCooldown(workflowId).catch(() => undefined);
    return { blocked: false, expired: true };
  }
  return {
    blocked: true,
    snapshot: {
      action: 'cooldown',
      workflowId,
      nextEligibleAt: record.nextEligibleAt,
      remainingMs,
      lastReason: record.reason,
      lastReasonCode: record.reasonCode,
      hint: 'Skill contract forbids polling during awaiting_native_runtime cooldown. End the turn; the Questioner / Builder / Evaluator callback will resume the workflow. Pass --force to override (rare).',
    },
  };
}

/**
 * Called after any Tik API response that includes an `awaiting_native_runtime`
 * signal. Persists a cooldown window sized from the server's `retryAfterMs`.
 * Values are clamped to [2s, 60s].
 */
export async function installCooldownFromResponse(workflowId, response) {
  if (!workflowId || !response) return;
  const planned = response.plannedAction || response;
  if (planned?.reasonCode !== 'awaiting_native_runtime') return;
  const httpRetryMs = response.__http?.retryAfterMs;
  // Preference order for the body-level retry hint. /next-action nests it
  // under plannedAction; some routes emit it at the top of the response; a
  // rare edge case has it only on the wrapper. Also fall back to inspecting
  // `plannedAction.retryAfterMs` explicitly even when `planned === response`
  // (defensive against future response shapes).
  const bodyRetryMs = firstFiniteNumber([
    planned.retryAfterMs,
    response.retryAfterMs,
    response.plannedAction?.retryAfterMs,
  ]);
  const raw = Number.isFinite(httpRetryMs)
    ? httpRetryMs
    : Number.isFinite(bodyRetryMs)
      ? bodyRetryMs
      : COOLDOWN_MIN_MS;
  // NaN-safe clamp: if `raw` is NaN, fall back to the floor before Math.max/
  // min (which would otherwise propagate NaN).
  const safeRaw = Number.isFinite(raw) ? raw : COOLDOWN_MIN_MS;
  const cooldownMs = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, safeRaw));
  const now = Date.now();
  const proposedEligibleAtMs = now + cooldownMs;
  // Never shrink an existing cooldown. If a longer cooldown is already
  // installed, keep it — a subsequent shorter server hint must not let the
  // caller resume before the original window closes.
  const existing = await readCooldown(workflowId);
  const nextEligibleAtMs = existing?.nextEligibleAtMs
    ? Math.max(existing.nextEligibleAtMs, proposedEligibleAtMs)
    : proposedEligibleAtMs;
  await writeCooldown(workflowId, {
    workflowId,
    createdAt: new Date(now).toISOString(),
    nextEligibleAt: new Date(nextEligibleAtMs).toISOString(),
    cooldownMs: nextEligibleAtMs - now,
    reason: planned.reason,
    reasonCode: planned.reasonCode,
    subtaskId: planned.subtaskId,
  });
}

function firstFiniteNumber(candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Semantic exit code for cooldown blocks; distinct from 1 (generic error). */
export const COOLDOWN_EXIT_CODE = 3;
