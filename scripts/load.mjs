/**
 * Sustained load with the two things the operating conditions promise: senders
 * that resend, and arrivals that are not in clinical order.
 *
 * Usage: node scripts/load.mjs [--rate 1000] [--seconds 60] [--patients 200]
 *                              [--duplicates 0.2] [--shuffle 3] [--keep]
 *
 * --patients matters more than it looks. One event per patient is in flight at
 * a time and each takes ~5s, so the ceiling is patients/5s regardless of how
 * many workers run: 1000 events/min needs at least ~84 concurrently active
 * patients.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const flag = (name) => process.argv.includes(`--${name}`);

const API = process.env.API_URL ?? 'http://localhost:3000';
const RATE = arg('rate', 1000);
const SECONDS = arg('seconds', 60);
const PATIENTS = arg('patients', 200);
const DUPLICATES = arg('duplicates', 0.2);
// Window the arrival order is shuffled within, as a multiple of the patient
// count. It has to exceed the patient count to do anything at all: events of
// one patient sit PATIENTS apart in the plan, so a smaller window only ever
// swaps events of different patients and leaves each patient's order intact.
const SHUFFLE = arg('shuffle', 3);

const TYPES = ['admission', 'vitals', 'vitals', 'medication', 'discharge'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unique = [];
const clock = new Map();
const target = Math.round((RATE / 60) * SECONDS);

for (let i = 0; i < target; i++) {
  const patientId = `load-${i % PATIENTS}`;
  // Clinical time advances per patient, independently of when we send it.
  const step = (clock.get(patientId) ?? 0) + 1;
  clock.set(patientId, step);

  unique.push({
    patientId,
    type: TYPES[step % TYPES.length],
    data: { seq: step, heartRate: 50 + (step % 50) },
    ts: new Date(Date.parse('2026-11-07T00:00:00.000Z') + step * 60_000).toISOString(),
  });
}

// Arrival order: shuffle inside sliding windows, so a patient's later events
// routinely arrive before earlier ones. Without this the load would happen to
// be ordered and would prove nothing about ordering.
const windowSize = Math.max(2, SHUFFLE * PATIENTS);
const plan = [...unique];
for (let start = 0; start < plan.length; start += windowSize) {
  const window = plan.slice(start, start + windowSize);
  for (let i = window.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [window[i], window[j]] = [window[j], window[i]];
  }
  plan.splice(start, window.length, ...window);
}

// Duplicates: a sender that timed out and resent something from a moment ago.
const toSend = [];
for (const event of plan) {
  toSend.push(event);
  if (Math.random() < DUPLICATES && toSend.length > 1) {
    const back = Math.min(50, toSend.length);
    toSend.push(toSend[toSend.length - Math.ceil(Math.random() * back)]);
  }
}

const stats = async () => (await fetch(`${API}/stats`)).json();

if (!flag('keep')) {
  // Without a clean slate the arithmetic at the end compares against leftovers.
  const before = await stats();
  if (before.events.total > 0) {
    console.log(`warning: the collection already holds ${before.events.total} events.`);
    console.log('pass --keep to add to them, or clear the collection so the arithmetic adds up.');
    process.exit(1);
  }
}

console.log(`sending ${toSend.length} POSTs (${unique.length} unique events, ` +
  `${toSend.length - unique.length} resends) at ${RATE}/min across ${PATIENTS} patients`);

const intervalMs = 60_000 / RATE;
const latencies = [];
const byStatus = new Map();
const inFlight = new Set();
const startedAt = Date.now();

for (let i = 0; i < toSend.length; i++) {
  const due = startedAt + i * intervalMs;
  const wait = due - Date.now();
  if (wait > 1) await sleep(wait);

  const sentAt = performance.now();
  const task = fetch(`${API}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toSend[i]),
  })
    .then((res) => {
      latencies.push(performance.now() - sentAt);
      byStatus.set(res.status, (byStatus.get(res.status) ?? 0) + 1);
    })
    .catch((err) => {
      byStatus.set(err.message, (byStatus.get(err.message) ?? 0) + 1);
    })
    .finally(() => inFlight.delete(task));
  inFlight.add(task);
}

await Promise.allSettled([...inFlight]);
const sendSeconds = (Date.now() - startedAt) / 1000;
const atSendEnd = await stats();

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.floor((latencies.length - 1) * p)].toFixed(0);

console.log('');
console.log(`sent in               ${sendSeconds.toFixed(1)}s ` +
  `(${(toSend.length / sendSeconds * 60).toFixed(0)}/min effective)`);
console.log(`responses             ${[...byStatus].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
console.log(`POST latency          p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms  p99 ${pct(0.99)}ms  max ${pct(1)}ms`);

console.log('');
console.log('waiting for the backlog to drain...');
let last = null;
for (;;) {
  const s = await stats();
  const left = s.events.pending + s.events.processing;
  if (left === 0) break;
  if (last === null || Math.abs(last - left) > target / 20) {
    console.log(`  ${left} left (processed ${s.events.processed}, in flight ${s.backlog.inFlight})`);
    last = left;
  }
  await sleep(1000);
}

const s = await stats();
const totalSeconds = (Date.now() - startedAt) / 1000;
const drainSeconds = totalSeconds - sendSeconds;
const drained = s.events.processed - atSendEnd.events.processed;
const check = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

console.log('');
console.log(JSON.stringify(s, null, 2));
console.log('');
console.log(`total elapsed         ${totalSeconds.toFixed(1)}s`);
// Little's law: at R events/s each taking S seconds, a system keeping up holds
// R*S of them in flight. A backlog near that number means the service is
// matching the send rate; one that keeps climbing means it is not.
const inFlightPrediction = (RATE / 60) * 5;
const backlog = atSendEnd.events.pending + atSendEnd.events.processing;
console.log(`backlog when sending stopped ${backlog} ` +
  `(Little's law predicts ~${inFlightPrediction.toFixed(0)} in flight at ${RATE}/min x 5s)`);
console.log(`drain throughput      ${(drained / drainSeconds * 60).toFixed(0)}/min ` +
  `(${drained} events in ${drainSeconds.toFixed(1)}s; only meaningful with a large backlog)`);
console.log(`theoretical ceiling   ${(Math.min(PATIENTS, 100) / 5 * 60).toFixed(0)}/min ` +
  `= min(active patients, worker slots) / 5s`);
console.log('');
check(s.ingest.postsAccepted === toSend.length, `all ${toSend.length} POSTs accounted for`);
check(s.ingest.eventsStored === unique.length, `${unique.length} events stored, one per unique event`);
check(s.ingest.duplicatesSuppressed === toSend.length - unique.length, 'every resend absorbed, none stored twice');
check(s.events.processed === unique.length, 'every stored event was processed');
check(s.events.failed === 0, 'no event in a failed state');
check(backlog < inFlightPrediction * 2, `the backlog stayed bounded at ${backlog} rather than climbing`);
check(s.ordering.lateArrivals > 0, `${s.ordering.lateArrivals} events arrived out of clinical order (otherwise this proves nothing about ordering)`);
