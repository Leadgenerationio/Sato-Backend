import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tasks } from '../db/schema/tasks.js';
import { logActivity } from '../services/task-activity.service.js';
import { cronNextFire, isValidCron } from '../utils/cron-next.js';
import { logger } from '../utils/logger.js';

// Slice 5 Day 4 (Sam Loom #96) — recurring tasks. The schedule worker
// fires every 5 min; this function picks tasks whose recurrence_next_run
// has passed, clones them as fresh `todo` rows for the next cycle, and
// advances the parent's recurrence_next_run pointer.
//
// The clone strategy mirrors how a kanban "duplicate task" would work —
// copy the title/description/assignee/priority/category/timeBlockMinutes/
// linkedSopId, leave dueDate at the cron fire time (so the new row is
// "due" when the cron next fires after that), and reset status to 'todo'.

export interface ProcessRecurringResult {
  fired: number;
  skipped: number;
  invalid: number;
  errors: number;
}

export async function processRecurringTasks(now: Date = new Date()): Promise<ProcessRecurringResult> {
  const dueRows = await db
    .select()
    .from(tasks)
    .where(and(
      isNotNull(tasks.recurrenceCron),
      lte(tasks.recurrenceNextRun, now),
    ));

  const result: ProcessRecurringResult = { fired: 0, skipped: 0, invalid: 0, errors: 0 };

  for (const parent of dueRows) {
    const cron = parent.recurrenceCron;
    if (!cron) {
      result.skipped += 1;
      continue;
    }
    if (!isValidCron(cron)) {
      // Clear the next_run so we stop hammering this row every tick;
      // logger surfaces the bad expression so it can be fixed.
      logger.warn({ taskId: parent.id, cron }, 'Invalid cron on task — clearing recurrence_next_run');
      try {
        await db
          .update(tasks)
          .set({ recurrenceNextRun: null, updatedAt: new Date() })
          .where(eq(tasks.id, parent.id));
      } catch (err) {
        logger.error({ err, taskId: parent.id }, 'Failed to clear invalid cron');
      }
      result.invalid += 1;
      continue;
    }

    try {
      const dueDate = parent.recurrenceNextRun ?? now;
      const [clone] = await db
        .insert(tasks)
        .values({
          businessId: parent.businessId,
          title: parent.title,
          description: parent.description ?? '',
          assignee: parent.assignee ?? '',
          priority: parent.priority,
          status: 'todo',
          category: parent.category ?? 'general',
          createdBy: parent.createdBy,
          dueDate,
          timeBlockMinutes: parent.timeBlockMinutes ?? null,
          linkedSopId: parent.linkedSopId ?? null,
          parentTaskId: parent.id,
          // Clones don't themselves recur — only the original is the
          // source-of-truth schedule. Prevents an exponentiating tree of
          // recurrences if a user accidentally sets cron on a clone.
          recurrenceCron: null,
          recurrenceNextRun: null,
          auditLog: [{
            action: `Auto-created from recurring task "${parent.title}"`,
            user: parent.createdBy,
            timestamp: now.toISOString(),
          }],
        })
        .returning();

      // Compute next fire AFTER `dueDate` (not after `now`) so dense
      // schedules (e.g. every-15-min) don't skip ticks when the worker
      // is delayed.
      const nextRun = cronNextFire(cron, dueDate);
      await db
        .update(tasks)
        .set({ recurrenceNextRun: nextRun, updatedAt: new Date() })
        .where(eq(tasks.id, parent.id));

      // Event on the PARENT — the feed view shows "this recurrence fired".
      await logActivity(parent.id, null, 'task_updated', {
        recurrence: 'fired',
        cloneId: clone.id,
        nextRun: nextRun.toISOString(),
      });
      // Event on the CLONE — same event vocabulary as a normal create.
      await logActivity(clone.id, null, 'task_created', {
        title: clone.title,
        fromRecurringParent: parent.id,
      });

      result.fired += 1;
    } catch (err) {
      logger.error({ err, taskId: parent.id }, 'Failed to process recurring task');
      result.errors += 1;
    }
  }

  if (result.fired || result.invalid || result.errors) {
    logger.info(result, 'Recurring tasks tick complete');
  }
  return result;
}
