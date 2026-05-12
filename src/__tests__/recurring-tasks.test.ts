import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tasks } from '../db/schema/tasks.js';
import { processRecurringTasks } from '../jobs/recurring-tasks.js';

// Slice 5 Day 4 — recurring tasks worker. Seeds a parent task whose
// recurrence is "due" relative to a synthetic `now`, runs the processor,
// asserts the clone was created and the parent's next_run advanced.

describe('processRecurringTasks', () => {
  let businessId: string;
  let parentId: string;

  beforeAll(async () => {
    // Reuse an existing test business if one exists, otherwise create one
    // via the path the seed uses.
    const { businesses } = await import('../db/schema/businesses.js');
    const existing = await db.select().from(businesses).limit(1);
    if (existing.length > 0) {
      businessId = existing[0].id;
    } else {
      const [b] = await db.insert(businesses).values({
        name: 'Recurring Test Co',
        slug: `recurring-test-${Date.now()}`,
      }).returning();
      businessId = b.id;
    }
  });

  it('clones a due recurring task and advances the parent next_run', async () => {
    // Seed a parent due 1 hour ago, daily at any time the test runs.
    const due = new Date(Date.now() - 60 * 60 * 1000);
    const [parent] = await db
      .insert(tasks)
      .values({
        businessId,
        title: `Recurring parent ${Date.now()}`,
        description: 'every day daily report',
        assignee: 'Bot',
        priority: 'medium',
        status: 'todo',
        category: 'general',
        createdBy: 'system@stato.local',
        dueDate: due,
        recurrenceCron: '0 9 * * *',   // daily 09:00 — always a valid next-fire
        recurrenceNextRun: due,
      })
      .returning();
    parentId = parent.id;

    const result = await processRecurringTasks(new Date());
    expect(result.fired).toBeGreaterThanOrEqual(1);
    expect(result.invalid).toBe(0);

    // A clone should now exist with parentTaskId pointing at us.
    const clones = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentId));
    expect(clones.length).toBeGreaterThanOrEqual(1);
    const clone = clones[0];
    expect(clone.title).toBe(parent.title);
    expect(clone.status).toBe('todo');
    // Clones don't themselves recur.
    expect(clone.recurrenceCron).toBeNull();
    expect(clone.recurrenceNextRun).toBeNull();

    // Parent's next_run should now be in the future.
    const [refreshed] = await db.select().from(tasks).where(eq(tasks.id, parentId));
    expect(refreshed.recurrenceNextRun).not.toBeNull();
    expect(refreshed.recurrenceNextRun!.getTime() > Date.now()).toBe(true);
  });

  it('clears next_run for invalid cron so we stop retrying it forever', async () => {
    const due = new Date(Date.now() - 60 * 60 * 1000);
    const [bad] = await db
      .insert(tasks)
      .values({
        businessId,
        title: `Bad cron task ${Date.now()}`,
        priority: 'low',
        status: 'todo',
        category: 'general',
        createdBy: 'system@stato.local',
        dueDate: due,
        recurrenceCron: 'not a valid expression',
        recurrenceNextRun: due,
      })
      .returning();

    const result = await processRecurringTasks(new Date());
    expect(result.invalid).toBeGreaterThanOrEqual(1);

    const [refreshed] = await db.select().from(tasks).where(eq(tasks.id, bad.id));
    expect(refreshed.recurrenceNextRun).toBeNull();
  });

  it('skips tasks whose next_run is still in the future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const [parent] = await db
      .insert(tasks)
      .values({
        businessId,
        title: `Future recurring ${Date.now()}`,
        priority: 'medium',
        status: 'todo',
        category: 'general',
        createdBy: 'system@stato.local',
        dueDate: future,
        recurrenceCron: '0 9 * * *',
        recurrenceNextRun: future,
      })
      .returning();

    const before = await processRecurringTasks(new Date());
    // No clone should be created for this row — count clones pointing at it.
    const clones = await db.select().from(tasks).where(eq(tasks.parentTaskId, parent.id));
    expect(clones.length).toBe(0);
    expect(before).toBeTruthy();
  });
});
