'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createHelpers = require('./shipping-costs');
const { importOrder, orderFilter, needsShipping, faireHeaders } = require('./import-orders');

const fruit = { title: 'Fresh peaches', quantity: 1, sku: 'F' };
const marmalade = { title: 'Orange Fruit Spreads', quantity: 1, sku: 'M' };
const order = { id: '123', name: '#123', order_number: 123, line_items: [fruit, marmalade],
  fulfillments: [
    { tracking_number: 'FRUIT12345', line_items: [fruit] },
    { tracking_number: 'JAM1234567', line_items: [marmalade] },
  ] };
function helpers(request) {
  return createHelpers({ config: { currency: 'USD' }, api: p => `https://shop.test/${p}`, request });
}
function env(t, values) {
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
test('classification uses the supplied product-name rules', () => {
  const h = helpers();
  for (const title of ['Orange marmalades', 'Orange marmalade', 'Peach fruit spread', 'FRUIT SPREADS']) {
    assert.equal(h.category({ title }), 'marmalade');
  }
  assert.equal(h.category(fruit), 'fruit');
});
test('Faire-tagged orders use the shared display order number automatically', () => {
  const h = helpers();
  assert.equal(h.faireId({ tags: 'Faire', name: '#ABC123', order_number: 42 }), 'bo_abc123');
  assert.equal(h.faireId({ tags: 'faire', name: 'bo_ABC123' }), 'bo_abc123');
  assert.equal(h.faireId({ tags: 'faire', order_number: 123 }), 'bo_123');
  assert.equal(h.faireId({ tags: 'retail', name: '#ABC123' }), null);
  assert.equal(h.faireId({ tags: 'faire', name: '#ABC123', note_attributes: [{ name: 'faire_order_id', value: 'bo_override' }] }), 'bo_override');
  assert.equal(h.faireId({ tags: 'faire', name: 'invalid/order' }), null);
});
test('recognizes the screenshot order by its Faire additional detail without a tag', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined, FAIRE_ACCESS_TOKEN: 'test' });
  let queriedFaire = false;
  const h = helpers(async (url, service) => {
    if (service === 'faire') {
      queriedFaire = true;
      assert.match(url, /orders\/bo_csf6yjqss9$/);
      return { data: { id: 'bo_csf6yjqss9', shipments: [] } };
    }
    return { data: { events: [] } };
  });
  const screenshotOrder = { id: '456', name: '#CSF6YJQSS9', tags: '',
    note_attributes: [{ name: 'Faire order number', value: '#CSF6YJQSS9' }],
    line_items: [{ title: 'Cara Cara & Hibiscus Marmalade', quantity: 36 }], fulfillments: [] };
  assert.equal(h.isFaire(screenshotOrder), true);
  assert.equal(h.faireId(screenshotOrder), 'bo_csf6yjqss9');
  assert.equal(h.category(screenshotOrder.line_items[0]), 'marmalade');
  const result = await h.shippingDetails(screenshotOrder);
  assert.equal(queriedFaire, true);
  assert.equal(result.total, null); // Unfulfilled order, no purchased labels yet.
});
test('Faire source/note detection and additional-detail precedence', () => {
  const h = helpers();
  assert.equal(h.isFaire({ source_name: 'Faire' }), true);
  assert.equal(h.isFaire({ note: 'This order was placed on Faire.\nShip ASAP.' }), true);
  assert.equal(h.isFaire({ note: 'Customer asked about Faire pricing' }), false);
  assert.equal(h.isFaire({ source_name: 'web' }), false);
  assert.equal(h.faireId({ name: '#999', note_attributes: [{ name: 'Faire order number', value: '#CSF6YJQSS9' }] }), 'bo_csf6yjqss9');
});
test('sums Shopify marmalade and ShipStation fruit; scans both order names and ignores unrelated events/voids/returns', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test' });
  const calls = [];
  const h = helpers(async (url, service) => {
    calls.push(url);
    if (service === 'shipstation') return { data: { pages: 1, shipments: [
      { shipmentId: 1, orderNumber: new URL(url).searchParams.get('orderNumber'), shipmentCost: 8, trackingNumber: 'FRUIT12345', shipmentItems: [fruit] },
      { shipmentId: 2, orderNumber: '#123', voided: true, shipmentCost: 99 },
      { shipmentId: 3, orderNumber: '#123', isReturnLabel: true, shipmentCost: 99 },
    ] } };
    return { data: { events: [
      { id: 1, message: 'Order was created' },
      { id: 2, message: 'You purchased a $5.25 shipping label. Tracking number: JAM1234567' },
      { id: 3, message: 'Order fulfilled' },
    ] } };
  });
  const details = await h.shippingDetails(order);
  assert.equal(details.total, 13.25);
  assert.equal(details.fruit, 8);
  assert.equal(details.marmalade, 5.25);
  assert.equal(details.shipments.length, 2);
  assert.equal(calls.filter(u => u.includes('ssapi')).length, 2);
});
test('bulk-cached ShipStation parcels produce the same split-shipment total without ShipStation requests', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test' });
  const calls = [];
  const h = helpers(async (url, service) => {
    calls.push(service);
    if (service === 'shipstation') throw Error('Cached lookups must not call ShipStation');
    return { data: { events: [{ id: 1, message: 'You purchased a $5.25 shipping label. Tracking number: JAM1234567' }] } };
  });
  const records = [
    { shipmentId: 1, orderNumber: '#123', shipmentCost: 8, trackingNumber: 'FRUIT12345', shipmentItems: [fruit] },
    { shipmentId: 1, orderNumber: '123', shipmentCost: 8, trackingNumber: 'FRUIT12345', shipmentItems: [fruit] },
    { shipmentId: 2, orderNumber: '#123', shipmentCost: 99, voided: true },
    { shipmentId: 3, orderNumber: '#123', shipmentCost: 99, isReturnLabel: true },
  ];
  const details = await h.shippingDetails(order, { shipstationShipments: records });
  assert.equal(details.total, 13.25);
  assert.equal(details.fruit, 8);
  assert.equal(details.marmalade, 5.25);
  assert.equal(details.shipments.length, 2);
  assert.deepEqual(calls, ['shopify']);
});
test('empty cached results are authoritative, but malformed cached costs cannot produce a partial total', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test' });
  const h = helpers(async (url, service) => {
    assert.equal(service, 'shopify');
    return { data: { events: [{ id: 1, message: 'You purchased a $5 shipping label' }] } };
  });
  const input = { id: '1', name: '#1', line_items: [marmalade] };
  assert.equal((await h.shippingDetails(input, { shipstationShipments: [] })).total, 5);
  const invalid = [{ shipmentId: 1, orderNumber: '#1', shipmentCost: null }];
  const details = await h.shippingDetails(input, { shipstationShipments: invalid });
  assert.equal(details.total, null);
  assert.match(details.warnings.join(), /no valid label cost/);
});
test('Shopify events scan every legacy page and sum purchases from different days', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined });
  const calls = [];
  const h = helpers(async url => {
    calls.push(url);
    if (url.includes('since_id=0')) return { data: { events: Array.from({ length: 250 }, (_, i) => ({
      id: i + 1, message: i === 0 ? 'You purchased a $5 shipping label' : 'Unrelated order update',
    })) } };
    assert.match(url, /since_id=250/);
    return { data: { events: [{ id: 251, message: 'You purchased a shipping label for USD 7.25' }] } };
  });
  assert.equal((await h.shippingDetails({ id: '1', line_items: [marmalade] })).total, 12.25);
  assert.equal(calls.length, 2);
});
test('refund/unparseable warnings do not stop scanning later event pages', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined });
  const h = helpers(async url => url.endsWith('/page2') ? { data: { events: [
    { id: 3, message: 'You purchased a shipping label for $4.25' },
    { id: 3, message: 'You purchased a shipping label for $4.25' },
  ] } } : { data: { events: [
    { id: 1, message: 'You refunded a shipping label' },
    { id: 2, message: 'You purchased a shipping label with an unrecognized amount' },
  ] }, headers: new Headers({ link: '<https://shop.test/page2>; rel="next"' }) });
  const result = await h.shippingDetails({ id: '1', line_items: [marmalade] });
  assert.equal(result.total, null);
  assert.equal(result.observed_total, 4.25);
  assert.equal(result.warnings.length, 2);
});
test('mixed orders can use the confirmed store routing when label events lack tracking', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test' });
  const h = helpers(async (url, service) => service === 'shipstation' ? { data: { pages: 1, shipments: [{
    shipmentId: 1, orderNumber: new URL(url).searchParams.get('orderNumber'), shipmentCost: 8,
  }] } } : { data: { events: [{ id: 1, message: 'You purchased a $5.25 shipping label' }] } });
  const result = await h.shippingDetails({ ...order, fulfillments: [] });
  assert.equal(result.total, 13.25);
  assert.equal(result.fruit, 8);
  assert.equal(result.marmalade, 5.25);
  assert.ok(result.shipments.every(s => s.category_basis === 'store_shipping_rule'));
});
test('confirmed mixed parcel item evidence overrides the store-routing fallback', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test' });
  const h = helpers(async (url, service) => service === 'shipstation' ? { data: { pages: 1, shipments: [{
    shipmentId: 1, orderNumber: new URL(url).searchParams.get('orderNumber'), shipmentCost: 8,
    shipmentItems: [fruit, marmalade],
  }] } } : { data: { events: [] } });
  const result = await h.shippingDetails({ ...order, fulfillments: [] });
  assert.equal(result.total, null);
  assert.equal(result.shipments[0].category, 'unallocated');
  assert.equal(result.shipments[0].category_basis, undefined);
});
test('Faire costs use minor units and deduplicate a parcel already in ShipStation', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test', FAIRE_ACCESS_TOKEN: 'test' });
  const h = helpers(async (url, service) => {
    if (service === 'faire') {
      assert.match(url, /orders\/bo_abc123$/);
      return { data: { id: 'bo_abc123', shipments: [{ id: 's_1', tracking_code: 'FRUIT12345', maker_cost: { amount_minor: 800, currency: 'USD' } }] } };
    }
    if (service === 'shipstation') return { data: { shipments: [{ shipmentId: 1, orderNumber: new URL(url).searchParams.get('orderNumber'), shipmentCost: 8, trackingNumber: 'FRUIT12345', shipmentItems: [fruit] }] } };
    return { data: { events: [] } };
  });
  const details = await h.shippingDetails({ ...order, line_items: [fruit], fulfillments: [], tags: 'wholesale, Faire', note_attributes: [{ name: 'faire_order_id', value: '#ABC123' }] });
  assert.equal(details.total, 8);
  assert.equal(details.shipments.length, 1);
});
test('Faire-only costs work, and missing credentials/ID or currency mismatch stay pending', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined, FAIRE_ACCESS_TOKEN: 'test', FAIRE_OAUTH_ACCESS_TOKEN: undefined });
  let currency = 'USD';
  const h = helpers(async (url, service) => service === 'faire'
    ? { data: { id: 'bo_abc', shipments: [{ id: 's1', tracking_code: 'TRACK12345', maker_cost: { amount_minor: 425, currency } }] } }
    : { data: { events: [] } });
  const input = { id: '1', tags: 'faire', line_items: [marmalade], note_attributes: [{ name: 'faire_order_id', value: 'bo_abc' }] };
  assert.equal((await h.shippingDetails(input)).total, 4.25);
  currency = 'EUR';
  assert.equal((await h.shippingDetails(input)).total, null);
  assert.match((await h.shippingDetails({ ...input, note_attributes: [] })).warnings.join(), /faire_order_id/);
  delete process.env.FAIRE_ACCESS_TOKEN;
  assert.match((await h.shippingDetails(input)).warnings.join(), /FAIRE_ACCESS_TOKEN/);
});
test('mixed orders with missing costs or unassignable labels stay pending', () => {
  const h = helpers();
  const partial = h.summarize(order, [{ source: 'shipstation', id: '1', tracking_number: 'FRUIT12345', cost: 8, category: 'fruit' }]);
  assert.equal(partial.total, null);
  assert.equal(partial.observed_total, 8);
  assert.equal(h.summarize(order, [{ source: 'shopify', id: '1', tracking_number: null, cost: 8, category: 'unallocated' }]).total, null);
});
test('cross-source Faire costs lacking tracking are not blindly summed', () => {
  const details = helpers().summarize({ line_items: [fruit] }, [
    { source: 'shipstation', id: '1', tracking_number: null, cost: 8, category: 'fruit' },
    { source: 'faire', id: '2', tracking_number: null, cost: 8, category: 'fruit' },
  ]);
  assert.equal(details.total, null);
});
test('Ship with Faire zero maker costs are unavailable label costs, including order CY429ENTHE', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined, FAIRE_ACCESS_TOKEN: 'test' });
  const h = helpers(async (url, service) => service === 'faire'
    ? { data: { id: 'bo_cy429enthe', shipments: Array.from({ length: 5 }, (_, i) => ({
      id: `s_${i}`, tracking_code: `TRACKING${i}`, shipping_type: 'SHIP_WITH_FAIRE',
      maker_cost: { amount_minor: 0, currency: 'USD' },
    })) } } : { data: { events: [] } });
  const result = await h.shippingDetails({ id: '123', name: '#CY429ENTHE', tags: 'Faire, Marmalade', line_items: [marmalade] });
  assert.equal(result.total, null);
  assert.equal(result.observed_total, null);
  assert.equal(result.status, 'pending');
  assert.equal(result.shipments.length, 5);
  assert.ok(result.shipments.every(s => s.cost === null && s.cost_status === 'unavailable_from_faire_api'));
  assert.match(result.warnings.join(), /maker_cost is not the label total/);
});
test('a verified label seller can supply costs for the same Ship with Faire parcel', () => {
  const result = helpers().summarize({ line_items: [marmalade] }, [
    { source: 'shipstation', id: 'ss1', tracking_number: 'TRACK123', cost: 50.10, category: 'marmalade' },
    { source: 'faire', id: 'f1', tracking_number: 'TRACK123', cost: null, category: 'marmalade' },
  ]);
  assert.equal(result.total, 50.10);
  assert.equal(result.shipments.length, 1);
  assert.deepEqual(result.warnings, []);
});
function settledFaireOrder() {
  const money = amount_minor => ({ amount_minor, currency: 'USD' });
  return { id: 'bo_6qstbz7cte', state: 'DELIVERED', is_free_shipping: true,
    free_shipping_reason: 'FREE_SHIPPING_THRESHOLD', payment_initiated_at: '2026-10-29T01:52:38.000Z',
    payout_costs: { subtotal_after_brand_discounts: money(46872), commission: money(7031),
      payout_fee: money(1671), total_payout: money(34174), payout_protection_fee: money(0),
      damaged_and_missing_items: money(0), net_tax: money(0), shipping_subsidy: money(0), taxes: [],
      commission_flat_fee: money(0), payout_flat_fee: money(30) },
    shipments: Array.from({ length: 4 }, (_, i) => ({ id: `s_${i}`, carrier: 'fedex',
      tracking_code: `PARCEL${i}`, shipping_type: 'SHIP_WITH_FAIRE', maker_cost: money(0) })) };
}
test('settled brand-funded shipping is inferred once for all Faire parcels with an audit trail', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined, FAIRE_ACCESS_TOKEN: 'test' });
  const data = settledFaireOrder();
  const h = helpers(async (url, service) => ({ data: service === 'faire' ? data : { events: [] } }));
  const result = await h.shippingDetails({ id: '1', name: '#6QSTBZ7CTE', tags: 'Faire', line_items: [marmalade],
    fulfillments: data.shipments.map(s => ({ tracking_number: s.tracking_code })) });
  assert.equal(result.total, 39.96);
  assert.equal(result.marmalade, 39.96);
  assert.equal(result.status, 'inferred');
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].parcels.length, 4);
  assert.equal(result.shipments[0].payout_reconciliation.inputs_minor.total_payout, 34174);
  assert.deepEqual(result.warnings, []);
  data.payout_costs.subtotal_after_brand_discounts.amount_minor = 60264;
  data.payout_costs.commission.amount_minor = 0;
  data.payout_costs.payout_fee.amount_minor = 2139;
  data.payout_costs.total_payout.amount_minor = 53115;
  assert.equal(h.payoutShipping(data).cost, 50.10); // CY429ENTHE screenshot amount.
});
test('payout inference excludes retailer/ Faire-funded, unsettled, adjusted or ambiguous orders', () => {
  const h = helpers();
  const mutations = [
    d => { d.is_free_shipping = false; },
    d => { d.free_shipping_reason = 'INSIDER_FREE_SHIPPING'; },
    d => { d.payment_initiated_at = null; },
    d => { d.state = 'CANCELED'; },
    d => { d.shipments[0].shipping_type = 'SHIP_ON_YOUR_OWN'; },
    d => { d.payout_costs.damaged_and_missing_items.amount_minor = 100; },
    d => { d.payout_costs.shipping_subsidy.amount_minor = 100; },
    d => { d.payout_costs.net_tax.amount_minor = 100; },
    d => { d.payout_costs.commission.currency = 'CAD'; },
    d => { delete d.payout_costs.payout_fee; },
    d => { d.payout_costs.new_adjustment = { amount_minor: 100, currency: 'USD' }; },
    d => { d.payout_costs.total_payout.amount_minor = 99999; },
    d => { d.payout_costs.taxes = [{ amount_minor: 100, currency: 'USD' }]; },
  ];
  for (const mutate of mutations) {
    const data = settledFaireOrder(); mutate(data);
    assert.equal(h.payoutShipping(data), null);
  }
});
test('payout totals deduplicate mirrored tracking and add independently shipped fruit', () => {
  const aggregate = { source: 'faire', id: 'payout:test', method: 'faire_payout_residual',
    cost_status: 'inferred', cost: 39.96, category: 'marmalade', tracking_number: null,
    tracking_numbers: ['JAM12345'], tracking_complete: true };
  const mirror = { source: 'shipstation', id: 'ss1', tracking_number: 'JAM12345', cost: 39.96, category: 'marmalade' };
  const fruitLabel = { source: 'shipstation', id: 'ss2', tracking_number: 'FRUIT12345', cost: 8, category: 'fruit' };
  const h = helpers();
  assert.equal(h.summarize({ line_items: [marmalade] }, [mirror, aggregate]).total, 39.96);
  const mixed = h.summarize({ line_items: [marmalade, fruit] }, [mirror, fruitLabel, aggregate]);
  assert.equal(mixed.total, 47.96);
  assert.equal(mixed.fruit, 8);
  assert.equal(mixed.marmalade, 39.96);
  assert.equal(h.summarize({ line_items: [marmalade] }, [{ ...mirror, tracking_number: null }, aggregate]).total, null);
});
test('Faire fees store total commission/processing and included flat fees without double counting', () => {
  const h = helpers(), data = settledFaireOrder();
  Object.assign(data.payout_costs, { commission: { amount_minor: 3009, currency: 'USD' },
    commission_flat_fee: { amount_minor: 1000, currency: 'USD' }, commission_bps: 1500,
    payout_fee: { amount_minor: 499, currency: 'USD' }, payout_fee_bps: 350 });
  const fees = h.faireFees(data);
  assert.equal(fees.commission, 30.09);
  assert.equal(fees.commission_variable_fee, 20.09);
  assert.equal(fees.commission_flat_fee, 10);
  assert.equal(fees.commission_percentage, 15);
  assert.equal(fees.processing_fee, 4.99);
  assert.equal(fees.processing_variable_fee, 4.69);
  assert.equal(fees.processing_flat_fee, 0.30);
  assert.equal(fees.processing_fee_percentage, 3.5);
  assert.equal(fees.total_fees, 35.08);
  assert.equal(fees.finalized, true);
  data.payout_costs.commission.currency = 'CAD';
  assert.throws(() => h.faireFees(data), /currency mismatched/);
});
test('existing positive shipping stays unchanged while Faire fees are added', async () => {
  const writes = [];
  const ctx = { orders: { findOne: async () => ({ _id: 'x', real_shipping_cost: 8 }),
    updateOne: async (...args) => writes.push(args) } };
  assert.equal(await importOrder(ctx, { ...order, tags: 'Faire' },
    () => { throw Error('Shipping lookup must not run'); }, async () => settledFaireOrder()), 'fees_updated');
  assert.deepEqual(Object.keys(writes[0][1].$set), ['faire_fees']);
  assert.equal(writes[0][1].$set.faire_fees.commission, 70.31);
});
test('new Faire orders share fetched data with shipping and include reported fees', async () => {
  const data = settledFaireOrder(), writes = [];
  const ctx = { orders: { findOne: async () => null,
    updateOne: async (...args) => { writes.push(args); return { upsertedCount: 1 }; } } };
  let fetched = 0;
  assert.equal(await importOrder(ctx, { ...order, tags: 'Faire' }, async (o, options) => {
    assert.equal(options.faireOrder, data);
    return { total: 39.96 };
  }, async () => { fetched++; return data; }), 'inserted');
  assert.equal(fetched, 1);
  assert.equal(writes[0][1].$setOnInsert.faire_fees.processing_fee, 16.71);
});
test('temporary Faire failure preserves existing reported fees', async () => {
  const reported = { status: 'reported', commission: 30, processing_fee: 5 }, writes = [];
  const ctx = { orders: { findOne: async () => ({ _id: 'x', real_shipping_cost: 8, faire_fees: reported }),
    updateOne: async (...args) => writes.push(args) } };
  await importOrder(ctx, { ...order, tags: 'Faire' }, null, async () => { throw Error('HTTP 503'); });
  assert.equal(writes[0][1].$set.faire_fees, reported);
});
test('unparseable purchases, refunded labels and API failures cannot create a partial final cost', async t => {
  env(t, { SHIPSTATION_API_KEY: 'test' });
  for (const message of ['You purchased a shipping label for EUR 5', 'You refunded a shipping label']) {
    const h = helpers(async (url, service) => service === 'shipstation'
      ? { data: { shipments: [] } } : { data: { events: [{ id: 1, message }] } });
    const details = await h.shippingDetails({ id: '1', name: '#1', order_number: 1, line_items: [fruit] });
    assert.equal(details.total, null);
    assert.equal(details.warnings.length, 1);
  }
  const h = helpers(async (url, service) => {
    if (service === 'shipstation') throw Error('HTTP 503');
    return { data: { events: [{ id: 1, message: 'You purchased a $4 shipping label' }] } };
  });
  assert.equal((await h.shippingDetails({ id: '1', name: '#1', order_number: 1, line_items: [fruit] })).total, null);
});
test('existing positive costs skip all shipping requests and database writes', async () => {
  const result = await importOrder({ orders: { findOne: async () => ({ _id: 'x', real_shipping_cost: 8 }) } }, order,
    () => { throw Error('Lookup must not run'); });
  assert.equal(result, 'skipped');
});
test('existing zero/null/missing shipping is updated without rewriting the order', async () => {
  for (const cost of [0, null, undefined, '0']) {
    const writes = [];
    const existing = { _id: 'x', id: 123, real_shipping_cost: cost, note: 'preserve' };
    const ctx = { orders: { findOne: async () => existing, updateOne: async (...args) => { writes.push(args); } } };
    assert.equal(await importOrder(ctx, order, async () => ({ total: 7 })), 'shipping_updated');
    assert.deepEqual(Object.keys(writes[0][1].$set), ['real_shipping_cost', 'real_shipping_cost_details']);
    assert.equal(writes[0][0]._id, 'x');
    assert.equal(writes[0][0].real_shipping_cost, cost ?? null);
  }
});
test('missing orders use insert-only upserts and concurrent duplicate inserts are harmless', async () => {
  const writes = [];
  const ctx = { orders: { findOne: async () => null, updateOne: async (...args) => { writes.push(args); return { upsertedCount: 1 }; } } };
  assert.equal(await importOrder(ctx, order, async () => ({ total: 5 })), 'inserted');
  assert.equal(writes[0][1].$setOnInsert.id, '123');
  assert.equal(writes[0][2].upsert, true);
  assert.equal(writes[0][1].$set, undefined);
  ctx.orders.updateOne = async () => { throw Object.assign(Error('duplicate'), { code: 11000 }); };
  assert.equal(await importOrder(ctx, order, async () => ({ total: 5 })), 'skipped');
});
test('legacy numeric and large integer IDs are matched without precision loss', () => {
  assert.ok(orderFilter('123').id.$in.includes(123));
  assert.ok(orderFilter('9007199254740993').id.$in.some(v => v?._bsontype === 'Long' && v.toString() === '9007199254740993'));
  assert.equal(needsShipping({ real_shipping_cost: 10 }), false);
});

