import { randomBytes } from 'node:crypto';
import { hasUpstoxAccessToken, hasUpstoxCredentials } from '../tools/finance/upstox.js';
import { loadCronStore, saveCronStore } from './store.js';
import { computeNextRunAtMs } from './schedule.js';
import type { CronJob } from './types.js';

export const UPSTOX_HEALTH_JOB_NAME = 'Upstox OAuth Health Check';
export const UPSTOX_HEALTH_SYSTEM_TASK = 'upstox_health_check';

const UPSTOX_HEALTH_CRON_EXPR = '0 8 * * 1-5';
const UPSTOX_HEALTH_TIMEZONE = 'Asia/Kolkata';

export function ensureUpstoxHealthCronJob(): void {
  const shouldEnable = hasUpstoxCredentials() || hasUpstoxAccessToken();
  const store = loadCronStore();
  const existing = store.jobs.find(
    (job) => job.payload.systemTask === UPSTOX_HEALTH_SYSTEM_TASK || job.name === UPSTOX_HEALTH_JOB_NAME,
  );

  if (!shouldEnable) {
    if (existing?.enabled) {
      existing.enabled = false;
      existing.state.nextRunAtMs = undefined;
      existing.updatedAtMs = Date.now();
      saveCronStore(store);
    }
    return;
  }

  const schedule = {
    kind: 'cron' as const,
    expr: UPSTOX_HEALTH_CRON_EXPR,
    tz: UPSTOX_HEALTH_TIMEZONE,
  };

  if (existing) {
    existing.name = UPSTOX_HEALTH_JOB_NAME;
    existing.description = 'Pre-market Upstox OAuth token health check';
    existing.schedule = schedule;
    existing.payload.message = 'Internal Upstox OAuth health check.';
    existing.payload.systemTask = UPSTOX_HEALTH_SYSTEM_TASK;
    existing.fulfillment = 'keep';
    existing.enabled = true;
    existing.state.consecutiveErrors = 0;
    existing.state.scheduleErrorCount = 0;
    existing.state.nextRunAtMs = computeNextRunAtMs(schedule, Date.now());
    existing.updatedAtMs = Date.now();
    saveCronStore(store);
    return;
  }

  const now = Date.now();
  const job: CronJob = {
    id: randomBytes(8).toString('hex'),
    name: UPSTOX_HEALTH_JOB_NAME,
    description: 'Pre-market Upstox OAuth token health check',
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    payload: {
      message: 'Internal Upstox OAuth health check.',
      systemTask: UPSTOX_HEALTH_SYSTEM_TASK,
    },
    fulfillment: 'keep',
    state: {
      nextRunAtMs: computeNextRunAtMs(schedule, now),
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
    },
  };

  store.jobs.push(job);
  saveCronStore(store);
}
