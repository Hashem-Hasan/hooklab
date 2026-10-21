import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  Github,
  Layers3,
  Play,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react';
import { scenarios, type ScenarioId, type Snapshot } from './domain.js';
import { simulate } from './simulator.js';
import './style.css';
const empty: Snapshot = { events: [], attempts: [], orders: [], runs: [] };
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [mode, setMode] = useState<
    'loading' | 'server' | 'simulation' | 'offline'
  >('loading');
  const [selected, setSelected] = useState<ScenarioId>('duplicates');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [eventId, setEventId] = useState('');
  const [filter, setFilter] = useState('all');
  const staticHost =
    location.hostname === 'hashem-hasan.github.io' ||
    new URLSearchParams(location.search).has('simulation');
  async function refresh() {
    if (staticHost) {
      setMode('simulation');
      return;
    }
    try {
      const response = await fetch('/api/status');
      if (!response.ok)
        throw new Error(
          'Local API unavailable. Run npm start, or open ?simulation=1 for the browser simulation.',
        );
      const value = await response.json();
      if (value.mode !== 'server')
        throw new Error('The server response is invalid.');
      setMode('server');
      setSnapshot(value);
      setError('');
    } catch (e) {
      setMode('offline');
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function run() {
    setError('');
    setRunning(true);
    try {
      if (mode === 'simulation') {
        const value = await simulate(selected, snapshot, setSnapshot);
        setSnapshot(value);
        setEventId(value.events[0]?.id ?? '');
      } else {
        const response = await fetch('/api/scenarios', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: selected }),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? 'Scenario failed.');
        setSnapshot(value.snapshot);
        setEventId(value.snapshot.events[0]?.id ?? '');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }
  async function retry(id: string) {
    setError('');
    try {
      const response = await fetch(`/api/events/${id}/retry`, {
        method: 'POST',
      });
      if (!response.ok)
        throw new Error('Only dead-letter events can be retried.');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ mode, ...snapshot }, null, 2)], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hooklab-evidence.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  const event =
    snapshot.events.find((item) => item.id === eventId) ?? snapshot.events[0];
  const attempts = event
    ? snapshot.attempts
        .filter((item) => item.event_id === event.id)
        .sort((a, b) => a.number - b.number)
    : [];
  const latest = snapshot.runs[0];
  const totalAttempts = snapshot.attempts.length;
  const delivered = snapshot.events.filter(
    (item) => item.state === 'delivered',
  ).length;
  const dead = snapshot.events.filter((item) => item.state === 'dead').length;
  return (
    <>
      <a className="skip" href="#workbench">
        Skip to workbench
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <a href="#" className="brand">
            <span>
              <Activity size={23} />
            </span>
            hooklab<span className="v">0.1</span>
          </a>
          <div className="workspace-name">
            <span className="avatar">H</span>
            <div>
              Local workspace<small>Hashem's open-source lab</small>
            </div>
          </div>
          <div className="side-caption">WORKSPACE</div>
          <a href="#workbench" className="side-link active">
            <Layers3 size={17} />
            Failure workbench
          </a>
          <a href="#history" className="side-link">
            <Clock3 size={17} />
            Run history<span>{snapshot.runs.length}</span>
          </a>
          <a href="#consumer" className="side-link">
            <Database size={17} />
            Sample consumer
          </a>
          <div className="side-caption">DEVELOPER RESOURCES</div>
          <a
            href="https://github.com/Hashem-Hasan/hooklab#quick-start"
            className="side-link"
          >
            <Terminal size={17} />
            CLI quick start
          </a>
          <a
            href="https://github.com/Hashem-Hasan/hooklab/blob/main/docs/architecture.md"
            className="side-link"
          >
            <Code2 size={17} />
            Architecture
          </a>
          <a
            href="https://github.com/Hashem-Hasan/hooklab"
            className="side-link"
          >
            <Github size={17} />
            Source on GitHub
          </a>
          <div className="sidebar-bottom">
            <ShieldCheck size={19} />
            <strong>Test failure deliberately.</strong>
            <p>
              Synthetic payments. No real charges, refunds or customer records.
            </p>
            <a href="https://www.tarneebtech.com/">
              Built by Hashem Hasan <ArrowRight size={13} />
            </a>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div>
              <span>Workspace</span>
              <ChevronRight size={14} />
              <strong>Failure workbench</strong>
            </div>
            <span className={`connection ${mode}`}>
              <Radio size={13} />
              {mode === 'server'
                ? 'LOCAL HTTP + SQLITE'
                : mode === 'simulation'
                  ? 'BROWSER SIMULATION'
                  : mode === 'loading'
                    ? 'CONNECTING'
                    : 'API OFFLINE'}
            </span>
          </header>
          <main id="workbench">
            <div className="heading">
              <div>
                <div className="eyebrow">RELIABILITY STARTS WITH A FAILURE</div>
                <h1>Make the difficult events routine.</h1>
                <p>
                  Duplicate deliveries. Lost responses. Workers that disappear.
                  <br />
                  Reproduce the failure, then inspect the recovery.
                </p>
              </div>
              <button
                className="secondary"
                onClick={download}
                disabled={!snapshot.events.length}
              >
                <ArrowDownToLine size={16} />
                Export evidence
              </button>
            </div>
            <div className="mode-note">
              <Server size={18} />
              <p>
                {mode === 'simulation' ? (
                  <>
                    <strong>In-browser simulation.</strong> Events run in memory
                    using the sample domain logic. No HTTP calls, durable
                    storage or measured network latency.{' '}
                    <a href="https://github.com/Hashem-Hasan/hooklab#quick-start">
                      Start the local server for the real integration tests.
                    </a>
                  </>
                ) : (
                  <>
                    <strong>Local testing workspace.</strong> The server sends
                    real signed HTTP requests and persists the queue, attempts
                    and consumer state in SQLite.
                  </>
                )}
              </p>
            </div>
            {error && (
              <div className="error" role="alert">
                <TriangleAlert size={18} />
                {error}
                <button aria-label="Dismiss error" onClick={() => setError('')}>
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="metrics">
              <div>
                <span>DELIVERIES</span>
                <strong>
                  {snapshot.events.length}
                  <small>queued in this workspace</small>
                </strong>
              </div>
              <div>
                <span>SUCCESSFUL</span>
                <strong>
                  {delivered}
                  <small>terminal delivery success</small>
                </strong>
              </div>
              <div>
                <span>ATTEMPTS</span>
                <strong>
                  {totalAttempts}
                  <small>including retries</small>
                </strong>
              </div>
              <div>
                <span>DEAD LETTERS</span>
                <strong>
                  {dead}
                  <small>ready for investigation</small>
                </strong>
              </div>
            </div>
            <section className="scenario-section">
              <div className="section-title">
                <div>
                  <h2>Choose a failure scenario</h2>
                  <p>One focused experiment. Explicit assertions.</p>
                </div>
                <span className="tiny-label">SYNTHETIC PAYMENT CONSUMER</span>
              </div>
              <div className="scenario-grid">
                {scenarios.map((item, index) => (
                  <button
                    key={item.id}
                    className={`scenario ${selected === item.id ? 'selected' : ''}`}
                    aria-pressed={selected === item.id}
                    disabled={running}
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="scenario-top">
                      <span className="scenario-number">0{index + 1}</span>
                      <span className="scenario-tag">{item.tag}</span>
                      {selected === item.id && <CheckCircle2 size={15} />}
                    </span>
                    <strong>{item.name}</strong>
                    <span className="description">{item.description}</span>
                  </button>
                ))}
              </div>
              <div className="run-bar">
                <div>
                  <span className="run-dot" />
                  <span>
                    {running
                      ? 'Running scenario… inspect the result when complete.'
                      : `${scenarios.find((item) => item.id === selected)?.name} is ready to run.`}
                  </span>
                </div>
                <button
                  className="primary"
                  disabled={running || !['server', 'simulation'].includes(mode)}
                  onClick={() => void run()}
                >
                  {running ? (
                    <RefreshCw size={16} className="spin" />
                  ) : (
                    <Play size={16} />
                  )}{' '}
                  {running ? 'Running…' : 'Run scenario'}
                </button>
              </div>
            </section>
            {latest && (
              <section className="assertions" aria-live="polite">
                <div className="assertion-title">
                  <ShieldCheck size={18} />
                  <strong>Run assertions</strong>
                  <code>{latest.id.slice(0, 8)}</code>
                </div>
                <div>
                  {latest.assertions.map((item, index) => (
                    <div
                      className={`assertion ${item.passed ? 'pass' : 'fail'}`}
                      key={index}
                    >
                      {item.passed ? <Check size={15} /> : <X size={15} />}
                      <span>{item.name}</span>
                      <code>{item.actual}</code>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section className="event-workspace">
              <div className="event-list">
                <div className="panel-title">
                  <h2>
                    Event deliveries <span>{snapshot.events.length}</span>
                  </h2>
                  <button
                    className="icon-button"
                    aria-label="Refresh workspace"
                    onClick={() => void refresh()}
                    disabled={mode === 'simulation' || running}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
                <div className="filters">
                  {['all', 'delivered', 'dead', 'queued'].map((value) => (
                    <button
                      aria-pressed={filter === value}
                      className={filter === value ? 'active' : ''}
                      onClick={() => setFilter(value)}
                      key={value}
                    >
                      {value === 'all' ? 'All events' : value}
                    </button>
                  ))}
                </div>
                <div className="event-rows">
                  {snapshot.events
                    .filter((item) => filter === 'all' || item.state === filter)
                    .map((item) => (
                      <button
                        className={`event-row ${event?.id === item.id ? 'selected' : ''}`}
                        key={item.id}
                        onClick={() => setEventId(item.id)}
                      >
                        <div>
                          <span className={`state ${item.state}`}>
                            {item.state}
                          </span>
                          <span className="event-name">
                            {JSON.parse(item.payload).type}
                          </span>
                        </div>
                        <div>
                          <code>{item.provider_id.slice(0, 18)}…</code>
                          <span>
                            {item.attempts} attempt
                            {item.attempts === 1 ? '' : 's'}
                          </span>
                        </div>
                      </button>
                    ))}
                  {!snapshot.events.length && (
                    <div className="empty">
                      <Layers3 size={30} />
                      <h3>Your first failure belongs here.</h3>
                      <p>
                        Run a scenario to get a real delivery timeline and
                        inspect its assertions.
                      </p>
                    </div>
                  )}
                  {snapshot.events.length > 0 &&
                    !snapshot.events.some(
                      (item) => filter === 'all' || item.state === filter,
                    ) && (
                      <div className="empty">
                        <Check size={24} />
                        <p>No events match this state.</p>
                      </div>
                    )}
                </div>
              </div>
              <div className="inspector">
                <div className="panel-title">
                  <h2>Delivery inspector</h2>
                  <span className="tiny-label">
                    {mode === 'simulation' ? 'SIMULATED' : 'RECORDED'}
                  </span>
                </div>
                {event ? (
                  <>
                    <div className="inspect-meta">
                      <span>EVENT ID</span>
                      <code>{event.id}</code>
                      <span>DESTINATION</span>
                      <code>{event.target}</code>
                      <span>STATE</span>
                      <div>
                        <span className={`state ${event.state}`}>
                          {event.state}
                        </span>
                        {mode === 'server' && event.state === 'dead' && (
                          <button
                            className="inline-button"
                            onClick={() => void retry(event.id)}
                          >
                            Requeue event <RefreshCw size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    <h3 className="subheading">Attempt timeline</h3>
                    <ol className="timeline">
                      {attempts.map((item) => (
                        <li key={item.id}>
                          <span
                            className={
                              item.status && item.status < 300
                                ? 'timeline-dot success'
                                : 'timeline-dot'
                            }
                          />
                          <div>
                            <strong>Attempt {item.number}</strong>
                            <span>
                              {item.status
                                ? `HTTP ${item.status}`
                                : (item.error ?? 'No response')}{' '}
                              ·{' '}
                              {mode === 'simulation'
                                ? 'simulated'
                                : `${item.latency_ms}ms`}
                            </span>
                            <small>
                              {new Date(item.created_at).toLocaleTimeString()}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <h3 className="subheading">
                      Payload{' '}
                      <span>secret fields redacted in server exports</span>
                    </h3>
                    <pre>
                      {JSON.stringify(JSON.parse(event.payload), null, 2)}
                    </pre>
                  </>
                ) : (
                  <div className="empty">
                    <Activity size={30} />
                    <h3>The full story, one event at a time.</h3>
                    <p>
                      Select a delivery to see its payload and every recorded
                      attempt.
                    </p>
                  </div>
                )}
              </div>
            </section>
            <section id="consumer" className="consumer">
              <div className="section-title">
                <div>
                  <h2>Sample consumer state</h2>
                  <p>
                    One order per payment ID. Newer versions replace older
                    state.
                  </p>
                </div>
                <span className="tiny-label">AMOUNTS IN INTEGER CENTS</span>
              </div>
              {snapshot.orders.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Payment ID</th>
                        <th>Status</th>
                        <th>Version</th>
                        <th>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.orders.slice(0, 10).map((order) => (
                        <tr key={order.paymentId}>
                          <td>
                            <code>{order.paymentId.slice(0, 18)}…</code>
                          </td>
                          <td>{order.status}</td>
                          <td>v{order.version}</td>
                          <td>{(order.amount / 100).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="placeholder">
                  No orders yet. The duplicate storm will send ten deliveries
                  and create one.
                </p>
              )}
            </section>
            <section id="history" className="history">
              <div className="section-title">
                <div>
                  <h2>Run history</h2>
                  <p>
                    {mode === 'simulation'
                      ? 'This tab only. Refreshing clears simulated state.'
                      : 'Persisted in the local SQLite database. Latest 100 runs are shown.'}
                  </p>
                </div>
              </div>
              {snapshot.runs.length ? (
                snapshot.runs.slice(0, 8).map((item) => (
                  <div className="history-row" key={item.id}>
                    <CheckCircle2 size={17} />
                    <strong>
                      {scenarios.find((s) => s.id === item.scenario)?.name}
                    </strong>
                    <code>{item.id.slice(0, 8)}</code>
                    <span>
                      {item.assertions.filter((a) => a.passed).length}/
                      {item.assertions.length} assertions
                    </span>
                    <time>
                      {new Date(item.created_at).toLocaleTimeString()}
                    </time>
                  </div>
                ))
              ) : (
                <p className="placeholder">
                  Your experiments will appear here.
                </p>
              )}
            </section>
            <footer>
              <span>
                <Activity size={16} /> HookLab · Built by Hashem Hasan
              </span>
              <a href="https://github.com/Hashem-Hasan/hooklab">
                Read the implementation <ArrowRight size={14} />
              </a>
            </footer>
          </main>
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