test('single-brand Faire token works with leftover OAuth app credentials', () => {
  assert.deepEqual(faireHeaders({ FAIRE_ACCESS_TOKEN: ' brand-token ', FAIRE_APP_CREDENTIALS: 'unused' }),
    { 'X-FAIRE-ACCESS-TOKEN': 'brand-token' });
  assert.deepEqual(faireHeaders({ FAIRE_ACCESS_TOKEN: 'brand-token', FAIRE_OAUTH_ACCESS_TOKEN: 'unused' }),
    { 'X-FAIRE-ACCESS-TOKEN': 'brand-token' });
});
test('OAuth requires a complete pair when no single-brand token is supplied', () => {
  assert.throws(() => faireHeaders({ FAIRE_APP_CREDENTIALS: 'app' }), /FAIRE_OAUTH_ACCESS_TOKEN/);
  assert.throws(() => faireHeaders({ FAIRE_OAUTH_ACCESS_TOKEN: 'oauth' }), /FAIRE_APP_CREDENTIALS/);
  assert.deepEqual(faireHeaders({ FAIRE_OAUTH_ACCESS_TOKEN: 'oauth', FAIRE_APP_CREDENTIALS: 'app' }),
    { 'X-FAIRE-OAUTH-ACCESS-TOKEN': 'oauth', 'X-FAIRE-APP-CREDENTIALS': 'app' });
  assert.deepEqual(faireHeaders({}), {});
});

