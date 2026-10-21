export interface PaymentEvent {
  id: string;
  type: 'payment.paid' | 'payment.cancelled';
  data: { paymentId: string; amount: number; version: number };
}
export interface Order {
  paymentId: string;
  amount: number;
  version: number;
  status: 'paid' | 'cancelled';
}
export function validateEvent(value: unknown): asserts value is PaymentEvent {
  const e = value as PaymentEvent;
  if (
    !e ||
    typeof e.id !== 'string' ||
    !/^[\w.-]{1,120}$/.test(e.id) ||
    !['payment.paid', 'payment.cancelled'].includes(e.type) ||
    !e.data ||
    typeof e.data.paymentId !== 'string' ||
    !/^[\w.-]{1,120}$/.test(e.data.paymentId) ||
    !Number.isSafeInteger(e.data.amount) ||
    e.data.amount < 0 ||
    !Number.isSafeInteger(e.data.version) ||
    e.data.version < 1
  )
    throw new Error(
      'Expected a payment event with safe IDs, integer amount in cents and positive integer version.',
    );
}
export function reducePayment(
  current: Order | undefined,
  event: PaymentEvent,
): { order: Order; applied: boolean } {
  if (current && current.version >= event.data.version)
    return { order: current, applied: false };
  return {
    order: {
      paymentId: event.data.paymentId,
      amount: event.data.amount,
      version: event.data.version,
      status: event.type === 'payment.paid' ? 'paid' : 'cancelled',
    },
    applied: true,
  };
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /secret|token|password|authorization|api.?key/i.test(key)
          ? '[REDACTED]'
          : redact(item),
      ]),
    );
  return value;
}
export const scenarios = [
  {
    id: 'duplicates',
    name: 'Duplicate storm',
    description: 'Deliver the same payment 10 times. Create one order.',
    tag: 'IDEMPOTENCY',
  },
  {
    id: 'out-of-order',
    name: 'Out of order',
    description:
      'Deliver version 2 before version 1. Preserve the latest state.',
    tag: 'ORDERING',
  },
  {
    id: 'timeout',
    name: 'Lost response',
    description: 'Process a payment, then lose the response. Retry safely.',
    tag: 'AMBIGUITY',
  },
  {
    id: 'retry',
    name: 'Temporary outage',
    description: 'Return 503 once, then recover with exponential backoff.',
    tag: 'RECOVERY',
  },
  {
    id: 'dead-letter',
    name: 'Exhausted retries',
    description: 'Keep failing. Stop after 3 attempts with evidence.',
    tag: 'DEAD LETTER',
  },
  {
    id: 'restart',
    name: 'Worker interruption',
    description: 'Recover a claimed event after an interrupted worker.',
    tag: 'DURABILITY',
  },
] as const;
export type ScenarioId = (typeof scenarios)[number]['id'];
export interface Assertion {
  name: string;
  passed: boolean;
  actual: string;
}
export interface EventRow {
  id: string;
  provider_id: string;
  target: string;
  payload: string;
  state: string;
  attempts: number;
  next_at: number;
  created_at: string;
  run_id: string;
}
export interface Attempt {
  id: number;
  event_id: string;
  number: number;
  status: number | null;
  error: string | null;
  latency_ms: number;
  created_at: string;
}
export interface Run {
  id: string;
  scenario: ScenarioId;
  created_at: string;
  assertions: Assertion[];
}
export interface Snapshot {
  events: EventRow[];
  attempts: Attempt[];
  orders: Order[];
  runs: Run[];
}
