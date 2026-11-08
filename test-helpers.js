'use strict';
// In-memory Mongo-style adapter for offline batch/recovery tests only.
const clone = value => structuredClone(value);
function equal(a, b) {
  if (a === undefined && b === null) return true;
  if (a instanceof Date || b instanceof Date) return +a === +b;
  if (a?._bsontype || b?._bsontype) return String(a) === String(b);
  return a === b;
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(doc, part));
    const actual = key.split('.').reduce((value, part) => value?.[part], doc);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$in' in value) return value.$in.some(candidate => equal(actual, candidate));
      if ('$ne' in value) return !equal(actual, value.$ne);
      if ('$lte' in value) return actual !== undefined && actual <= value.$lte;
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
    }
    return equal(actual, value);
  });
}
class MemoryCollection {
  constructor(docs = []) {
    this.docs = clone(docs);
    this.reads = 0; this.bulkCalls = 0; this.failBulk = false;
    this.sequence = 0;
  }
  async createIndex() {}
  find(filter) {
    this.reads++;
    const docs = clone(this.docs.filter(d => matches(d, filter)));
    const cursor = { toArray: async () => docs, batchSize: () => cursor,
      async *[Symbol.asyncIterator]() { yield* docs; } };
    return cursor;
  }
  async findOne(filter) { return clone(this.docs.find(d => matches(d, filter)) || null); }
  async countDocuments(filter) { return this.docs.filter(d => matches(d, filter)).length; }
  async replaceOne(filter, replacement, { upsert } = {}) {
    const index = this.docs.findIndex(d => matches(d, filter));
    if (index >= 0) { this.docs[index] = clone(replacement); return { matchedCount: 1 }; }
    if (upsert) { this.docs.push(clone(replacement)); return { upsertedCount: 1 }; }
    return { matchedCount: 0 };
  }
  async updateOne(filter, update, { upsert } = {}) {
    let doc = this.docs.find(d => matches(d, filter));
    const inserted = !doc && upsert;
    if (!doc && !upsert) return { matchedCount: 0, upsertedCount: 0 };
    if (inserted) {
      if (this.docs.some(d => equal(d._id, filter._id)) && filter._id !== undefined) throw Object.assign(Error('duplicate'), { code: 11000 });
      doc = { _id: filter._id ?? `generated-${++this.sequence}`, ...(clone(update.$setOnInsert || {})) };
      this.docs.push(doc);
    }
    Object.assign(doc, clone(update.$set || {}));
    for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + value;
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
    return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0, upsertedId: inserted ? doc._id : null };
  }
  async findOneAndUpdate(filter, update, options) { return this.updateOne(filter, update, options); }
  async bulkWrite(operations) {
    this.bulkCalls++;
    if (this.failBulk) throw Error('Injected database write failure');
    if (this.beforeBulk) await this.beforeBulk(operations);
    const upsertedIds = {};
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.replaceOne) await this.replaceOne(op.replaceOne.filter, op.replaceOne.replacement, { upsert: op.replaceOne.upsert });
      else {
        const result = await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
        if (result.upsertedCount) upsertedIds[i] = result.upsertedId;
      }
    }
    return { upsertedIds };
  }
}
function memoryContext(docs = []) {
  const collections = new Map([['orders', new MemoryCollection(docs)], ['orders_sync_jobs', new MemoryCollection()]]);
  const db = { collection(name) {
    if (!collections.has(name)) collections.set(name, new MemoryCollection());
    return collections.get(name);
  } };
  return { db, orders: db.collection('orders'), jobs: db.collection('orders_sync_jobs') };
}
function fakeEnvironment(t, values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
module.exports = { MemoryCollection, memoryContext, fakeEnvironment };
