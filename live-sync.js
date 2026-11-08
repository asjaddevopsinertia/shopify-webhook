'use strict';
const shared = require('./import-orders');

const defaultPolicy = { pendingMs: 300000, refreshMs: 21600000 };
function pendingDetails(error, now, currency) {
  return { total: null, currency, status: 'pending', fruit: 0, marmalade: 0, unallocated: 0, observed_total: null, shipments: [],
    warnings: [error.message], checked_at: now() };
}

// Called for every live job, regardless of its current cost. Each lookup produces
// a complete replacement calculation; it never increments the previous total.
async function syncOrder(ctx, job, { services = shared, assertLease = () => {}, now = () => new Date(), policy = defaultPolicy } = {}) {
  const id = String(job._id);
  if (!/^\d+$/.test(id)) throw Error('Invalid queued Shopify order ID');
  async function ownership() {
    assertLease();
    const held = await ctx.jobs.findOne({ _id: job._id, owner: job.owner });
    if (!held) throw Error('Order job lease lost');
    return held;
  }
  const { data } = await services.request(services.api(`orders/${id}.json`), 'shopify');
  const order = data.order;
  if (!order || String(order.id) !== id || !Number.isFinite(Date.parse(order.updated_at))) throw Error('Shopify returned no valid matching order snapshot');
  await ownership();
  // Persist creation, payment, refunds and partial/full fulfillment immediately.
  // Existing shipping fields are preserved atomically inside the Mongo pipeline.
  await services.saveOrder(ctx.orders, order, null, undefined, { preserveShipping: true });

  let faireOrder, fees, faireError, feeError;
  if (services.isFaire(order)) {
    try { faireOrder = await services.getFaireOrder(order); }
    catch (error) { faireError = error; feeError = error; }
    if (faireOrder) {
      try { fees = services.faireFees(faireOrder); }
      catch (error) { feeError = error; }
    }
  }
  let details;
  try { details = await services.shippingDetails(order, { faireOrder, faireError }); }
  catch (error) { details = pendingDetails(error, now, services.config.currency); }
  if (details.total !== null && (typeof details.total !== 'number' || !Number.isFinite(details.total) || details.total < 0)) {
    details = pendingDetails(Error('Shipping lookup returned an invalid total'), now, services.config.currency);
  }
  const held = await ownership();
  // A newer webhook must remain due immediately, not be postponed by this job.
  if (held.revision !== job.revision) return { deferred: true, order: order.name || id };
  const current = await ctx.orders.findOne(services.orderFilter(id));
  if (!current) throw Error('Order snapshot was not persisted');
  if (Date.parse(current.updated_at) > Date.parse(order.updated_at)) {
    await ctx.jobs.updateOne({ _id: job._id, owner: job.owner, revision: job.revision }, { $set: { nextRun: now() } });
    return { deferred: true, order: order.name || id };
  }
  const previous = current.real_shipping_cost;
  const known = previous !== null && previous !== undefined && previous !== '' && Number.isFinite(Number(previous)) && Number(previous) >= 0;
  const cost = details.total === null ? (known ? Number(previous) : null) : details.total;
  if (details.total === null && known && Number(previous) > 0) {
    details = { ...details, last_known_total: Number(previous) };
  }
  const fields = { real_shipping_cost: cost, real_shipping_cost_details: details,
    shipping_last_synced_at: now(), shopify_last_synced_at: now() };
  if (fees) {
    fields.faire_fees = fees;
    fields.faire_fee_sync = { status: 'ok', checked_at: now(), last_error: null };
  } else if (feeError) {
    fields.faire_fee_sync = { status: 'pending', checked_at: now(), last_error: feeError.message };
    if (current.faire_fees?.status !== 'reported') fields.faire_fees = {
      status: 'pending', currency: services.config.currency, commission: null, processing_fee: null,
      error: feeError.message, checked_at: now(),
    };
  }
  assertLease();
  const saved = await ctx.orders.updateOne({ _id: current._id, updated_at: current.updated_at,
    real_shipping_cost: current.real_shipping_cost ?? null,
    'real_shipping_cost_details.checked_at': current.real_shipping_cost_details?.checked_at ?? null }, { $set: fields });
  if (!saved.matchedCount) throw Error('Order changed during shipping lookup; retry with the latest snapshot');
  const pending = details.total === null || order.fulfillment_status !== 'fulfilled' || Boolean(feeError) || (fees && !fees.finalized);
  const nextRun = new Date(+now() + (pending ? policy.pendingMs : policy.refreshMs));
  const scheduled = await ctx.jobs.updateOne({ _id: job._id, owner: job.owner, revision: job.revision }, {
    $set: { nextRun, priority: 0, attempts: 0, lastError: null,
      lastShippingError: details.warnings?.join('; ') || null, lastSyncedAt: now() },
  });
  return { order: order.name || id, cost, status: details.status, pending, nextRun,
    deferred: !scheduled.matchedCount, warnings: details.warnings || [] };
}

