'use strict';
const { randomUUID } = require('node:crypto');
const { prepareShipstationCache } = require('./shipstation-cache');

async function mapLimit(items, limit, work) {
  if (!Number.isInteger(limit) || limit < 1) throw Error('Concurrency must be a positive integer');
  const results = new Array(items.length);
  let index = 0, failure;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure) {
      const i = index++;
      if (i >= items.length) return;
      try { results[i] = await work(items[i], i); }
      catch (error) { failure = error; }
    }
  });
  // Drain in-flight requests before propagating an error or releasing the lease.
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

function pageFilter(orders, orderFilter) {
  return { id: { $in: orders.flatMap(order => orderFilter(order.id).id.$in) } };
}
function documentMap(documents, needsShipping) {
  const map = new Map();
  for (const doc of documents) {
    const id = String(doc.id), prior = map.get(id);
    // If legacy duplicate types exist, never overwrite a known positive cost.
    if (!prior || (needsShipping(prior) && !needsShipping(doc))) map.set(id, doc);
  }
  return map;
}
const projection = { id: 1, real_shipping_cost: 1, real_shipping_cost_details: 1, faire_fees: 1 };

async function processPage(ctx, orders, { orderFilter, needsShipping, prepareOrder, concurrency, snapshot, log = () => {}, assertLease = () => {} }) {
  if (!orders.length) return { inserted: 0, shipping_updated: 0, fees_updated: 0, skipped: 0, processed: 0 };
  const filter = pageFilter(orders, orderFilter);
  const existing = documentMap(await ctx.orders.find(filter, { projection }).toArray(), needsShipping);
  const cached = snapshot ? await snapshot.forOrders(orders.filter(o => needsShipping(existing.get(String(o.id))))) : null;
  const plans = await mapLimit(orders, concurrency, async order => {
    log(`CHECKING ${order.name || order.id} (id=${order.id})`);
    return prepareOrder(order, existing.get(String(order.id)) || null, undefined, undefined,
      cached ? { shipstationShipments: cached(order) } : {});
  });
  const operations = [], operationIndex = new Map();
  plans.forEach((plan, i) => {
    if (plan.operation) { operationIndex.set(i, operations.length); operations.push(plan.operation); }
  });
  assertLease();
  let writeResult = { upsertedIds: {} };
  if (operations.length) {
    try { writeResult = await ctx.orders.bulkWrite(operations, { ordered: false }); }
    catch (error) {
      // Only insert races are harmless. Any other failure keeps this page's checkpoint.
      const errors = error.writeErrors || [];
      if (!errors.length || errors.some(e => e.code !== 11000 || !operations[e.index]?.updateOne?.upsert)) throw error;
      writeResult = error.result || writeResult;
    }
  }
  // Confirm actual persisted values once for the whole page, including races.
  const saved = documentMap(await ctx.orders.find(filter, { projection }).toArray(), needsShipping);
  const jobs = [];
  const counts = { inserted: 0, shipping_updated: 0, fees_updated: 0, skipped: 0, processed: orders.length };
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i], doc = saved.get(String(order.id));
    if (!doc) throw Error(`Order ${order.id} was not persisted; replay this page`);
    let result = plans[i].result;
    if (result === 'inserted' && !Object.prototype.hasOwnProperty.call(writeResult.upsertedIds || {}, operationIndex.get(i))) result = 'skipped';
    counts[result]++;
    if (result !== 'skipped' && needsShipping(doc)) {
      jobs.push({ updateOne: { filter: { _id: String(order.id) }, update: {
        $set: { nextRun: new Date(Date.now() + 300000), priority: 0 }, $inc: { revision: 1 },
        $setOnInsert: { lockedUntil: new Date(0), attempts: 0 },
      }, upsert: true } });
    }
    const details = doc.real_shipping_cost_details;
    const fees = doc.faire_fees;
    log(`${{ inserted: 'ADDED TO DATABASE', shipping_updated: 'SHIPPING CHECKED', fees_updated: 'FAIRE FEES UPDATED', skipped: 'SKIPPED' }[result]} ${order.name || order.id}` +
      ` | shipping=${doc.real_shipping_cost ?? 'pending'}${details?.status === 'inferred' ? ' (inferred from Faire payout)' : ''}` +
      (fees?.status === 'reported' ? ` | Faire commission=${fees.commission}, processing=${fees.processing_fee} ${fees.currency}` : ''));
    if (result !== 'skipped' && details?.warnings?.length) log(`SHIPPING PENDING ${order.name || order.id}: ${details.warnings.join('; ')}`);
    if (fees?.status === 'pending') log(`FAIRE FEES PENDING ${order.name || order.id}: ${fees.error}`);
  }
  assertLease();
  if (jobs.length) await ctx.jobs.bulkWrite(jobs, { ordered: false });
  return counts;
}

