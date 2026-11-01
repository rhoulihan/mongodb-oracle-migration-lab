// Initiate the single-node replica set rs0 if it does not exist yet, then wait
// until this node is the writable primary. Safe to run on every start.
try {
  rs.status();
  print('rs0 already initiated');
} catch (e) {
  if (e.codeName !== 'NotYetInitialized') throw e;
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] });
  print('rs0 initiated');
}
while (!db.hello().isWritablePrimary) sleep(200);
print('rs0 primary ready');
