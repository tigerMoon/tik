import type { FileMultiAgentWorkflowStore } from './workflow-store.js';
import type { MultiAgentWorkflowRecord } from '@tik/shared';

const OPEN_STATUSES: ReadonlySet<MultiAgentWorkflowRecord['status']> = new Set([
  'created',
  'questioning_requirements',
  'planning',
  'task_graph_questioning',
  'active',
  'blocked',
  'human_review_required',
]);

export interface StaleDetectorOptions {
  /** How often to run the scan. Defaults to 30 minutes. */
  intervalMs?: number;
  /** How long since the last activity before a workflow is marked stale. Defaults to 6 hours. */
  staleThresholdMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Result of a single stale-detector scan.
 */
export interface StaleDetectorScanResult {
  totalWorkflows: number;
  openWorkflows: number;
  markedStale: string[];
  alreadyStale: string[];
}

/**
 * Scan all workflows and mark any open, no-recent-activity workflow as stale
 * by writing `workflow.metadata.staleAt` + `workflow.metadata.staleReason`.
 * Does NOT change `status` — the workflow record is left intact and the caller
 * can decide whether to `abandon-workflow` it or resume with `--workflow <id>`.
 *
 * "Activity" is defined as the most recent of:
 *   - `workflow.updatedAt`
 *   - `latestEvidence.createdAt`
 *   - `latestDecision.decidedAt`
 * The detector reads through the workflow bundle to get evidence and decisions,
 * so it's O(open workflows × files-per-workflow). For small deployments this
 * is fine; large deployments should add a per-workflow last-activity cache.
 */
export async function scanForStaleWorkflows(
  store: FileMultiAgentWorkflowStore,
  options: StaleDetectorOptions = {},
): Promise<StaleDetectorScanResult> {
  const now = (options.now?.() ?? new Date()).getTime();
  const thresholdMs = options.staleThresholdMs ?? 6 * 60 * 60 * 1000;
  const workflows = await store.listWorkflowRecords();
  const result: StaleDetectorScanResult = {
    totalWorkflows: workflows.length,
    openWorkflows: 0,
    markedStale: [],
    alreadyStale: [],
  };
  for (const workflow of workflows) {
    if (!OPEN_STATUSES.has(workflow.status)) continue;
    result.openWorkflows += 1;
    if ((workflow.metadata as Record<string, unknown> | undefined)?.staleAt) {
      result.alreadyStale.push(workflow.id);
      continue;
    }
    // Cheap short-circuit: workflow.updatedAt bumps on every mutation, so if
    // it is already fresh we can skip the O(files) bundle read entirely.
    // Only when updatedAt looks stale do we walk evidence/decisions/
    // invocations to compute the "true" lastActivityAt.
    const workflowUpdatedAt = Date.parse(workflow.updatedAt);
    if (Number.isFinite(workflowUpdatedAt) && now - workflowUpdatedAt < thresholdMs) {
      continue;
    }
    const lastActivityAt = await computeLastActivityMs(store, workflow);
    if (!Number.isFinite(lastActivityAt)) continue;
    if (now - lastActivityAt < thresholdMs) continue;
    // Re-read the workflow record inside the mutation window in case another
    // writer moved metadata between our list call and this update. The
    // store's shallow-merge metadata semantics (mergeWorkflowMetadata) means
    // this write only adds staleAt/staleReason/lastActivityAt — it does not
    // clobber concurrent writers' fields (e.g. pausedAt from `pause-workflow`).
    try {
      await store.updateWorkflow(workflow.id, {
        metadata: {
          staleAt: new Date(now).toISOString(),
          staleReason: `no_activity_${Math.round(thresholdMs / 3_600_000)}h`,
          lastActivityAt: new Date(lastActivityAt).toISOString(),
        },
      });
      result.markedStale.push(workflow.id);
    } catch {
      // Fail-open: a single failed mark should not kill the scan. Next tick
      // will retry. The caller can log this externally if desired.
    }
  }
  return result;
}

async function computeLastActivityMs(
  store: FileMultiAgentWorkflowStore,
  workflow: MultiAgentWorkflowRecord,
): Promise<number> {
  let latest = Date.parse(workflow.updatedAt);
  const bundle = await store.readBundle(workflow.id).catch(() => null);
  if (!bundle) return latest;
  for (const evidence of bundle.evidence) {
    const t = Date.parse(evidence.createdAt);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  for (const decision of bundle.decisions) {
    const t = Date.parse(decision.decidedAt);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  for (const invocation of bundle.invocations) {
    const started = invocation.startedAt ? Date.parse(invocation.startedAt) : NaN;
    const created = invocation.createdAt ? Date.parse(invocation.createdAt) : NaN;
    if (Number.isFinite(started) && started > latest) latest = started;
    if (Number.isFinite(created) && created > latest) latest = created;
  }
  return latest;
}

/**
 * Start a periodic stale-detector scan on a Fastify server. Returns a
 * teardown function that cancels the timer; register it in `fastify.onClose`
 * to avoid leaking timers on shutdown.
 */
export function startStaleDetector(
  store: FileMultiAgentWorkflowStore,
  options: StaleDetectorOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 30 * 60 * 1000;
  let inFlight = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(runOnce, intervalMs);
    // Node timers keep the event loop alive; unref so the process can exit
    // cleanly if all real work is done.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  };

  const runOnce = async () => {
    if (stopped) return;
    // Guard against overlapping scans: if the previous scan is still running
    // when the timer fires, skip this tick and re-schedule. Prevents two
    // concurrent scans from racing on updateWorkflow.
    if (inFlight) {
      scheduleNext();
      return;
    }
    inFlight = true;
    try {
      await scanForStaleWorkflows(store, options);
    } catch {
      // Swallow — a background scan crashing should not affect request handlers.
    } finally {
      inFlight = false;
      scheduleNext();
    }
  };

  // Kick off the first scan asynchronously so callers of startStaleDetector
  // do not block on the initial disk walk. The scan schedules the next tick
  // itself when it completes.
  runOnce();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
