// Indexes the generator creates on the MongoDB source, including the two TTL
// indexes. Kept apart from the CLI so tests can import it without a driver.
// [collection, index key, options]
export const INDEXES = [
  ['carts', { updatedAt: 1 }, { name: 'carts_ttl', expireAfterSeconds: 120 }],
  ['carts', { subscriberId: 1 }, {}],
  // TTL only expires Date values, so it sits on createdAt, not on the ts Timestamp.
  ['orderEvents', { createdAt: 1 }, { name: 'orderEvents_ttl', expireAfterSeconds: 604_800 }],
  ['orderEvents', { ts: 1 }, {}],
  ['orderEvents', { orderId: 1 }, {}],
  ['orders', { region: 1, placedAt: -1 }, {}],
  // The order service counts one device's units per region when it may enter the Top 10.
  ['orders', { region: 1, 'lines.sku': 1 }, {}],
  ['orders', { 'subscriber.id': 1 }, {}],
  ['subscribers', { accountId: 1 }, {}],
  ['accounts', { householdId: 1 }, {}],
  ['accounts', { parentAccountId: 1 }, {}],
  ['catalog', { kind: 1 }, {}],
];
