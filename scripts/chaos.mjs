/**
 * Kills a worker with SIGKILL while it holds events, then checks that every
 * event still reaches a terminal state.
 *
 * SIGKILL rather than SIGTERM on purpose: SIGTERM is the graceful path, where
 * the worker drains what it holds before exiting. This exercises the other
 * one, where the process is simply gone and its claimed events sit in
 * "processing" behind a lease nobody will release.
 *
 * Usage: node scripts/chaos.mjs [--events 300] [--patients 100]
 */

import { execFileSync } from 'node:child_process';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const API = process.env.API_URL ?? 'http://localhost:3000';
const DOCKER = process.env.DOCKER ?? 'docker';
const EVENTS = arg('events', 300);
const PATIENTS = arg('patients', 100);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = async () => (await fetch(`${API}/stats`)).json();
const docker = (...args) => execFileSync(DOCKER, args, { encoding: 'utf8' }).trim();

const before = await stats();
if (before.events.total > 0) {
  console.log(`the collection holds ${before.events.total} events; clear it so the arithmetic adds up.`);
  process.exit(1);
}

const workers = docker('compose', 'ps', '-q', 'worker').split('\n').filter(Boolean);
if (workers.length < 2) {
  console.log(`needs 2 worker replicas, found ${workers.length}.`);
  console.log('run: docker compose up -d --scale worker=2 worker');
  process.exit(1);
}

console.log(`sending ${EVENTS} events across ${PATIENTS} patients`);
const posts = [];
for (let i = 0; i < EVENTS; i++) {
  posts.push(
    fetch(`${API}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patientId: `chaos-${i % PATIENTS}`,
        type: 'vitals',
        data: { seq: i, heartRate: 50 + (i % 50) },
        ts: new Date(Date.parse('2026-11-07T00:00:00.000Z') + i * 1000).toISOString(),
      }),
    }),
  );
}
const responses = await Promise.all(posts);
const accepted = responses.filter((r) => r.status === 202).length;
console.log(`accepted ${accepted}/${EVENTS}`);

// Both replicas have to be holding work before the kill. Killing whichever
// container happens to be listed first proves nothing: the replicas race to
// claim, and one can easily have taken everything while the other had not
// started, in which case the victim dies holding nothing and no recovery is
// exercised at all.
console.log('waiting until both replicas are holding work...');
let atKill;
let victimWorkerId;
for (;;) {
  atKill = await stats();
  const holders = Object.entries(atKill.backlog.inFlightByWorker);
  if (holders.length >= 2) {
    const [top] = holders.sort((a, b) => b[1] - a[1]);
    if (top[1] >= 10) {
      victimWorkerId = top[0];
      break;
    }
  }
  await sleep(200);
}

// A worker id is `${hostname()}:${pid}`, and in Docker the hostname is the
// container's short id, which is how the holder maps back to a container.
const victimHost = victimWorkerId.split(':')[0];
const victim = workers.find((id) => id.startsWith(victimHost));
if (!victim) {
  console.log(`no container found for ${victimWorkerId}`);
  process.exit(1);
}

const holding = atKill.backlog.inFlightByWorker[victimWorkerId];
docker('kill', '--signal=SIGKILL', victim);
console.log('');
console.log(`SIGKILL to ${victimWorkerId}, which was holding ${holding} events`);
console.log(`distribution at the moment of death: ${JSON.stringify(atKill.backlog.inFlightByWorker)}`);
console.log('its events are invisible to the survivor until the lease expires.');

// Deliberately not restarted: the surviving replica has to recover the dead
// one's work on its own, which is what happens when a node disappears and the
// scheduler has not replaced it yet.
console.log('');
console.log('waiting for the drain, without restarting the dead worker...');
const startedWaiting = Date.now();
let reported = 0;
for (;;) {
  const s = await stats();
  const left = s.events.pending + s.events.processing;
  if (left === 0) break;
  const elapsed = Math.floor((Date.now() - startedWaiting) / 1000);
  if (elapsed >= reported + 10) {
    reported = elapsed;
    console.log(`  ${elapsed}s: ${left} left (processed ${s.events.processed}, ` +
      `in flight ${s.backlog.inFlight})`);
  }
  if (elapsed > 300) {
    console.log('TIMEOUT: the backlog did not drain within 5 minutes');
    break;
  }
  await sleep(1000);
}

docker('compose', 'up', '-d', 'worker');
console.log('replica restarted');

const s = await stats();
const check = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

console.log('');
console.log(JSON.stringify(s, null, 2));
console.log('');
check(s.events.total === EVENTS, `all ${EVENTS} events are still stored`);
check(s.events.processed === EVENTS, 'every one reached processed, despite the SIGKILL');
check(s.events.processing === 0 && s.events.pending === 0, 'none left stuck in pending or processing');
check(s.events.failed === 0, 'none turned into a failure because a worker died');
check(
  s.retries.eventsWithMoreThanOneAttempt >= holding,
  `the dead worker's ${holding} events were picked up again ` +
    `(${s.retries.eventsWithMoreThanOneAttempt} with more than one attempt; ` +
    'the lost attempt is counted, not hidden)',
);
