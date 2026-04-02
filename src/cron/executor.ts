import { appendFileSync } from 'node:fs';
import { runAgentForMessage } from '../gateway/agent-runner.js';
import {
  evaluateSuppression,
  HEARTBEAT_OK_TOKEN,
  type SuppressionState,
} from '../gateway/heartbeat/suppression.js';
import { assertOutboundAllowed, sendMessageWhatsApp } from '../gateway/channels/whatsapp/index.js';
import { resolveSessionStorePath, loadSessionStore, type SessionEntry } from '../gateway/sessions/store.js';
import { cleanMarkdownForWhatsApp } from '../gateway/utils.js';
import {
  pingUpstoxApi,
  UpstoxAuthExpiredError,
  UpstoxMissingTokenError,
} from '../tools/finance/upstox.js';
import { getSetting } from '../utils/config.js';
import { dexterPath } from '../utils/paths.js';
import { saveCronStore } from './store.js';
import { computeNextRunAtMs } from './schedule.js';
import { UPSTOX_HEALTH_SYSTEM_TASK } from './upstox-health-migration.js';
import type { ActiveHours, CronJob, CronStore } from './types.js';

const LOG_PATH = dexterPath('gateway-debug.log');
const UPSTOX_TOKEN_EXPIRED_ALERT = 'CRITICAL: Upstox Token Expired. Run auth script immediately before market open.';

