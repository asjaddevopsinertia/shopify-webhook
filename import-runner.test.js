'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapLimit, processPage, runImport, acquireLease } = require('./import-runner');
const { orderFilter, needsShipping, prepareOrder } = require('./import-orders');
const { memoryContext, MemoryCollection } = require('./test-helpers');
const order = id => ({ id: String(id), name: `#${id}`, line_items: [{ title: 'Marmalade', quantity: 1 }] });
function services(overrides = {}) {
  return { config: { shop: 'test.myshopify.com', version: '2026-10', collection: 'orders' },
    api: path => `https://test.myshopify.com/${path}`, nextLink: headers => headers.get('next'),
    orderFilter, needsShipping, concurrency: 3,
    prepareOrder: (o, existing, a, b, options) => prepareOrder(o, existing,
      async () => ({ total: o.id === '2' ? null : 8, warnings: [] }), undefined, options),
    prepareCache: async () => null, acquireLease: async () => ({ assertLease() {}, async release() {} }),
    ...overrides };
}

test('bounded workers overlap independent work without exceeding the configured limit', async () => {
  let active = 0, peak = 0;
  const output = await mapLimit([1, 2, 3, 4, 5], 2, async i => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return i * 2;
  });
  assert.deepEqual(output, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
  await assert.rejects(mapLimit([1], 0, () => {}), /positive integer/);
});
test('worker errors drain other in-flight requests before propagating', async () => {
  let drained = false;
  await assert.rejects(mapLimit([1, 2, 3], 2, async i => {
    if (i === 1) { await Promise.resolve(); throw Error('failure'); }
    await new Promise(resolve => setImmediate(resolve)); drained = true;
  }), /failure/);
  assert.equal(drained, true);
});
test('page writes insert only missing orders, preserve positive shipping and unrelated fields, and queue pending costs', async () => {
  const ctx = memoryContext([
    { _id: 'a', id: '1', real_shipping_cost: 15, note: 'keep positive order' },
    { _id: 'b', id: 2, real_shipping_cost: 0, note: 'keep existing order' },
  ]);
  const counts = await processPage(ctx, [order(1), order(2), order(3)], services());
  assert.deepEqual(counts, { inserted: 1, shipping_updated: 1, fees_updated: 0, skipped: 1, processed: 3 });
  assert.equal(ctx.orders.reads, 2); // Two reads for the page, rather than two per order.
  assert.equal(ctx.orders.bulkCalls, 1);
  assert.equal(ctx.jobs.bulkCalls, 1);
  assert.equal(ctx.orders.docs.find(d => d.id === '1').real_shipping_cost, 15);
  assert.equal(ctx.orders.docs.find(d => d.id === 2).note, 'keep existing order');
  assert.equal(ctx.orders.docs.find(d => d.id === 2).real_shipping_cost, null);
  assert.equal(ctx.jobs.docs[0]._id, '2');
  assert.equal(ctx.orders.docs.length, 3);
});
test('concurrent insertion is counted as skipped and never replaces the other writer', async () => {
  const ctx = memoryContext();
  ctx.orders.beforeBulk = async () => { ctx.orders.docs.push({ _id: 'race', id: '3', real_shipping_cost: 99 }); };
  const counts = await processPage(ctx, [order(3)], services());
  assert.equal(counts.inserted, 0);
  assert.equal(counts.skipped, 1);
  assert.equal(ctx.orders.docs.length, 1);
  assert.equal(ctx.orders.docs[0].real_shipping_cost, 99);
});
test('compare-and-set prevents an in-flight shipping lookup overwriting a newly positive cost', async () => {
  const ctx = memoryContext([{ _id: 'x', id: '2', real_shipping_cost: 0 }]);
  ctx.orders.beforeBulk = async () => { ctx.orders.docs[0].real_shipping_cost = 42; };
  await processPage(ctx, [order(2)], services());
  assert.equal(ctx.orders.docs[0].real_shipping_cost, 42);
  assert.equal(ctx.jobs.docs.length, 0);
});
test('authoritative empty cached shipments reach preparation without per-order lookups', async () => {
  const ctx = memoryContext();
  const options = services({ snapshot: { forOrders: async () => () => [] },
    prepareOrder: async (o, existing, a, b, shippingOptions) => {
      assert.deepEqual(shippingOptions.shipstationShipments, []);
      return prepareOrder(o, existing, async () => ({ total: null }));
    } });
  await processPage(ctx, [order(1)], options);
  assert.equal(ctx.orders.docs.length, 1);
});
test('checkpoint resumes the next page and completed runs start a new scan', async () => {
  const ctx = memoryContext(), requests = [];
  const options = services({ maxPages: 1, request: async url => {
    requests.push(url);
    const second = url.endsWith('page2');
    return { data: { orders: [order(second ? 3 : 1)] }, headers: new Headers(second ? {} : { next: 'https://test.myshopify.com/page2' }) };
  } });
  const first = await runImport(ctx, options);
  assert.equal(first.status, 'running');
  assert.equal(first.page, 1);
  const second = await runImport(ctx, options);
  assert.equal(requests[1], 'https://test.myshopify.com/page2');
  assert.equal(second.status, 'complete');
  assert.equal(second.counts.inserted, 2);
  await runImport(ctx, options);
  assert.match(requests[2], /orders.json/);
  assert.equal(ctx.orders.docs.length, 2);
});
test('failed retry-queue writes retain the current page; replay creates no duplicate orders', async () => {
  const ctx = memoryContext(), requests = [];
  const options = services({ request: async url => {
    requests.push(url); return { data: { orders: [order(2)] }, headers: new Headers() };
  } });
  ctx.jobs.failBulk = true;
  await assert.rejects(runImport(ctx, options), /write failure/);
  const state = ctx.db.collection('orders_import_state');
  assert.equal(state.docs[0].page, 0);
  assert.equal(ctx.orders.docs.length, 1);
  ctx.jobs.failBulk = false;
  assert.equal((await runImport(ctx, options)).status, 'complete');
  assert.equal(requests[0], requests[1]);
  assert.equal(ctx.orders.docs.length, 1);
  assert.equal(ctx.jobs.docs.length, 1);
});
test('order bulk failures do not advance the checkpoint and release the importer lease', async () => {
  const ctx = memoryContext(); let released = false;
  ctx.orders.failBulk = true;
  const options = services({ acquireLease: async () => ({ assertLease() {}, async release() { released = true; } }),
    request: async () => ({ data: { orders: [order(1)] }, headers: new Headers() }) });
  await assert.rejects(runImport(ctx, options), /write failure/);
  assert.equal(ctx.db.collection('orders_import_state').docs[0].page, 0);
  assert.equal(released, true);
});
test('expired saved Shopify cursor recovers once with a safe rescan', async () => {
  const ctx = memoryContext();
  await ctx.db.collection('orders_import_state').replaceOne({ _id: 'shopify:test.myshopify.com:2026-10' }, {
    _id: 'shopify:test.myshopify.com:2026-10', page: 2, status: 'running', nextUrl: 'https://test.myshopify.com/expired', counts: {},
  }, { upsert: true });
  const requests = [];
  const result = await runImport(ctx, services({ request: async url => {
    requests.push(url);
    if (url.endsWith('/expired')) throw Object.assign(Error('expired'), { status: 400 });
    return { data: { orders: [order(1)] }, headers: new Headers() };
  } }));
  assert.equal(result.status, 'complete');
  assert.equal(requests.length, 2);
  assert.match(requests[1], /orders.json/);
});
test('live importer lease rejects a second importer and can be reacquired after release', async () => {
  const state = new MemoryCollection();
  const lease = await acquireLease(state, 'lease:importer');
  try {
    lease.assertLease();
    await assert.rejects(acquireLease(state, 'lease:importer'), /already running/);
  } finally { await lease.release(); }
  const next = await acquireLease(state, 'lease:importer');
  await next.release();
});
test('lease loss prevents batched order writes', async () => {
  const ctx = memoryContext();
  await assert.rejects(processPage(ctx, [order(1)], services({ assertLease: () => { throw Error('Lease lost'); } })), /Lease lost/);
  assert.equal(ctx.orders.bulkCalls, 0);
  assert.equal(ctx.orders.docs.length, 0);
});
test('non-duplicate database errors propagate instead of silently advancing a page', async () => {
  const ctx = memoryContext();
  ctx.orders.bulkWrite = async () => { throw Object.assign(Error('Validation failure'), { writeErrors: [{ index: 0, code: 121 }] }); };
  await assert.rejects(processPage(ctx, [order(1)], services()), /Validation failure/);
  assert.equal(ctx.jobs.bulkCalls, 0);
});
