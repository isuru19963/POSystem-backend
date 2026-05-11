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
 */
export async function drainDuplicateInboxJobs(
  queue: Queue,
  logger: Logger,
): Promise<number> {
  const waiting: Job[] = await queue.getWaiting(0, 500);
  const monitorWaiting = waiting.filter(
    (j) => j.name === JOB_NAMES.MONITOR_INBOX,
  );
  if (monitorWaiting.length <= 1) return 0;

  const toRemove = monitorWaiting.slice(1);
  logger.warn(
    `Draining ${toRemove.length} duplicate monitor-inbox jobs from queue (keeping oldest)`,
  );
  await Promise.all(toRemove.map((j) => j.remove()));
  return toRemove.length;
}
