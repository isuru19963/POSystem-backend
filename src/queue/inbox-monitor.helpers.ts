import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { JOB_NAMES } from '../common/constants/app.constants';

/** Jobs that scan IMAP; used for dedupe + orphan cleanup */
export const INBOX_MONITOR_JOB_NAMES = [
  JOB_NAMES.MONITOR_INBOX,
  JOB_NAMES.MONITOR_INBOX_PO,
  JOB_NAMES.MONITOR_INBOX_GRN,
] as const;

function isInboxMonitorJobName(name: string): boolean {
  return (INBOX_MONITOR_JOB_NAMES as readonly string[]).includes(name);
}

const inboxJobOpts = {
  removeOnComplete: { age: 30 * 60 },
  removeOnFail: { age: 60 * 60 },
} as const;

/** Manual fetch buttons run ahead of the slow cron inbox scan. */
const MANUAL_INBOX_PRIORITY = 10;
const CRON_INBOX_PRIORITY = 1;

/** Preempt slow inbox scans so manual GRN/PO fetch can start on the worker. */
async function preemptBlockingInboxJobs(
  queue: Queue,
  logger?: Logger,
  opts?: { forManualJob?: string },
): Promise<void> {
  const [waiting, active] = await Promise.all([
    queue.getWaiting(0, 100),
    queue.getActive(0, 100),
  ]);
  const toPreempt = [...active, ...waiting].filter((j) => {
    if (!isInboxMonitorJobName(j.name)) return false;
    if (opts?.forManualJob && j.name === opts.forManualJob) return false;
    return true;
  });
  for (const job of toPreempt) {
    const state = await job.getState();
    if (state === 'active') {
      await evictStaleActiveJob(queue, job, logger);
    } else {
      try {
        await job.remove();
      } catch {
        /* ignore */
      }
    }
  }
  if (toPreempt.length) {
    logger?.warn(
      `Preempted ${toPreempt.length} inbox job(s) for manual fetch`,
    );
  }
}

/**
 * Returns the in-flight `monitor-inbox` job if one is already waiting or
 * actively running, otherwise enqueues a new one.
 *
 * Without this, the 5-minute cron + slow IMAP scans (which can legitimately
 * exceed 5 minutes) cause the worker to fall behind and the queue piles up
 * with redundant jobs.
 */
export async function enqueueInboxMonitor(
  queue: Queue,
  logger?: Logger,
): Promise<{ jobId: string; alreadyPending: boolean }> {
  const [waiting, active] = await Promise.all([
    queue.getWaiting(0, 50),
    queue.getActive(0, 50),
  ]);
  const pending = [...active, ...waiting].find(
    (j) => j.name === JOB_NAMES.MONITOR_INBOX,
  );
  if (pending) {
    logger?.debug(`Reusing in-flight monitor-inbox job ${pending.id}`);
    return { jobId: String(pending.id), alreadyPending: true };
  }

  const job = await queue.add(JOB_NAMES.MONITOR_INBOX, {}, {
    ...inboxJobOpts,
    priority: CRON_INBOX_PRIORITY,
  });
  return { jobId: String(job.id), alreadyPending: false };
}

/**
 * Manual "Fetch PO" / "Fetch GRN" buttons: each uses its own BullMQ job name so
 * the two actions never block each other, and dedupe only applies per-button
 * (double-click on the same button reuses the in-flight job).
 */
/** Do not attach the UI to a job that has been "active" longer than this. */
const MAX_REUSE_ACTIVE_MS = 35 * 60_000;

