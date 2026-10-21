import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  reducePayment,
  validateEvent,
  redact,
  type EventRow,
  type Order,
  type PaymentEvent,
  type Run,
  type Snapshot,
  type Assertion,
  type ScenarioId,
} from './domain.js';

export class Store {
  db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:')
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,event_id TEXT NOT NULL,number INTEGER NOT NULL,status INTEGER,error TEXT,latency_ms INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(provider_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(payment_id TEXT PRIMARY KEY,amount INTEGER NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,scenario TEXT NOT NULL,created_at TEXT NOT NULL,assertions TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS queue_due ON events(state,next_at);`);
    this.recover();
  }
  recover() {
    return this.db
      .prepare("UPDATE events SET state='queued' WHERE state='processing'")
      .run().changes;
  }
  add(payload: PaymentEvent, target: string, runId = 'manual') {
    validateEvent(payload);
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO events(id,provider_id,target,payload,created_at,run_id) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        payload.id,
        target,
        JSON.stringify(payload),
        new Date().toISOString(),
        runId,
      );
    return id;
  }
  get(id: string) {
    return this.db
      .prepare('SELECT * FROM events WHERE id=?')
      .get(id) as unknown as EventRow | undefined;
  }
  due() {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE state='queued' AND next_at<=? ORDER BY rowid LIMIT 1",
      )
      .get(Date.now()) as unknown as EventRow | undefined;
  }
  claim(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE events SET state='processing', attempts=attempts+1 WHERE id=? AND state='queued'",
        )
        .run(id).changes === 1
    );
  }
  complete(
    id: string,
    status: number | null,
    error: string | null,
    latency: number,
    maxAttempts = 3,
  ) {
    const event = this.get(id)!;
    const succeeded = status !== null && status >= 200 && status < 300;
    const terminal =
      !succeeded &&
      (event.attempts >= maxAttempts ||
        (status !== null &&
          status >= 400 &&
          status < 500 &&
          ![408, 429].includes(status)));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO attempts(event_id,number,status,error,latency_ms,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          id,
          event.attempts,
          status,
          error?.slice(0, 300) ?? null,
          Math.round(latency),
          new Date().toISOString(),
        );
      this.db
        .prepare('UPDATE events SET state=?,next_at=? WHERE id=?')
        .run(
          succeeded ? 'delivered' : terminal ? 'dead' : 'queued',
          Date.now() + 100 * 2 ** Math.min(event.attempts - 1, 6),
          id,
        );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  retry(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE events SET state='queued',next_at=0,attempts=0 WHERE id=? AND state='dead'",
        )
        .run(id).changes === 1
    );
  }
  consume(value: unknown) {
    validateEvent(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const canonical = JSON.stringify({
        id: value.id,
        type: value.type,
        data: {
          paymentId: value.data.paymentId,
          amount: value.data.amount,
          version: value.data.version,
        },
      });
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO inbox(provider_id,payload,created_at) VALUES(?,?,?)',
        )
        .run(value.id, canonical, new Date().toISOString());
      if (!inserted.changes) {
        if (
          this.db
            .prepare('SELECT payload FROM inbox WHERE provider_id=?')
            .get(value.id)!.payload !== canonical
        )
          throw new Error('Provider event ID reused with a different payload.');
        this.db.exec('COMMIT');
        return { duplicate: true, applied: false };
      }
      const row = this.db
        .prepare(
          'SELECT payment_id AS paymentId,amount,version,status FROM orders WHERE payment_id=?',
        )
        .get(value.data.paymentId) as unknown as Order | undefined;
      const result = reducePayment(row, value);
      if (result.applied)
        this.db
          .prepare(
            'INSERT INTO orders(payment_id,amount,version,status) VALUES(?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET amount=excluded.amount,version=excluded.version,status=excluded.status',
          )
          .run(
            result.order.paymentId,
            result.order.amount,
            result.order.version,
            result.order.status,
          );
      this.db.exec('COMMIT');
      return { duplicate: false, applied: result.applied };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  startRun(scenario: ScenarioId) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO runs(id,scenario,created_at) VALUES(?,?,?)')
      .run(id, scenario, new Date().toISOString());
    return id;
  }
  finishRun(id: string, assertions: Assertion[]) {
    this.db
      .prepare('UPDATE runs SET assertions=? WHERE id=?')
      .run(JSON.stringify(assertions), id);
  }
  snapshot(): Snapshot {
    return {
      events: (
        this.db
          .prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT 500')
          .all() as unknown as EventRow[]
      ).map((e) => ({
        ...e,
        payload: JSON.stringify(redact(JSON.parse(e.payload))),
      })),
      attempts: this.db
        .prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT 2000')
        .all() as unknown as Snapshot['attempts'],
      orders: this.db
        .prepare(
          'SELECT payment_id AS paymentId,amount,version,status FROM orders ORDER BY rowid DESC LIMIT 500',
        )
        .all() as unknown as Order[],
      runs: this.db
        .prepare('SELECT * FROM runs ORDER BY rowid DESC LIMIT 100')
        .all()
        .map((r) => ({
          ...r,
          assertions: JSON.parse(String(r.assertions)),
        })) as unknown as Run[],
    };
  }
  close() {
    this.db.close();
  }
}
