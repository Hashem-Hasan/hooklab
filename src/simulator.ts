import {
  reducePayment,
  type ScenarioId,
  type Snapshot,
  type PaymentEvent,
  type EventRow,
  type Assertion,
} from './domain.js';
/** Browser-only teaching adapter. No HTTP requests or durability claims. */
export async function simulate(
  scenario: ScenarioId,
  previous: Snapshot,
  notify: (snapshot: Snapshot) => void,
): Promise<Snapshot> {
  const state = structuredClone(previous);
  const runId = crypto.randomUUID();
  const base: PaymentEvent = {
    id: runId + '.paid',
    type: 'payment.paid',
    data: { paymentId: runId, amount: 1850, version: 1 },
  };
  const payloads =
    scenario === 'duplicates'
      ? Array.from({ length: 10 }, () => base)
      : scenario === 'out-of-order'
        ? [
            {
              ...base,
              id: runId + '.cancelled',
              type: 'payment.cancelled' as const,
              data: { ...base.data, version: 2 },
            },
            base,
          ]
        : [base];
  const seen = new Set<string>();
  for (const payload of payloads) {
    const id = crypto.randomUUID();
    const event: EventRow = {
      id,
      provider_id: payload.id,
      target: 'simulation://sample-consumer',
      payload: JSON.stringify(payload),
      state: 'queued',
      attempts: 0,
      next_at: 0,
      created_at: new Date().toISOString(),
      run_id: runId,
    };
    state.events.unshift(event);
    notify(structuredClone(state));
    const count =
      scenario === 'dead-letter'
        ? 3
        : ['retry', 'timeout', 'restart'].includes(scenario)
          ? 2
          : 1;
    for (let i = 1; i <= count; i++) {
      event.state = 'processing';
      event.attempts = i;
      notify(structuredClone(state));
      await new Promise((resolve) => setTimeout(resolve, 90));
      const failed =
        scenario === 'dead-letter' ||
        (i === 1 && ['retry', 'timeout', 'restart'].includes(scenario));
      state.attempts.unshift({
        id: state.attempts.length + 1,
        event_id: id,
        number: i,
        status: failed
          ? scenario === 'timeout' || scenario === 'restart'
            ? null
            : 503
          : 200,
        error: failed ? 'Simulated failure' : null,
        latency_ms: 0,
        created_at: new Date().toISOString(),
      });
      if (
        scenario !== 'dead-letter' &&
        (!failed || scenario === 'timeout') &&
        !seen.has(payload.id)
      ) {
        const index = state.orders.findIndex(
          (order) => order.paymentId === payload.data.paymentId,
        );
        const result = reducePayment(
          index >= 0 ? state.orders[index] : undefined,
          payload,
        );
        if (index < 0) state.orders.unshift(result.order);
        else state.orders[index] = result.order;
        seen.add(payload.id);
      }
      event.state = failed ? (i === count ? 'dead' : 'queued') : 'delivered';
      notify(structuredClone(state));
    }
  }
  const events = state.events.filter((event) => event.run_id === runId);
  const orders = state.orders.filter((order) => order.paymentId === runId);
  const assertions: Assertion[] =
    scenario === 'dead-letter'
      ? [
          {
            name: 'Retry limit stops delivery',
            passed: events[0].state === 'dead' && events[0].attempts === 3,
            actual: `${events[0].attempts} attempts · ${events[0].state}`,
          },
          {
            name: 'No order created',
            passed: orders.length === 0,
            actual: `${orders.length} orders`,
          },
        ]
      : [
          {
            name: 'All deliveries reach a terminal success',
            passed: events.every((e) => e.state === 'delivered'),
            actual: `${events.length} delivered`,
          },
          {
            name: 'One order per payment',
            passed: orders.length === 1,
            actual: `${orders.length} order`,
          },
        ];
  if (scenario === 'out-of-order')
    assertions.push({
      name: 'Newest version wins',
      passed: orders[0]?.version === 2 && orders[0]?.status === 'cancelled',
      actual: `version ${orders[0]?.version} · ${orders[0]?.status}`,
    });
  state.runs.unshift({
    id: runId,
    scenario,
    created_at: new Date().toISOString(),
    assertions,
  });
  notify(structuredClone(state));
  return state;
}
