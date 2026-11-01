// Fixture for the operator scan: an app using operators the Oracle API for
// MongoDB does not run. Never executed, only parsed.
export async function nearbyStores(db, point) {
  return db.collection('stores').find({ loc: { $near: { $geometry: { type: 'Point', coordinates: point } } } }).toArray();
}

export async function legacyFilter(db) {
  return db.collection('orders').find({ $where: 'this.total > 100' }).toArray();
}

// Key forms the scanner must see: a quoted key and a computed literal key.
export const update = { '$set': { a: 1 }, ['$unset']: { b: '' } };
// A field path is a string value, not an operator.
export const stage = { $unwind: '$lines' };