async function seedPendingOrders(ctx, { services = shared, assertLease = () => {}, now = () => new Date() } = {}) {
  const cursor = ctx.orders.find({ cancelled_at: null }, {
    projection: { id: 1, fulfillment_status: 1, real_shipping_cost: 1, line_items: 1 },
  }).batchSize(500);
  let operations = [], candidates = 0;
  async function flush() {
    if (!operations.length) return;
    assertLease();
    await ctx.jobs.bulkWrite(operations, { ordered: false });
    operations = [];
  }
  for await (const order of cursor) {
    if (order.fulfillment_status === 'fulfilled' && !services.needsShipping(order) && !services.isMixedOrder(order)) continue;
    const id = String(order.id);
    if (!/^\d+$/.test(id)) continue;
    operations.push({ updateOne: { filter: { _id: id }, update: { $setOnInsert: {
      nextRun: now(), priority: 0, lockedUntil: new Date(0), attempts: 0, revision: 0,
    } }, upsert: true } });
    candidates++;
    if (operations.length >= 500) await flush();
  }
  await flush();
  return candidates;
}

// Webhooks can be missed during downtime. Poll updated order IDs with an overlap;
// only advance the durable watermark when every page has been enqueued.
async function reconcileUpdatedOrders(ctx, { services = shared, assertLease = () => {}, now = () => new Date(), lookbackMs = 86400000 } = {}) {
  const state = ctx.db.collection(`${services.config.collection}_import_state`);
  const key = `webhook-reconcile:${services.config.shop}`;
  const previous = await state.findOne({ _id: key });
  const end = now();
  const last = Date.parse(previous?.lastCompletedAt);
  const start = new Date(Number.isFinite(last) && last <= +end ? last - 300000 : +end - lookbackMs);
  const query = new URLSearchParams({ status: 'any', limit: '250', fields: 'id', updated_at_min: start.toISOString(), updated_at_max: end.toISOString() });
  let url = services.api(`orders.json?${query}`), count = 0;
  const visited = new Set();
  while (url) {
    if (visited.has(url)) throw Error('Shopify reconciliation pagination repeated');
    visited.add(url);
    const { data, headers } = await services.request(url, 'shopify');
    if (!Array.isArray(data.orders)) throw Error('Shopify reconciliation returned no orders array');
    const operations = data.orders.map(order => {
      const id = String(order.id);
      if (!/^\d+$/.test(id)) throw Error('Shopify reconciliation returned an invalid order ID');
      return { updateOne: { filter: { _id: id }, update: {
        $set: { nextRun: now(), priority: 1 }, $inc: { revision: 1 },
        $setOnInsert: { lockedUntil: new Date(0), attempts: 0 },
      }, upsert: true } };
    });
    assertLease();
    if (operations.length) await ctx.jobs.bulkWrite(operations, { ordered: false });
    count += operations.length;
    url = services.nextLink(headers);
  }
  assertLease();
  await state.updateOne({ _id: key }, { $set: { lastCompletedAt: end, updatedAt: now() } }, { upsert: true });
  return count;
}

module.exports = { syncOrder, seedPendingOrders, reconcileUpdatedOrders, defaultPolicy };
