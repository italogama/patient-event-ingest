// Initiates the replica set. Runs on every `docker compose up`, so it has to be
// idempotent: the data volume survives `docker compose down`.
try {
  rs.status();
} catch (err) {
  if (err.codeName !== 'NotYetInitialized') {
    throw err;
  }
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] });
}

// The API starts as soon as this container exits. A set that has initiated but
// not yet elected a primary rejects writes, so wait for the election here
// rather than leaving the first requests to fail.
while (!db.hello().isWritablePrimary) {
  sleep(200);
}