function debugLog(msg: string) {
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

// Per-job suppression state (in memory, resets on process restart)
const suppressionStates = new Map<string, SuppressionState>();

const BACKOFF_SCHEDULE_MS = [
  30_000,      // 1st error → 30s
  60_000,      // 2nd → 1 min
  5 * 60_000,  // 3rd → 5 min
  15 * 60_000, // 4th → 15 min
  60 * 60_000, // 5th+ → 60 min
];

const MAX_AT_RETRIES = 3;
const SCHEDULE_ERROR_DISABLE_THRESHOLD = 3;

function getSuppressionState(jobId: string): SuppressionState {
  let state = suppressionStates.get(jobId);
  if (!state) {
    state = { lastMessageText: null, lastMessageAt: null };
    suppressionStates.set(jobId, state);
  }
  return state;
}

/**
 * Check if the current time is within configured active hours and days.
 */
function isWithinActiveHours(activeHours?: ActiveHours): boolean {
  if (!activeHours) return true;

  const tz = activeHours.timezone ?? 'Asia/Kolkata';
  const now = new Date();

  const allowedDays = activeHours.daysOfWeek ?? [1, 2, 3, 4, 5];
  const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const dayStr = dayFormatter.format(now);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDay = dayMap[dayStr] ?? now.getDay();
  if (!allowedDays.includes(currentDay)) return false;

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const currentTime = timeFormatter.format(now);
  return currentTime >= activeHours.start && currentTime <= activeHours.end;
}

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

/**
 * Find the most recently updated session with a delivery target.
 * Same pattern as heartbeat runner.
 */
function findTargetSession(): SessionEntry | null {
  const storePath = resolveSessionStorePath('default');
  const store = loadSessionStore(storePath);
  const entries = Object.values(store).filter((e) => e.lastTo);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries[0];
}

async function emitSystemAlert(message: string): Promise<boolean> {
  const session = findTargetSession();
  if (!session?.lastTo || !session?.lastAccountId) {
    debugLog('[cron] system alert skipped: no delivery target');
    return false;
  }

  try {
    assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
  } catch {
    debugLog('[cron] system alert skipped: outbound blocked');
    return false;
  }

  try {
    await sendMessageWhatsApp({
      to: session.lastTo,
      body: cleanMarkdownForWhatsApp(message),
      accountId: session.lastAccountId,
    });
    debugLog(`[cron] system alert delivered to ${session.lastTo}`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    debugLog(`[cron] system alert delivery failed: ${msg}`);
    return false;
  }
}

function markJobRun(
  job: CronJob,
  status: 'ok' | 'suppressed',
  startedAt: number,
  store: CronStore,
  details?: { lastError?: string },
): void {
  job.state.lastRunAtMs = startedAt;
  job.state.lastDurationMs = Date.now() - startedAt;
  job.state.lastRunStatus = status;
  job.state.lastError = details?.lastError;
  job.state.consecutiveErrors = 0;
  scheduleNextRun(job, store);
}

async function executeUpstoxHealthCheckJob(job: CronJob, store: CronStore): Promise<void> {
  const startedAt = Date.now();

  try {
    await pingUpstoxApi();
    markJobRun(job, 'suppressed', startedAt, store);
    debugLog(`[cron] job ${job.id}: Upstox health check OK`);
    return;
  } catch (error) {
    if (error instanceof UpstoxAuthExpiredError || error instanceof UpstoxMissingTokenError) {
      const delivered = await emitSystemAlert(UPSTOX_TOKEN_EXPIRED_ALERT);
      markJobRun(job, delivered ? 'ok' : 'suppressed', startedAt, store, {
        ...(delivered ? {} : { lastError: error.message }),
      });
      debugLog(
        `[cron] job ${job.id}: Upstox token health alert ${delivered ? 'delivered' : 'could not be delivered'}`,
      );
      return;
    }

    handleJobError(job, store, error, startedAt);
  }
}

/**
 * Execute a single cron job: run isolated agent, evaluate suppression,
 * deliver via WhatsApp, apply fulfillment mode, update state.
 */
export async function executeCronJob(
  job: CronJob,
  store: CronStore,
  _params: { configPath?: string },
): Promise<void> {
  const startedAt = Date.now();

  if (job.payload.systemTask === UPSTOX_HEALTH_SYSTEM_TASK) {
    await executeUpstoxHealthCheckJob(job, store);
    return;
  }

  // 0. Check active hours
  if (!isWithinActiveHours(job.activeHours)) {
    debugLog(`[cron] job ${job.id}: outside active hours, skipping`);
    scheduleNextRun(job, store);
    return;
  }

  debugLog(`[cron] executing job "${job.name}" (${job.id})`);

  // 1. Find WhatsApp delivery target
  const session = findTargetSession();
  if (!session?.lastTo || !session?.lastAccountId) {
    debugLog(`[cron] job ${job.id}: no delivery target, skipping`);
    scheduleNextRun(job, store);
    return;
  }

  // 2. Verify outbound allowed
  try {
    assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
  } catch {
    debugLog(`[cron] job ${job.id}: outbound blocked, skipping`);
    scheduleNextRun(job, store);
    return;
  }

  // 3. Resolve model
  const model = job.payload.model ?? (getSetting('modelId', 'gpt-5.4') as string);
  const modelProvider = job.payload.modelProvider ?? (getSetting('provider', 'openai') as string);

  // 4. Build query
  let query = `[CRON JOB: ${job.name}]\n\n${job.payload.message}`;
  if (job.fulfillment === 'ask') {
    query += '\n\nIf you find something noteworthy, also ask the user if they want to continue monitoring this.';
  }
  query += `\n\n## Instructions\n- If the condition has NOT been met, you MUST respond with exactly: ${HEARTBEAT_OK_TOKEN}\n- Do NOT send a status update or progress report — the user only wants to hear when the condition IS met\n- Do NOT say things like "no action needed", "still below target", "not yet" — just respond ${HEARTBEAT_OK_TOKEN}\n- Only respond with a real message when there is something actionable to report\n- Keep alerts brief and focused — lead with the key finding`;

  // 5. Run agent
  let answer: string;
  try {
    answer = await runAgentForMessage({
      sessionKey: `cron:${job.id}`,
      query,
      model,
      modelProvider,
      maxIterations: 6,
      isolatedSession: true,
      channel: 'whatsapp',
    });
  } catch (err) {
    handleJobError(job, store, err, startedAt);
    return;
  }

  const durationMs = Date.now() - startedAt;

  // 6. Evaluate suppression
  const suppState = getSuppressionState(job.id);
  const suppResult = evaluateSuppression(answer, suppState);

  // 7. Update job state
  job.state.lastRunAtMs = startedAt;
  job.state.lastDurationMs = durationMs;
  job.state.consecutiveErrors = 0;

  if (suppResult.shouldSuppress) {
    job.state.lastRunStatus = 'suppressed';
    debugLog(`[cron] job ${job.id}: suppressed (${suppResult.reason})`);
  } else {
    job.state.lastRunStatus = 'ok';

    // Deliver via WhatsApp
    const cleaned = cleanMarkdownForWhatsApp(suppResult.cleanedText);
    await sendMessageWhatsApp({
      to: session.lastTo,
      body: cleaned,
      accountId: session.lastAccountId,
    });
    debugLog(`[cron] job ${job.id}: delivered to ${session.lastTo}`);

    // Update suppression state for duplicate detection
    suppState.lastMessageText = suppResult.cleanedText;
    suppState.lastMessageAt = Date.now();

    // Apply fulfillment mode
    if (job.fulfillment === 'once') {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      debugLog(`[cron] job ${job.id}: auto-disabled (fulfillment=once)`);
      job.updatedAtMs = Date.now();
      saveCronStore(store);
      return;
    }
  }

  scheduleNextRun(job, store);
}

function scheduleNextRun(job: CronJob, store: CronStore): void {
  const now = Date.now();

  try {
    const nextRun = computeNextRunAtMs(job.schedule, now);
    if (nextRun === undefined) {
      // One-shot expired or invalid schedule
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
    } else {
      job.state.nextRunAtMs = nextRun;
    }
    job.state.scheduleErrorCount = 0;
  } catch {
    job.state.scheduleErrorCount += 1;
    if (job.state.scheduleErrorCount >= SCHEDULE_ERROR_DISABLE_THRESHOLD) {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      debugLog(`[cron] job ${job.id}: disabled after ${SCHEDULE_ERROR_DISABLE_THRESHOLD} schedule errors`);
    }
  }

  job.updatedAtMs = Date.now();
  saveCronStore(store);
}

function handleJobError(job: CronJob, store: CronStore, err: unknown, startedAt: number): void {
  const errorMsg = err instanceof Error ? err.message : String(err);
  job.state.lastRunAtMs = startedAt;
  job.state.lastDurationMs = Date.now() - startedAt;
  job.state.lastRunStatus = 'error';
  job.state.lastError = errorMsg;
  job.state.consecutiveErrors += 1;

  debugLog(`[cron] job ${job.id}: error #${job.state.consecutiveErrors}: ${errorMsg}`);

  const now = Date.now();

  if (job.schedule.kind === 'at') {
    // One-shot: retry up to MAX_AT_RETRIES, then disable
    if (job.state.consecutiveErrors >= MAX_AT_RETRIES) {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      debugLog(`[cron] job ${job.id}: disabled after ${MAX_AT_RETRIES} retries (at job)`);
    } else {
      job.state.nextRunAtMs = now + errorBackoffMs(job.state.consecutiveErrors);
    }
  } else {
    // Recurring: apply exponential backoff
    const normalNext = computeNextRunAtMs(job.schedule, now);
    const backoff = now + errorBackoffMs(job.state.consecutiveErrors);
    job.state.nextRunAtMs = normalNext ? Math.max(normalNext, backoff) : backoff;
  }

  job.updatedAtMs = Date.now();
  saveCronStore(store);
}