const createManualShipping = require('./manual-shipping');
const { parseComment } = createManualShipping;
test('manual whole-order shipping applies to mixed orders without guessing a split or adding labels', () => {
  const parsed = parseComment({ id: 'comment1', rawMessage: 'We paid $51.36 for shipping' }, order, 'USD');
  assert.equal(parsed.record.scope, 'order_total');
  const result = helpers().summarize(order, [
    { source: 'shopify', id: 'label1', cost: 12, category: 'marmalade', tracking_number: 'JAM1234567' }, parsed.record
  ], ['Faire lookup failed']);
  assert.equal(result.total, 51.36);
  assert.equal(result.unallocated, 51.36);
  assert.equal(result.fruit, 0);
  assert.equal(result.marmalade, 0);
  assert.equal(result.excluded_shipments.length, 1);
  assert.deepEqual(result.lookup_warnings, ['Faire lookup failed']);
});
test('manual shipping ignores estimates, negation, questions and retailer payments', () => {
  for (const text of ['Customer paid $10 for shipping', 'We have not paid $10 for shipping',
    'We paid $10 for shipping?', 'We paid $10 for shipping but it was refunded', 'We will pay $10 for shipping']) {
    assert.equal(parseComment({ id: '1', rawMessage: text }, order, 'USD'), null);
  }
  assert.ok(parseComment({ id: '1', rawMessage: 'We paid $10 for shipping and $5 for insurance' }, order, 'USD').warning);
  assert.ok(parseComment({ id: '1', rawMessage: 'We paid $10 for shipping CAD' }, order, 'USD').warning);
});
test('manual parcel comments deduplicate matching labels and flag conflicting amounts', () => {
  const comment = parseComment({ id: 'c1', rawMessage: 'We paid $12 for marmalade shipping tracking: JAM1234567' }, order, 'USD').record;
  const records = [{ source: 'shopify', id: 's1', tracking_number: 'JAM1234567', cost: 12, category: 'marmalade' },
    { source: 'shipstation', id: 's2', tracking_number: 'FRUIT12345', cost: 8, category: 'fruit' }, comment];
  assert.equal(helpers().summarize(order, records).total, 20);
  assert.equal(helpers().summarize(order, [...records.slice(0, 2), { ...comment, cost: 14 }]).total, null);
});
test('multiple manual totals stay pending instead of adding or guessing', () => {
  const records = [10, 20].map((cost, i) => parseComment({ id: String(i), rawMessage: `We paid $${cost} for shipping` }, order, 'USD').record);
  assert.equal(helpers().summarize(order, records).total, null);
  assert.equal(helpers().summarize({ ...order, line_items: [fruit] }, [records[0]]).fruit, 10);
});
test('comment API follows pages, deduplicates IDs and uses raw staff comment text', async () => {
  let calls = 0;
  const comment = { __typename: 'CommentEvent', id: 'c1', rawMessage: 'We paid $25.50 for shipping' };
  const lookup = createManualShipping({ config: { currency: 'USD' }, api: p => p,
    request: async (url, service, body) => {
      assert.equal(url, 'graphql.json');
      assert.equal(service, 'shopify');
      assert.equal(body.variables.id, 'gid://shopify/Order/123');
      assert.equal(body.variables.after, calls ? 'cursor1' : null);
      calls++;
      return { data: { data: { order: { events: { nodes: [comment, { __typename: 'BasicEvent', id: 'b1' }],
        pageInfo: { hasNextPage: calls === 1, endCursor: 'cursor1' } } } } } };
    } });
  const result = await lookup(order);
  assert.equal(calls, 2);
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].cost, 25.5);
});
test('comment query failures are surfaced rather than treated as no comments', async () => {
  const lookup = createManualShipping({ config: { currency: 'USD' }, api: p => p,
    request: async () => ({ data: { errors: [{ message: 'Access denied' }] } }) });
  await assert.rejects(lookup(order), /shipping comments query failed/);
});
test('shipping lookup invokes comments and uses their complete order total', async t => {
  env(t, { SHIPSTATION_API_KEY: undefined });
  const h = createHelpers({ config: { currency: 'USD' }, api: p => p,
    request: async () => ({ data: { events: [] } }),
    comments: async () => ({ shipments: [parseComment({ id: 'c1', rawMessage: 'We paid $34 for shipping' }, order, 'USD').record], warnings: [] }) });
  assert.equal((await h.shippingDetails(order)).total, 34);
});
