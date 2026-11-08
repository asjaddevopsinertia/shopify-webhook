'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncOrder, seedPendingOrders, reconcileUpdatedOrders } = require('./live-sync');
const shared = require('./import-orders');
const createHelpers = require('./shipping-costs');
const { memoryContext, fakeEnvironment } = require('./test-helpers');
const fruit = { title: 'Fresh fruit box', quantity: 1 }, jam = { title: 'Orange Marmalade', quantity: 1 };
const stamp = '2026-11-08T00:00:00.000Z';
const clock = () => new Date(stamp);
function fixture({ existing, details = { total: 8, status: 'observed', warnings: [], checked_at: clock() } } = {}) {
  const ctx = memoryContext(existing ? [existing] : []);
  const job = { _id: '123', owner: 'worker', revision: 1, nextRun: new Date(0), lockedUntil: new Date('2026-11-09') };
  ctx.jobs.docs.push(structuredClone(job));
  const order = { id: '123', name: '#123', updated_at: stamp, financial_status: 'paid', fulfillment_status: 'fulfilled', line_items: [jam] };
  const services = { ...shared, config: { shop: 'test.myshopify.com', collection: 'orders', currency: 'USD' },
    api: p => `https://test.myshopify.com/${p}`, request: async () => ({ data: { order } }),
    shippingDetails: async () => structuredClone(details),
    // Mongo-style snapshot save for offline tests; assert the production option
    // so tests exercise the live path rather than the old cost-overwrite path.
    saveOrder: async (orders, latest, cost, oldDetails, options) => {
      assert.equal(options.preserveShipping, true);
      const current = await orders.findOne(shared.orderFilter(latest.id));
      if (current && Date.parse(current.updated_at) > Date.parse(latest.updated_at)) return;
      await orders.updateOne(shared.orderFilter(latest.id), { $set: latest, $setOnInsert: { real_shipping_cost: null } }, { upsert: true });
    },
  };
  return { ctx, job, order, services };
}
test('new order creation and later status/quantity/refund changes are mirrored', async () => {
  const f = fixture();
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs.length, 1);
  assert.equal(f.ctx.orders.docs[0].financial_status, 'paid');
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 8);
  f.order.updated_at = '2026-11-08T01:00:00.000Z';
  f.order.fulfillment_status = 'partial';
  f.order.line_items = [{ ...jam, quantity: 3 }];
  f.order.refunds = [{ id: 100 }];
  f.order.cancelled_at = null;
  const result = await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs.length, 1);
  assert.equal(f.ctx.orders.docs[0].line_items[0].quantity, 3);
  assert.equal(f.ctx.orders.docs[0].fulfillment_status, 'partial');
  assert.equal(f.ctx.orders.docs[0].refunds.length, 1);
  assert.equal(+result.nextRun - +clock(), 300000);
});
test('fruit in ShipStation on day one, Shopify marmalade on day two, and a later additional label all recalculate without duplicates', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: 'test' });
  const f = fixture();
  let day = 1;
  const eventQueries = [];
  const helpers = createHelpers({ config: { currency: 'USD' }, api: p => `https://test.myshopify.com/${p}`, request: async (url, service) => {
    if (service === 'shipstation') return { data: { pages: 1, shipments: [{ shipmentId: 1,
      orderNumber: new URL(url).searchParams.get('orderNumber'), shipmentCost: 8, trackingNumber: 'FRUIT12345', shipmentItems: [fruit] }] } };
    eventQueries.push(url);
    return { data: { events: [{ id: 1, message: 'Order created' },
      ...(day >= 2 ? [{ id: 2, message: 'You purchased a $5.25 shipping label. Tracking number: JAM1234567' }] : []),
      ...(day >= 3 ? [{ id: 3, message: 'You purchased a shipping label for $2.00. Tracking number: JAM9876543' }] : []),
    ] } };
  } });
  f.services.shippingDetails = helpers.shippingDetails;
  f.order.line_items = [fruit, jam]; f.order.order_number = 123;
  f.order.fulfillment_status = 'partial';
  f.order.fulfillments = [{ tracking_number: 'FRUIT12345', line_items: [fruit] }];
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, null);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost_details.observed_total, 8);
  day = 2;
  f.order.fulfillment_status = 'fulfilled';
  f.order.fulfillments.push({ tracking_number: 'JAM1234567', line_items: [jam] });
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 13.25);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost_details.fruit, 8);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost_details.marmalade, 5.25);
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 13.25);
  day = 3;
  f.order.fulfillments.push({ tracking_number: 'JAM9876543', line_items: [jam] });
  const result = await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 15.25);
  assert.equal(+result.nextRun - +clock(), 21600000);
  assert.ok(eventQueries.every(url => url.includes('since_id=0')));
});
test('a previously positive shipping cost is checked again and can change', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', updated_at: '2026-11-07', real_shipping_cost: 5 } });
  let lookups = 0;
  f.services.shippingDetails = async () => { lookups++; return { total: 12, status: 'observed', warnings: [], checked_at: clock() }; };
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(lookups, 1);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 12);
});
test('shipping failures preserve the last known positive total while saving status changes and pending diagnostics', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', updated_at: '2026-11-07', real_shipping_cost: 13.25 } });
  f.order.fulfillment_status = 'partial';
  f.services.shippingDetails = async () => { throw Error('ShipStation HTTP 503'); };
  const result = await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 13.25);
  assert.equal(f.ctx.orders.docs[0].fulfillment_status, 'partial');
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost_details.status, 'pending');
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost_details.last_known_total, 13.25);
  assert.match(f.ctx.jobs.docs[0].lastShippingError, /503/);
  assert.equal(+result.nextRun - +clock(), 300000);
});
test('Faire fee failures do not block order mirroring and preserve previously reported fees', async () => {
  const fees = { status: 'reported', commission: 10, processing_fee: 2 };
  const f = fixture({ existing: { _id: 'x', id: '123', real_shipping_cost: 8, faire_fees: fees } });
  f.order.tags = 'Faire';
  f.services.getFaireOrder = async () => { throw Error('Faire HTTP 503'); };
  f.services.shippingDetails = async (order, options) => {
    assert.match(options.faireError.message, /503/);
    return { total: null, status: 'pending', warnings: ['Faire HTTP 503'], checked_at: clock() };
  };
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.deepEqual(f.ctx.orders.docs[0].faire_fees, fees);
  assert.equal(f.ctx.orders.docs[0].faire_fee_sync.status, 'pending');
  assert.equal(f.ctx.orders.docs[0].financial_status, 'paid');
});
test('live Faire fees refresh even when shipping was positive and share the shipping response', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', real_shipping_cost: 8 } });
  f.order.tags = 'Faire';
  const faire = { id: 'bo_test', payment_initiated_at: stamp, payout_costs: {
    commission: { amount_minor: 3009, currency: 'USD' }, commission_bps: 1500,
    commission_flat_fee: { amount_minor: 1000, currency: 'USD' },
    payout_fee: { amount_minor: 499, currency: 'USD' }, payout_fee_bps: 350,
    payout_flat_fee: { amount_minor: 30, currency: 'USD' },
  } };
  let calls = 0;
  f.services.getFaireOrder = async () => { calls++; return faire; };
  f.services.shippingDetails = async (order, options) => {
    assert.equal(options.faireOrder, faire);
    return { total: 12, status: 'observed', warnings: [], checked_at: clock() };
  };
  await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(calls, 1);
  assert.equal(f.ctx.orders.docs[0].faire_fees.commission, 30.09);
  assert.equal(f.ctx.orders.docs[0].faire_fees.processing_fee, 4.99);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 12);
});
test('an older Shopify snapshot cannot roll back a newer stored fulfillment or shipping state', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', updated_at: '2026-11-09T00:00:00.000Z',
    fulfillment_status: 'fulfilled', real_shipping_cost: 20 } });
  f.order.fulfillment_status = 'partial';
  const result = await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(result.deferred, true);
  assert.equal(f.ctx.orders.docs[0].fulfillment_status, 'fulfilled');
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 20);
});
test('a newer delivery during lookup stays immediately due and avoids stale shipping writes', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', real_shipping_cost: 5 } });
  f.services.shippingDetails = async () => {
    await shared.enqueue(f.ctx.jobs, '123', clock());
    return { total: 12, status: 'observed', warnings: [], checked_at: clock() };
  };
  const result = await syncOrder(f.ctx, f.job, { services: f.services, now: clock });
  assert.equal(result.deferred, true);
  assert.equal(f.ctx.jobs.docs[0].revision, 2);
  assert.equal(+f.ctx.jobs.docs[0].nextRun, +clock());
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 5);
});
test('lost job ownership prevents shipping writes', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', real_shipping_cost: 5 } });
  f.services.shippingDetails = async () => {
    f.ctx.jobs.docs[0].owner = 'other-worker';
    return { total: 12, status: 'observed', warnings: [] };
  };
  await assert.rejects(syncOrder(f.ctx, f.job, { services: f.services, now: clock }), /lease lost/);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 5);
});
test('order compare-and-set detects a concurrent cost change without overwriting it', async () => {
  const f = fixture({ existing: { _id: 'x', id: '123', real_shipping_cost: 5 } });
  const update = f.ctx.orders.updateOne.bind(f.ctx.orders);
  f.ctx.orders.updateOne = async (filter, change, options) => {
    if (change.$set?.shipping_last_synced_at) f.ctx.orders.docs[0].real_shipping_cost = 99;
    return update(filter, change, options);
  };
  await assert.rejects(syncOrder(f.ctx, f.job, { services: f.services, now: clock }), /changed during shipping/);
  assert.equal(f.ctx.orders.docs[0].real_shipping_cost, 99);
});
test('production status-save pipeline preserves existing enrichment atomically', async () => {
  let pipeline;
  await shared.saveOrder({ updateOne: async (filter, update) => { pipeline = update; } },
    { id: '123', updated_at: stamp, fulfillment_status: 'partial', real_shipping_cost: 999 }, null, undefined, { preserveShipping: true });
  const document = pipeline[0].$replaceWith.$cond[1].$mergeObjects[2].$literal;
  assert.equal(document.real_shipping_cost, undefined);
  assert.equal(document.fulfillment_status, 'partial');
});
test('startup seeding covers pending/open/mixed orders without postponing an active job', async () => {
  const ctx = memoryContext([
    { id: '1', real_shipping_cost: null, fulfillment_status: 'fulfilled', line_items: [jam] },
    { id: '2', real_shipping_cost: 5, fulfillment_status: 'partial', line_items: [jam] },
    { id: '3', real_shipping_cost: 5, fulfillment_status: 'fulfilled', line_items: [jam, fruit] },
    { id: '4', real_shipping_cost: 5, fulfillment_status: 'fulfilled', line_items: [jam] },
    { id: '5', real_shipping_cost: null, cancelled_at: stamp },
  ]);
  ctx.jobs.docs.push({ _id: '2', owner: 'active', revision: 10, nextRun: new Date(0) });
  assert.equal(await seedPendingOrders(ctx, { now: clock }), 3);
  assert.deepEqual(ctx.jobs.docs.map(j => j._id).sort(), ['1', '2', '3']);
  assert.equal(ctx.jobs.docs.find(j => j._id === '2').revision, 10);
  assert.equal(ctx.jobs.docs.find(j => j._id === '2').owner, 'active');
});
test('updated-order recovery follows every page and persists its watermark after queue writes', async () => {
  const ctx = memoryContext(), calls = [];
  const services = { ...shared, config: { shop: 'test.myshopify.com', collection: 'orders' },
    api: p => `https://test.myshopify.com/${p}`,
    request: async url => {
      calls.push(url);
      const second = url.endsWith('/page2');
      return { data: { orders: [{ id: second ? '2' : '1' }] }, headers: new Headers(second ? {} : {
        link: '<https://test.myshopify.com/page2>; rel="next"',
      }) };
    } };
  assert.equal(await reconcileUpdatedOrders(ctx, { services, now: clock }), 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /updated_at_min=2026-11-07/);
  assert.equal(ctx.jobs.docs.length, 2);
  const state = ctx.db.collection('orders_import_state');
  assert.equal(+state.docs[0].lastCompletedAt, +clock());
  calls.length = 0;
  await reconcileUpdatedOrders(ctx, { services, now: clock });
  const start = new URL(calls[0]).searchParams.get('updated_at_min');
  assert.equal(start, '2026-11-07T23:55:00.000Z');
});
test('failed recovery queue writes do not advance the watermark', async () => {
  const ctx = memoryContext(); ctx.jobs.failBulk = true;
  const services = { ...shared, config: { shop: 'test.myshopify.com', collection: 'orders' },
    api: p => `https://test.myshopify.com/${p}`,
    request: async () => ({ data: { orders: [{ id: '1' }] }, headers: new Headers() }) };
  await assert.rejects(reconcileUpdatedOrders(ctx, { services, now: clock }), /write failure/);
  assert.equal(ctx.db.collection('orders_import_state').docs.length, 0);
});
