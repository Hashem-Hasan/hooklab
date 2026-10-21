#!/usr/bin/env node
import { createApp } from '../src/server.js';
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const command = args.shift() ?? 'start';
const options: Record<string, string> = {};
try {
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1])
      throw new Error('Options require values.');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (command === 'start') {
    const port = Number(options.port ?? 4202);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid port.');
    const app = createApp({
      filename: options.db ?? '.data/hooklab.sqlite',
      secret: process.env.HOOKLAB_SECRET,
      allowedOrigins: (process.env.HOOKLAB_ALLOWED_ORIGINS ?? '')
        .split(',')
        .filter(Boolean),
    });
    app.server.listen(port, '127.0.0.1', () =>
      console.log(
        `HookLab ready at ${app.origin()} · SQLite history persists in ${options.db ?? '.data/hooklab.sqlite'}`,
      ),
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        void app.close().then(() => process.exit(0));
      });
  } else {
    const base = options.server ?? 'http://127.0.0.1:4202';
    const endpoint =
      command === 'status'
        ? '/api/status'
        : command === 'scenario'
          ? '/api/scenarios'
          : command === 'enqueue'
            ? '/api/events'
            : null;
    if (!endpoint)
      throw new Error(
        'Use start, status, scenario --name duplicates, or enqueue --file event.json --target http://127.0.0.1:4202/receiver.',
      );
    const payload =
      command === 'scenario'
        ? { scenario: options.name }
        : command === 'enqueue'
          ? {
              payload: JSON.parse(await readFile(options.file, 'utf8')),
              target: options.target,
            }
          : undefined;
    const response = await fetch(base + endpoint, {
      method: payload ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (
      !response.ok ||
      result.assertions?.some((item: { passed: boolean }) => !item.passed)
    )
      process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 2;
}
