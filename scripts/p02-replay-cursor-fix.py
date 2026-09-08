from pathlib import Path

store = Path("packages/storage/src/sqlite-event-store.ts")
source = store.read_text()
old = '''  async *replay(fromSequence?: number, toSequence?: number): AsyncIterable<PersistedDomainEvent<string, unknown>> {
    const start = fromSequence === undefined ? 1 : fromSequence + 1;
    const end = toSequence === undefined ? Number.MAX_SAFE_INTEGER : toSequence;
    for (const row of this.db.prepare(
      "SELECT * FROM events WHERE sequence >= ? AND sequence <= ? ORDER BY sequence",
    ).iterate(start, end) as Iterable<EventRow>) {
      yield verifyEventRow(row, this.workspaceId);
    }
  }
'''
new = '''  async *replay(fromSequence?: number, toSequence?: number): AsyncIterable<PersistedDomainEvent<string, unknown>> {
    // Never suspend an async generator while a better-sqlite3 iterator is live.
    // A suspended SQLite iterator marks the shared connection busy, which can
    // make an unrelated Host transaction fail while replay consumers yield to
    // other protocol work. Materialize bounded batches and freeze the replay
    // head at iterator start so no SQLite statement remains active across a
    // JavaScript async suspension and replay retains snapshot semantics.
    const startAfter = fromSequence ?? 0;
    const headRow = this.db.prepare(
      "SELECT MAX(sequence) as max_seq FROM events",
    ).get() as { max_seq: number | null } | undefined;
    const snapshotHead = headRow?.max_seq ?? 0;
    const end = Math.min(toSequence ?? snapshotHead, snapshotHead);
    if (startAfter >= end) return;

    const statement = this.db.prepare(
      "SELECT * FROM events WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?",
    );
    const batchSize = 1000;
    let cursor = startAfter;
    while (cursor < end) {
      const rows = statement.all(cursor, end, batchSize) as EventRow[];
      if (rows.length === 0) return;
      for (const row of rows) {
        const event = verifyEventRow(row, this.workspaceId);
        cursor = row.sequence;
        yield event;
      }
    }
  }
'''
if old not in source:
    raise SystemExit("sqlite event replay anchor not found")
store.write_text(source.replace(old, new, 1))

test = Path("packages/storage/src/sqlite-event-store.test.ts")
source = test.read_text()
anchor = '''  it("replay honors fromSequence and toSequence", async () => {
    await store.append([makeDraft(), makeDraft(), makeDraft(), makeDraft()]);
    const seqs: number[] = [];
    for await (const e of store.replay(1, 3)) seqs.push(e.sequence);
    expect(seqs).toEqual([2, 3]);
  });
'''
addition = anchor + '''
  it("replay releases SQLite query ownership before each async yield", async () => {
    await store.append([makeDraft(), makeDraft()]);
    const iterator = store.replay()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error("Expected replay to yield the first persisted event");
    expect(first.value.sequence).toBe(1);

    // The replay iterator is suspended here. Canonical writes on the same
    // Host connection must remain legal, and the in-flight replay must retain
    // its original head rather than absorbing later appends.
    const [appended] = await store.append([makeDraft()]);
    expect(appended.sequence).toBe(3);

    const remaining: number[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value.sequence);
    }
    expect(remaining).toEqual([2]);
  });
'''
if anchor not in source:
    raise SystemExit("sqlite replay regression anchor not found")
test.write_text(source.replace(anchor, addition, 1))
