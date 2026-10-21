import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, sign, verify } from '../src/server.js';
import { Store } from '../src/store.js';
import { scenarios, redact, type PaymentEvent } from '../src/domain.js';

const payment: PaymentEvent = {
  id: 'event-1',
  type: 'payment.paid',
  data: { paymentId: 'payment-1', amount: 1850, version: 1 },
};
async function listen(app: ReturnType<typeof createApp>, port = 0) {
  await new Promise<void>((resolve) =>
    app.server.listen(port, '127.0.0.1', resolve),
  );
  return app.origin();
}

test('all six failure scenarios use actual HTTP and produce passing assertions', async () => {
  const app = createApp({
    filename: ':memory:',
    secret: 'synthetic-test-secret',
    worker: false,
    timeoutMs: 150,
  });
  await listen(app);
  try {
    for (const scenario of scenarios) {
      const result = await app.runScenario(scenario.id);
      assert.ok(result.assertions.length >= 2);
      assert.ok(
        result.assertions.every((a) => a.passed),
        JSON.stringify(result.assertions),
      );
    }
    assert.equal(app.store.snapshot().orders.length, 5);
    const duplicateRun = app.store
      .snapshot()
      .runs.find((run) => run.scenario === 'duplicates')!;
    assert.equal(
      app.store
        .snapshot()
        .events.filter((event) => event.run_id === duplicateRun.id).length,
      10,
    );
    assert.ok(
      app.store.snapshot().attempts.some((attempt) => attempt.status === 503),
    );
    assert.ok(
      app.store
        .snapshot()
        .attempts.some(
          (attempt) =>
            attempt.status === null && attempt.error?.includes('Timeout'),
        ),
    );
  } finally {
    await app.close();
  }
});
test('signed receiver rejects forged payloads and conflicting idempotency keys', async () => {
  const app = createApp({
    filename: ':memory:',
    secret: 'secret',
    worker: false,
  });
  const origin = await listen(app);
  try {
    const raw = JSON.stringify(payment);
    assert.equal(verify(raw, 'sha256=' + sign(raw, 'secret'), 'secret'), true);
    assert.equal(verify(raw, 'sha256=' + sign(raw, 'wrong'), 'secret'), false);
    assert.equal(
      (await fetch(origin + '/receiver', { method: 'POST', body: raw })).status,
      401,
    );
    const send = async (event: PaymentEvent) => {
      const body = JSON.stringify(event);
      return fetch(origin + '/receiver', {
        method: 'POST',
        body,
        headers: { 'X-Hooklab-Signature': 'sha256=' + sign(body, 'secret') },
      });
    };
    assert.equal((await send(payment)).status, 200);
    assert.equal((await (await send(payment)).json()).duplicate, true);
    assert.equal(
      (await send({ ...payment, data: { ...payment.data, amount: 999 } }))
        .status,
      400,
    );
    assert.equal(app.store.snapshot().orders[0].amount, 1850);
  } finally {
    await app.close();
  }
});
test('queue survives a real close and reopen after receiver commits but delivery acknowledgement is lost', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hooklab-restart-'));
  const filename = path.join(directory, 'queue.sqlite');
  let app = createApp({ filename, worker: false });
  const origin = await listen(app);
  const port = Number(new URL(origin).port);
  try {
    const id = app.store.add(payment, origin + '/receiver');
    app.store.claim(id);
    app.store.consume(payment);
    await app.close();
    app = createApp({ filename, worker: false });
    await listen(app, port);
    assert.equal(app.store.get(id)?.state, 'queued');
    await app.tick();
    assert.equal(app.store.get(id)?.state, 'delivered');
    assert.equal(app.store.snapshot().orders.length, 1);
    assert.equal(app.store.get(id)?.attempts, 2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('HTTP API restricts targets, request size and cross-origin mutation', async () => {
  const app = createApp({ filename: ':memory:', worker: false });
  const origin = await listen(app);
  try {
    const post = (value: unknown, headers: Record<string, string> = {}) =>
      fetch(origin + '/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(value),
      });
    for (const target of [
      'http://example.com/receiver',
      origin + '/receiver?token=secret',
      'file:///private',
    ])
      assert.equal((await post({ payload: payment, target })).status, 400);
    assert.equal(
      (
        await post(
          { payload: payment, target: origin + '/receiver' },
          { Origin: 'https://untrusted.example' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post({
          payload: { ...payment, extra: 'x'.repeat(70000) },
          target: origin + '/receiver',
        })
      ).status,
      400,
    );
    assert.equal(
      (await post({ payload: payment, target: origin + '/receiver' })).status,
      201,
    );
  } finally {
    await app.close();
  }
});
test('dead-letter requeue preserves history and only requeues terminal failures', () => {
  const store = new Store(':memory:');
  try {
    const id = store.add(payment, 'http://127.0.0.1:4202/receiver');
    assert.equal(store.retry(id), false);
    store.claim(id);
    store.complete(id, 401, 'HTTP 401', 1);
    assert.equal(store.get(id)?.state, 'dead');
    assert.equal(store.retry(id), true);
    assert.equal(store.get(id)?.state, 'queued');
    assert.equal(store.snapshot().attempts.length, 1);
  } finally {
    store.close();
  }
});
test('snapshot redacts secret fields without modifying delivery payloads', () => {
  const store = new Store(':memory:');
  try {
    const value = {
      ...payment,
      secret: 'DO_NOT_EXPOSE',
      nested: { apiKey: 'private', name: 'visible' },
    };
    const id = store.add(value, 'http://127.0.0.1:4202/receiver');
    assert.ok(store.get(id)!.payload.includes('DO_NOT_EXPOSE'));
    assert.ok(!store.snapshot().events[0].payload.includes('DO_NOT_EXPOSE'));
    assert.deepEqual(redact({ token: 'x', nested: { password: 'y' } }), {
      token: '[REDACTED]',
      nested: { password: '[REDACTED]' },
    });
  } finally {
    store.close();
  }
});
