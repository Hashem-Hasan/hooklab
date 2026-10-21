import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import {
  scenarios,
  validateEvent,
  type ScenarioId,
  type PaymentEvent,
  type Assertion,
} from './domain.js';

export function sign(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}
export function verify(
  body: string,
  signature: string | undefined,
  secret: string,
) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signature.slice(7), 'hex'),
    Buffer.from(sign(body, secret), 'hex'),
  );
}
async function body(req: IncomingMessage) {
  let result = '';
  for await (const chunk of req) {
    result += chunk;
    if (Buffer.byteLength(result) > 65536)
      throw new Error('Payload exceeds 64 KB.');
  }
  return result;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res
    .writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(JSON.stringify(value));
}
export function createApp(
  options: {
    filename?: string;
    secret?: string;
    allowedOrigins?: string[];
    timeoutMs?: number;
    worker?: boolean;
  } = {},
) {
  const store = new Store(options.filename ?? '.data/hooklab.sqlite');
  const secret = options.secret ?? randomBytes(32).toString('hex');
  let busy = false;
  let scenarioBusy = false;
  const receiverCalls = new Map<string, number>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin());
      if (req.headers.host !== new URL(origin()).host) {
        json(res, 403, {
          error: 'Unexpected Host. Use the loopback server URL.',
        });
        return;
      }
      if (
        req.method === 'POST' &&
        req.headers.origin &&
        req.headers.origin !== origin()
      ) {
        json(res, 403, { error: 'Cross-origin mutations are not allowed.' });
        return;
      }
      if (
        [
          '/receiver',
          '/receiver/flaky',
          '/receiver/slow',
          '/receiver/always-fail',
        ].includes(url.pathname) &&
        req.method === 'POST'
      ) {
        const raw = await body(req);
        if (
          !verify(
            raw,
            req.headers['x-hooklab-signature'] as string | undefined,
            secret,
          )
        ) {
          json(res, 401, { error: 'Invalid signature.' });
          return;
        }
        const value: PaymentEvent = JSON.parse(raw);
        validateEvent(value);
        const calls = (receiverCalls.get(value.id) ?? 0) + 1;
        receiverCalls.set(value.id, calls);
        if (
          url.pathname === '/receiver/always-fail' ||
          (url.pathname === '/receiver/flaky' && calls === 1)
        ) {
          json(res, 503, { error: 'Synthetic downstream outage.' });
          return;
        }
        const result = store.consume(value);
        if (url.pathname === '/receiver/slow' && calls === 1)
          await new Promise((resolve) =>
            setTimeout(resolve, (options.timeoutMs ?? 800) + 150),
          );
        json(res, 200, result);
        return;
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        json(res, 200, { mode: 'server', ...store.snapshot() });
        return;
      }
      if (url.pathname === '/api/events' && req.method === 'POST') {
        const value = JSON.parse(await body(req));
        validateTarget(value.target);
        validateEvent(value.payload);
        json(res, 201, { id: store.add(value.payload, value.target) });
        return;
      }
      if (url.pathname === '/api/scenarios' && req.method === 'POST') {
        const value = JSON.parse(await body(req));
        if (!scenarios.some((item) => item.id === value.scenario))
          throw new Error('Unknown scenario.');
        if (scenarioBusy) {
          json(res, 409, { error: 'A scenario is already running.' });
          return;
        }
        scenarioBusy = true;
        try {
          json(res, 200, await runScenario(value.scenario));
        } finally {
          scenarioBusy = false;
        }
        return;
      }
      const retry = url.pathname.match(/^\/api\/events\/([\w-]+)\/retry$/);
      if (retry && req.method === 'POST') {
        json(res, store.retry(retry[1]) ? 200 : 409, {
          snapshot: store.snapshot(),
        });
        return;
      }
      if (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/receiver')
      ) {
        json(res, 404, { error: 'Unknown route.' });
        return;
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'Method not allowed.' });
        return;
      }
      let packageRoot = path.dirname(fileURLToPath(import.meta.url));
      while (
        !existsSync(path.join(packageRoot, 'package.json')) &&
        path.dirname(packageRoot) !== packageRoot
      )
        packageRoot = path.dirname(packageRoot);
      const root = path.join(packageRoot, 'dist');
      const file = path.resolve(
        root,
        '.' +
          decodeURIComponent(
            url.pathname === '/' ? '/index.html' : url.pathname,
          ),
      );
      if (!file.startsWith(root + path.sep)) {
        json(res, 403, { error: 'Invalid path.' });
        return;
      }
      try {
        const data = await readFile(file);
        const ext = path.extname(file);
        res
          .writeHead(200, {
            'Content-Type':
              (
                {
                  '.html': 'text/html; charset=utf-8',
                  '.js': 'text/javascript',
                  '.css': 'text/css',
                  '.svg': 'image/svg+xml',
                  '.png': 'image/png',
                } as Record<string, string>
              )[ext] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
          })
          .end(data);
      } catch {
        json(res, 404, {
          error: 'Asset unavailable. Run npm run build first.',
        });
      }
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : 'Invalid request.',
      });
    }
  });
  function origin() {
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 4202}`;
  }
  function validateTarget(value: unknown) {
    if (typeof value !== 'string') throw new Error('A target URL is required.');
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(
        'Use an HTTP(S) target without credentials, query parameters or fragments.',
      );
    if (![origin(), ...(options.allowedOrigins ?? [])].includes(url.origin))
      throw new Error(
        'Target origin is not allowed. Configure HOOKLAB_ALLOWED_ORIGINS explicitly.',
      );
  }
  async function tick() {
    if (busy) return;
    const event = store.due();
    if (!event) return;
    busy = true;
    try {
      if (!store.claim(event.id)) return;
      const started = performance.now();
      try {
        validateTarget(event.target);
        const response = await fetch(event.target, {
          method: 'POST',
          body: event.payload,
          headers: {
            'Content-Type': 'application/json',
            'X-Hooklab-Signature': 'sha256=' + sign(event.payload, secret),
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 800),
        });
        // Consume/cancel without storing response bodies or headers, which may contain secrets.
        await response.body?.cancel();
        store.complete(
          event.id,
          response.status,
          response.ok ? null : `HTTP ${response.status}`,
          performance.now() - started,
        );
      } catch (error) {
        store.complete(
          event.id,
          null,
          error instanceof Error
            ? error.name + ': ' + error.message
            : 'Delivery failed',
          performance.now() - started,
        );
      }
    } finally {
      busy = false;
    }
  }
  async function runScenario(scenario: ScenarioId) {
    const runId = store.startRun(scenario);
    const paymentId = runId;
    const payload: PaymentEvent = {
      id: runId + '.paid',
      type: 'payment.paid',
      data: { paymentId, amount: 1850, version: 1 },
    };
    const ids: string[] = [];
    const add = (event: PaymentEvent, route = '/receiver') => {
      const id = store.add(event, origin() + route, runId);
      ids.push(id);
      return id;
    };
    if (scenario === 'duplicates') for (let i = 0; i < 10; i++) add(payload);
    else if (scenario === 'out-of-order') {
      add({
        ...payload,
        id: runId + '.cancelled',
        type: 'payment.cancelled',
        data: { ...payload.data, version: 2 },
      });
      add(payload);
    } else if (scenario === 'restart') {
      const id = add(payload);
      store.claim(id);
      store.recover();
    } else
      add(
        payload,
        scenario === 'retry'
          ? '/receiver/flaky'
          : scenario === 'timeout'
            ? '/receiver/slow'
            : '/receiver/always-fail',
      );
    const deadline = Date.now() + 30000;
    while (
      ids.some((id) => ['queued', 'processing'].includes(store.get(id)!.state))
    ) {
      if (Date.now() > deadline)
        throw new Error('Scenario exceeded 30 seconds. Inspect the queue.');
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const snapshot = store.snapshot();
    const events = ids.map((id) => store.get(id)!);
    const order = snapshot.orders.find((item) => item.paymentId === paymentId);
    const assertions: Assertion[] = [];
    const check = (name: string, passed: boolean, actual: string) =>
      assertions.push({ name, passed, actual });
    if (scenario === 'dead-letter') {
      check(
        'Retry limit stops delivery',
        events[0].state === 'dead' && events[0].attempts === 3,
        `${events[0].attempts} attempts · ${events[0].state}`,
      );
      check('No order created', !order, order ? '1 order' : '0 orders');
    } else {
      check(
        'All deliveries reach a terminal success',
        events.every((item) => item.state === 'delivered'),
        `${events.filter((item) => item.state === 'delivered').length}/${events.length} delivered`,
      );
      check('One order per payment', !!order, order ? '1 order' : '0 orders');
      if (scenario === 'out-of-order')
        check(
          'Newest version wins',
          order?.version === 2 && order.status === 'cancelled',
          `version ${order?.version} · ${order?.status}`,
        );
      if (scenario === 'duplicates')
        check(
          'Consumer deduplicates provider event IDs',
          Number(
            store.db
              .prepare(
                'SELECT COUNT(*) AS count FROM inbox WHERE provider_id=?',
              )
              .get(payload.id)!.count,
          ) === 1,
          '1 inbox receipt',
        );
      if (
        scenario === 'retry' ||
        scenario === 'timeout' ||
        scenario === 'restart'
      )
        check(
          'Recovery required another attempt',
          events[0].attempts >= 2,
          `${events[0].attempts} attempts`,
        );
    }
    store.finishRun(runId, assertions);
    return { runId, assertions, snapshot: store.snapshot() };
  }
  const timer =
    options.worker === false
      ? undefined
      : setInterval(() => void tick().catch(console.error), 100);
  return {
    server,
    store,
    origin,
    tick,
    runScenario,
    secret,
    close: async () => {
      if (timer) clearInterval(timer);
      while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