async function acquireLease(state, key) {
  const owner = randomUUID();
  let lost = false, renewing = Promise.resolve(), expires = Date.now() + 120000;
  try {
    await state.findOneAndUpdate({ _id: key, $or: [{ expiresAt: { $lte: new Date() } }, { expiresAt: { $exists: false } }] },
      { $set: { owner, expiresAt: new Date(expires) } }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) throw Error('Another optimized importer is already running. Wait for it to finish or for its lease to expire.');
    throw error;
  }
  const timer = setInterval(() => {
    renewing = renewing.then(async () => {
      try {
        const nextExpiry = Date.now() + 120000;
        const result = await state.updateOne({ _id: key, owner }, { $set: { expiresAt: new Date(nextExpiry) } });
        if (!result.matchedCount) lost = true;
        else expires = nextExpiry;
      } catch { lost = true; }
    });
  }, 30000);
  timer.unref();
  return {
    assertLease() { if (lost || Date.now() >= expires) throw Error('Importer lease lost; stopping before further writes. Checkpoint retained.'); },
    async release() {
      clearInterval(timer);
      await renewing;
      await state.updateOne({ _id: key, owner }, { $set: { expiresAt: new Date(0) }, $unset: { owner: '' } });
    },
  };
}

async function runImport(ctx, services) {
  const { config, request, api, nextLink, log = () => {}, fresh = false } = services;
  const concurrency = services.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw Error('IMPORT_CONCURRENCY must be an integer from 1 through 16');
  const state = ctx.db.collection(`${config.collection}_import_state`);
  const checkpointId = `shopify:${config.shop}:${config.version}`;
  // A collection's shipment cache is shared across shop-specific checkpoints.
  const lease = await (services.acquireLease || acquireLease)(state, 'lease:importer');
  try {
    const snapshot = await (services.prepareCache || prepareShipstationCache)({ request, state,
      collection: ctx.db.collection(`${config.collection}_shipstation_shipments`), log, fresh, assertLease: lease.assertLease });
    let checkpoint = fresh ? null : await state.findOne({ _id: checkpointId });
    if (!checkpoint || checkpoint.status === 'complete') {
      checkpoint = { _id: checkpointId, status: 'running', page: 0, startedAt: new Date(),
        nextUrl: api('orders.json?status=any&limit=250'),
        counts: { inserted: 0, shipping_updated: 0, fees_updated: 0, skipped: 0, processed: 0 } };
      await state.replaceOne({ _id: checkpointId }, checkpoint, { upsert: true });
    }
    let processedPages = 0, restartedCursor = false;
    log(`Starting/resuming Shopify page ${checkpoint.page + 1} with ${concurrency} workers. Positive shipping preserved; Faire fees refreshed.`);
    while (checkpoint.nextUrl) {
      lease.assertLease();
      log(`Fetching Shopify page ${checkpoint.page + 1}...`);
      let response;
      try { response = await request(checkpoint.nextUrl, 'shopify'); }
      catch (error) {
        if (error.status !== 400 || !checkpoint.page || restartedCursor) throw error;
        // Shopify cursors may expire while stopped. Safely replay from the top;
        // insert-only upserts and shipping compare-and-set prevent overwrites.
        restartedCursor = true;
        checkpoint = { ...checkpoint, page: 0, nextUrl: api('orders.json?status=any&limit=250'),
          counts: { inserted: 0, shipping_updated: 0, fees_updated: 0, skipped: 0, processed: 0 } };
        lease.assertLease();
        await state.replaceOne({ _id: checkpointId }, checkpoint);
        log('Saved Shopify cursor expired; restarting the scan safely from page 1.');
        continue;
      }
      const { data, headers } = response;
      if (!Array.isArray(data.orders)) throw Error('Shopify returned no orders array; checkpoint retained');
      const counts = await processPage(ctx, data.orders, { ...services, concurrency, snapshot, assertLease: lease.assertLease });
      lease.assertLease();
      const nextUrl = nextLink(headers);
      checkpoint = { ...checkpoint, page: checkpoint.page + 1, nextUrl, updatedAt: new Date(),
        status: nextUrl ? 'running' : 'complete',
        counts: Object.fromEntries(Object.keys(counts).map(key => [key, (checkpoint.counts[key] || 0) + counts[key]])) };
      // No cursor advance until order writes AND retry queue writes are acknowledged.
      await state.replaceOne({ _id: checkpointId }, checkpoint);
      log(`CHECKPOINT page ${checkpoint.page}: processed=${checkpoint.counts.processed}, added=${checkpoint.counts.inserted}, shipping checked=${checkpoint.counts.shipping_updated}, fees updated=${checkpoint.counts.fees_updated}, skipped=${checkpoint.counts.skipped}`);
      processedPages++;
      if (services.maxPages && processedPages >= services.maxPages && nextUrl) {
        log('Page limit reached; checkpoint saved for the next launch.');
        return checkpoint;
      }
    }
    log(`DONE: ${checkpoint.counts.processed} processed; ${checkpoint.counts.inserted} added; ${checkpoint.counts.shipping_updated} shipping checked; ${checkpoint.counts.fees_updated} Faire fees updated; ${checkpoint.counts.skipped} skipped.`);
    return checkpoint;
  } finally { await lease.release(); }
}

module.exports = { mapLimit, pageFilter, documentMap, processPage, acquireLease, runImport };
