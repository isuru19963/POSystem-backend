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

  const job = await queue.add(JOB_NAMES.MONITOR_INBOX, {}, inboxJobOpts);
  return { jobId: String(job.id), alreadyPending: false };
}

/**
 * Manual "Fetch PO" / "Fetch GRN" buttons: each uses its own BullMQ job name so
 * the two actions never block each other, and dedupe only applies per-button
 * (double-click on the same button reuses the in-flight job).
 */
export async function enqueueManualInboxFetch(
  queue: Queue,
  jobName: typeof JOB_NAMES.MONITOR_INBOX_PO | typeof JOB_NAMES.MONITOR_INBOX_GRN,
  logger?: Logger,
): Promise<{ jobId: string; alreadyPending: boolean }> {
  const [waiting, active] = await Promise.all([
    queue.getWaiting(0, 50),
    queue.getActive(0, 50),
  ]);
  const pending = [...active, ...waiting].find((j) => j.name === jobName);
  if (pending) {
    logger?.debug(`Reusing in-flight ${jobName} job ${pending.id}`);
    return { jobId: String(pending.id), alreadyPending: true };
  }

  const job = await queue.add(jobName, {}, inboxJobOpts);
  return { jobId: String(job.id), alreadyPending: false };
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
    // after every restart. Drop the lock keys directly so we can fail the job
    // immediately.
    const client = await queue.client;
    const prefix = queue.opts.prefix ?? 'bull';
    for (const job of monitorActive) {
      try {
        await client.del(`${prefix}:${queue.name}:${job.id}:lock`);
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
