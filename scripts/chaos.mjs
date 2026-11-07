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
  console.log(`a colecao tem ${before.events.total} eventos; limpe antes para a conta fechar.`);
  process.exit(1);
}

const workers = docker('compose', 'ps', '-q', 'worker').split('\n').filter(Boolean);
if (workers.length < 2) {
  console.log(`precisa de 2 replicas de worker, encontrei ${workers.length}.`);
  console.log('rode: docker compose up -d --scale worker=2 worker');
  process.exit(1);
}

console.log(`enviando ${EVENTS} eventos sobre ${PATIENTS} pacientes`);
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
console.log(`aceitos ${accepted}/${EVENTS}`);

// Both replicas have to be holding work before the kill. Killing whichever
// container happens to be listed first proves nothing: the replicas race to
// claim, and one can easily have taken everything while the other had not
// started, in which case the victim dies holding nothing and no recovery is
// exercised at all.
console.log('aguardando as duas replicas segurarem trabalho...');
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
  console.log(`nao achei o container de ${victimWorkerId}`);
  process.exit(1);
}

const holding = atKill.backlog.inFlightByWorker[victimWorkerId];
docker('kill', '--signal=SIGKILL', victim);
console.log('');
console.log(`SIGKILL em ${victimWorkerId}, que segurava ${holding} eventos`);
console.log(`distribuicao no instante da morte: ${JSON.stringify(atKill.backlog.inFlightByWorker)}`);
console.log('os eventos dele ficam invisiveis para o sobrevivente ate o lease vencer.');

// Deliberately not restarted: the surviving replica has to recover the dead
// one's work on its own, which is what happens when a node disappears and the
// scheduler has not replaced it yet.
console.log('');
console.log('aguardando o dreno sem reiniciar o worker morto...');
const startedWaiting = Date.now();
let reported = 0;
for (;;) {
  const s = await stats();
  const left = s.events.pending + s.events.processing;
  if (left === 0) break;
  const elapsed = Math.floor((Date.now() - startedWaiting) / 1000);
  if (elapsed >= reported + 10) {
    reported = elapsed;
    console.log(`  ${elapsed}s: restam ${left} (processed ${s.events.processed}, ` +
      `in flight ${s.backlog.inFlight})`);
  }
  if (elapsed > 300) {
    console.log('TIMEOUT: o backlog nao drenou em 5 minutos');
    break;
  }
  await sleep(1000);
}

docker('compose', 'up', '-d', 'worker');
console.log('replica reiniciada');

const s = await stats();
const check = (ok, label) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

console.log('');
console.log(JSON.stringify(s, null, 2));
console.log('');
check(s.events.total === EVENTS, `os ${EVENTS} eventos continuam no banco`);
check(s.events.processed === EVENTS, 'todos chegaram a processed, apesar do SIGKILL');
check(s.events.processing === 0 && s.events.pending === 0, 'nenhum ficou preso');
check(s.events.failed === 0, 'nenhum virou falha por causa da morte do worker');
check(
  s.retries.eventsWithMoreThanOneAttempt >= holding,
  `os ${holding} eventos do worker morto foram retomados ` +
    `(${s.retries.eventsWithMoreThanOneAttempt} com mais de uma tentativa; ` +
    'a tentativa perdida fica contada, nao escondida)',
);