async function evictStaleActiveJob(
  queue: Queue,
  job: Job,
  logger?: Logger,
): Promise<void> {
  try {
    const client = await queue.client;
    const prefix = queue.opts.prefix ?? 'bull';
    await client.del(`${prefix}:${queue.name}:${job.id}:lock`);
    await job.moveToFailed(
      new Error('Stale inbox job evicted — starting a fresh fetch.'),
      '0',
      false,
    );
    logger?.warn(`Evicted stale active inbox job ${job.name}#${job.id}`);
  } catch (err) {
    logger?.warn(
      `Could not evict stale job ${job.id}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function enqueueManualInboxFetch(
  queue: Queue,
  jobName: typeof JOB_NAMES.MONITOR_INBOX_PO | typeof JOB_NAMES.MONITOR_INBOX_GRN,
  logger?: Logger,
): Promise<{ jobId: string; alreadyPending: boolean }> {
  try {
    await Promise.race([
      preemptBlockingInboxJobs(queue, logger, { forManualJob: jobName }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('preempt timeout')), 8_000),
      ),
    ]);
  } catch (err) {
    logger?.warn(
      `Skipped preempting inbox jobs (non-fatal): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  const [waiting, active] = await Promise.all([
    queue.getWaiting(0, 50),
    queue.getActive(0, 50),
  ]);
  const pending = [...active, ...waiting].find((j) => j.name === jobName);
  if (pending) {
    const ageMs = pending.processedOn
      ? Date.now() - pending.processedOn
      : 0;
    const state = await pending.getState();
    if (state === 'active' && ageMs > MAX_REUSE_ACTIVE_MS) {
      await evictStaleActiveJob(queue, pending, logger);
    } else {
      logger?.debug(`Reusing in-flight ${jobName} job ${pending.id}`);
      return { jobId: String(pending.id), alreadyPending: true };
    }
  }

  const job = await queue.add(jobName, {}, {
    ...inboxJobOpts,
    priority: MANUAL_INBOX_PRIORITY,
  });
  return { jobId: String(job.id), alreadyPending: false };
}

export interface InboxJobStatusPayload {
  jobId: string;
  state: string;
  result: unknown;
  failedReason: string | null;
  processedOn: number | null;
  finishedOn: number | null;
  queuePosition: number | null;
  statusMessage: string | null;
}

/** Poll payload for manual inbox fetch jobs (GRN / PO). */
export async function getInboxJobStatus(
  queue: Queue,
  jobId: string,
): Promise<InboxJobStatusPayload | null> {
  const job = await queue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  let queuePosition: number | null = null;
  let statusMessage: string | null = null;

  if (state === 'waiting' || state === 'delayed') {
    const waiting = await queue.getWaiting(0, 200);
    const idx = waiting.findIndex((j) => String(j.id) === jobId);
    queuePosition = idx >= 0 ? idx : null;
    statusMessage =
      'Waiting in queue — another inbox scan is still running on the server. This usually starts within a minute after deploy; if it stays here, click Fetch again.';
  } else if (state === 'active') {
    statusMessage =
      'Scanning mailbox and importing — this can take several minutes.';
  }

  return {
    jobId,
    state,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    queuePosition,
    statusMessage,
  };
}

/**
 * Drop redundant `monitor-inbox` jobs that accumulated while the worker was
 * stuck on a slow IMAP fetch. Keeps the single oldest waiting job so the
 * worker still has something to process when it comes back online.
 *
 * Also evicts any `active` monitor-inbox jobs left over from a previous process
 * — those are necessarily orphaned (the process that held their lock is gone),
 * and waiting for BullMQ's stalled detection (every `stalledInterval`) before
 * the next run would block the user for 10+ minutes after every restart.
 */
export async function drainDuplicateInboxJobs(
  queue: Queue,
  logger: Logger,
): Promise<number> {
  const [waiting, active] = await Promise.all([
    queue.getWaiting(0, 500),
    queue.getActive(0, 500),
  ]);

  const monitorActive = active.filter((j) => isInboxMonitorJobName(j.name));
  if (monitorActive.length > 0) {
    // Any active monitor-inbox job at startup is by definition orphaned: the
    // worker that held its lock is gone. The lock is still in Redis though,
    // which blocks `job.remove()` and `moveToFailed` until BullMQ's stalled
    // scanner (`stalledInterval`) finally notices — that's a 10-minute UX gap
    // after every restart. Drop the lock keys directly so we can recover
    // immediately.
    const client = await queue.client;
    const prefix = queue.opts.prefix ?? 'bull';
    for (const job of monitorActive) {
      try {
        await client.del(`${prefix}:${queue.name}:${job.id}:lock`);
        const isManualFetch =
          job.name === JOB_NAMES.MONITOR_INBOX_PO ||
          job.name === JOB_NAMES.MONITOR_INBOX_GRN;
        if (isManualFetch) {
          // Keep the same job id so the UI can keep polling after a deploy.
          await job.moveToFailed(
            new Error('Worker restarted — re-queuing inbox fetch.'),
            '0',
            false,
          );
          await job.retry();
          logger.warn(
            `Requeued orphaned manual inbox job ${job.name}#${job.id} on startup`,
          );
        } else {
          await job.moveToFailed(
            new Error(
              'Worker restarted while job was active — discarding orphan.',
            ),
            '0',
            false,
          );
          logger.warn(
            `Evicted orphaned active inbox job ${job.name}#${job.id} on startup`,
          );
        }
      } catch (err) {
        logger.warn(
          `Failed to evict active inbox job ${job.name}#${job.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  let drained = monitorActive.length;
  for (const name of INBOX_MONITOR_JOB_NAMES) {
    const sameName = waiting.filter((j) => j.name === name);
    if (sameName.length <= 1) continue;
    const toRemove = sameName.slice(1);
    logger.warn(
      `Draining ${toRemove.length} duplicate ${name} jobs (keeping oldest)`,
    );
    await Promise.all(toRemove.map((j) => j.remove()));
    drained += toRemove.length;
  }
  return drained;
}
