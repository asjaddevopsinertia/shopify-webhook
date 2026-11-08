'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareShipstationCache } = require('./shipstation-cache');
const { MemoryCollection, fakeEnvironment } = require('./test-helpers');
const shipment = (id, orderNumber) => ({ shipmentId: id, orderNumber, shipmentCost: 5, trackingNumber: `TRACK${id}`,
  shipmentItems: [{ name: 'Marmalade', sku: 'M', quantity: 1 }], shipTo: { name: 'Must not be cached' } });

test('complete snapshot matches both order-name formats and excludes stale generations and customer data', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: 'test', SHIPSTATION_STORE_ID: '42' });
  const collection = new MemoryCollection([{ _id: 'old', generation: 'old', orderNumber: '#123' }]), state = new MemoryCollection();
  const calls = [];
  const cache = await prepareShipstationCache({ collection, state, request: async url => {
    const params = new URL(url).searchParams;
    calls.push(params);
    assert.equal(params.get('storeId'), '42');
    assert.equal(params.get('includeShipmentItems'), 'true');
    return { data: { pages: 2, total: 3, shipments: params.get('page') === '1'
      ? [shipment(1, '#123'), shipment(2, '123')] : [shipment(3, '#999')] } };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].get('createDateEnd'), calls[1].get('createDateEnd'));
  const lookup = await cache.forOrders([{ name: '#123', order_number: 123 }, { name: '#missing' }]);
  assert.equal(lookup({ name: '#123', order_number: 123 }).length, 2);
  assert.deepEqual(lookup({ name: '#missing' }), []);
  assert.ok(collection.docs.every(doc => !doc.shipTo));
  assert.equal((await state.findOne({ _id: 'shipstation-snapshot' })).complete, true);
});
test('interrupted scan resumes only after the last acknowledged shipment page', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: 'test' });
  const collection = new MemoryCollection(), state = new MemoryCollection();
  await assert.rejects(prepareShipstationCache({ collection, state, request: async url => {
    if (new URL(url).searchParams.get('page') === '2') throw Error('Network outage');
    return { data: { pages: 2, total: 2, shipments: [shipment(1, '#1')] } };
  } }), /Network outage/);
  const checkpoint = await state.findOne({ _id: 'shipstation-snapshot' });
  assert.equal(checkpoint.nextPage, 2);
  assert.equal(checkpoint.complete, false);
  const cache = await prepareShipstationCache({ collection, state, request: async url => {
    assert.equal(new URL(url).searchParams.get('page'), '2');
    return { data: { pages: 2, total: 2, shipments: [shipment(2, '#2')] } };
  } });
  assert.equal(cache.generation, checkpoint.generation);
  assert.equal((await cache.forOrders([{ name: '#1' }]))({ name: '#1' }).length, 1);
});
test('failed shipment writes do not advance the scan checkpoint', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: 'test' });
  const collection = new MemoryCollection(), state = new MemoryCollection();
  collection.failBulk = true;
  await assert.rejects(prepareShipstationCache({ collection, state,
    request: async () => ({ data: { pages: 1, total: 1, shipments: [shipment(1, '#1')] } }) }), /write failure/);
  assert.equal((await state.findOne({ _id: 'shipstation-snapshot' })).nextPage, 1);
});
test('malformed, incomplete or repeating pages never become an authoritative cache', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: 'test' });
  for (const data of [
    { pages: 2, total: 10, shipments: [] },
    { pages: 1, total: 2, shipments: [shipment(1, '#1')] },
    { shipments: [] },
    { pages: 1, total: 2, shipments: [shipment(1, '#1'), shipment(1, '#1')] },
  ]) {
    const state = new MemoryCollection();
    await assert.rejects(prepareShipstationCache({ collection: new MemoryCollection(), state, request: async () => ({ data }) }));
    assert.equal((await state.findOne({ _id: 'shipstation-snapshot' })).complete, false);
  }
  const state = new MemoryCollection();
  await assert.rejects(prepareShipstationCache({ state, collection: new MemoryCollection(),
    request: async () => ({ data: { pages: 2, total: 2, shipments: [shipment(1, '#1')] } }) }), /another page/);
});
test('fresh scans and changed credentials rebuild; immediate restarts reuse complete snapshots', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: 'test' });
  const collection = new MemoryCollection(), state = new MemoryCollection();
  let calls = 0;
  const options = { collection, state, request: async () => { calls++; return { data: { pages: 0, total: 0, shipments: [] } }; } };
  const first = await prepareShipstationCache(options);
  assert.equal((await prepareShipstationCache(options)).generation, first.generation);
  assert.equal(calls, 1);
  assert.notEqual((await prepareShipstationCache({ ...options, fresh: true })).generation, first.generation);
  assert.equal(calls, 2);
  process.env.SHIPSTATION_API_KEY = 'another-account';
  await prepareShipstationCache(options);
  assert.equal(calls, 3);
});
test('missing ShipStation credentials disable the cache without making requests', async t => {
  fakeEnvironment(t, { SHIPSTATION_API_KEY: undefined });
  assert.equal(await prepareShipstationCache({ request: () => { throw Error('Must not call'); } }), null);
});
