import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { JOB_NAMES } from '../common/constants/app.constants';

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

  const job = await queue.add(
    JOB_NAMES.MONITOR_INBOX,
    {},
    {
      // Keep finished jobs around long enough for the UI to read the result.
      removeOnComplete: { age: 30 * 60 }, // 30 min
      removeOnFail: { age: 60 * 60 }, // 1 h
    },
  );
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

  const monitorActive = active.filter(
    (j) => j.name === JOB_NAMES.MONITOR_INBOX,
  );
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
          `Evicted orphaned active monitor-inbox job ${job.id} on startup`,
        );
      } catch (err) {
        logger.warn(
          `Failed to evict active monitor-inbox job ${job.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  const monitorWaiting = waiting.filter(
    (j) => j.name === JOB_NAMES.MONITOR_INBOX,
  );
  if (monitorWaiting.length <= 1) return monitorActive.length;

  const toRemove = monitorWaiting.slice(1);
  logger.warn(
    `Draining ${toRemove.length} duplicate monitor-inbox jobs from queue (keeping oldest)`,
  );
  await Promise.all(toRemove.map((j) => j.remove()));
  return toRemove.length + monitorActive.length;
}
