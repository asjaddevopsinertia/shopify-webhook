#!/usr/bin/env node
'use strict';

// Load beside the script, including when launched from another directory.
// Node preserves environment variables already supplied by the caller.
if (require.main === module) {
  try { process.loadEnvFile(require('node:path').join(__dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/*
 * SCRIPT 1 — Shopify -> MongoDB import, also shared helpers for script 2.
 * Node.js 22+; npm install mongodb json-bigint
 * Run: node --env-file=.env import-orders.js
 *
 * Required environment:
 * SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
 * SHOPIFY_CLIENT_ID=your-app-client-id
 * SHOPIFY_CLIENT_SECRET=your-app-client-secret
 * MONGODB_URI=mongodb://127.0.0.1:27017
 * MONGODB_DB=shopify
 * Optional:
 * SHOPIFY_API_VERSION=2026-10
 * MONGODB_COLLECTION=orders
 * SHIPSTATION_API_KEY=...
 * SHIPSTATION_API_SECRET=...
 * SHIPPING_COST_CURRENCY=USD    (ShipStation account's label currency)
 *
 * Needs read_orders and approved read_all_orders to import beyond 60 days.
 * Uses legacy REST API to retain the complete REST order shape from reference.
 * real_shipping_cost is a Number in SHIPPING_COST_CURRENCY, or null if unresolved.
 * real_shipping_cost_details contains category totals and deduplicated shipments.
 * Shipping charged to the customer is NEVER used as actual label cost.
 * ShipStation v1 shipmentCost excludes insuranceCost. All nonvoided parcels
 * are summed alongside Shopify label purchases (event parsing is USD only).
 * MongoDB id is normalized to a string; other REST fields are retained.
 * Reruns insert missing orders and check shipping only for zero/null/missing costs.
 * Positive existing costs are deliberately left unchanged, including old partial totals.
 */

const { MongoClient } = require('mongodb');
const JSONbig = require('json-bigint')({ storeAsString: true, protoAction: 'error', constructorAction: 'error' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = {
  shop: (process.env.SHOPIFY_SHOP_DOMAIN || '').trim().toLowerCase(),
  clientId: (process.env.SHOPIFY_CLIENT_ID || '').trim(),
  clientSecret: (process.env.SHOPIFY_CLIENT_SECRET || '').trim(),
  version: process.env.SHOPIFY_API_VERSION || '2026-10',
  uri: process.env.MONGODB_URI,
  db: process.env.MONGODB_DB || process.env.ORDERS_DB_NAME || 'shopify',
  collection: process.env.MONGODB_COLLECTION || process.env.ORDERS_COLLECTION || 'orders',
  currency: process.env.SHIPPING_COST_CURRENCY || 'USD',
};
const shopifyAuth = require('./shopify-auth').createShopifyAuth(config);

function validate() {
  if (!config.shop) throw Error('SHOPIFY_SHOP_DOMAIN is missing. Set it in the .env file beside import-orders.js or in the process environment.');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(config.shop)) throw Error('Set SHOPIFY_SHOP_DOMAIN to your-store.myshopify.com (no https://).');
  shopifyAuth.validate();
  if (!config.uri) throw Error('MONGODB_URI is required.');
  const key = process.env.SHIPSTATION_API_KEY;
  const secret = process.env.SHIPSTATION_API_SECRET;
  if (Boolean(key) !== Boolean(secret)) throw Error('Supply both ShipStation credentials.');
  faireHeaders();
}

function faireHeaders(env = process.env) {
  const token = (env.FAIRE_ACCESS_TOKEN || '').trim();
  // Single-brand authentication is sufficient; ignore unused OAuth settings.
  if (token) return { 'X-FAIRE-ACCESS-TOKEN': token };
  const oauth = (env.FAIRE_OAUTH_ACCESS_TOKEN || '').trim();
  const credentials = (env.FAIRE_APP_CREDENTIALS || '').trim();
  if (Boolean(oauth) !== Boolean(credentials)) {
    throw Error('Faire OAuth requires both FAIRE_OAUTH_ACCESS_TOKEN and FAIRE_APP_CREDENTIALS. For single-brand authentication, set FAIRE_ACCESS_TOKEN instead.');
  }
  return oauth ? { 'X-FAIRE-OAUTH-ACCESS-TOKEN': oauth, 'X-FAIRE-APP-CREDENTIALS': credentials } : {};
}

// Per-service queues remain safe with multiple concurrent order workers.
const limiter = require('./rate-limit').createRateLimiter({ intervals: { shopify: 550, shipstation: 1600, faire: 1600 } });
async function request(url, service, graphqlBody) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== ({ shopify: config.shop, shipstation: 'ssapi.shipstation.com', faire: 'www.faire.com' })[service]) throw Error('Unexpected API URL');
  let renewedAfter401 = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = service === 'faire'
      ? faireHeaders()
      : service === 'shopify'
      ? { 'X-Shopify-Access-Token': await shopifyAuth.getToken() }
      : { Authorization: `Basic ${Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString('base64')}` };
    let res;
    try {
      res = await limiter.run(service, async () => {
        const response = await fetch(u, { headers: graphqlBody ? { ...headers, 'Content-Type': 'application/json' } : headers,
          ...(graphqlBody ? { method: 'POST', body: JSON.stringify(graphqlBody) } : {}),
          signal: AbortSignal.timeout(20000), redirect: 'error' });
        limiter.feedback(service, response, attempt);
        return response;
      });
    }
    catch (error) {
      if (attempt === 5) throw error;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }
    if (service === 'shopify' && res.status === 401 && !renewedAfter401) {
      await res.body?.cancel();
      shopifyAuth.invalidate(headers['X-Shopify-Access-Token']);
      renewedAfter401 = true;
      attempt--; // One auth renewal, independent of transient-error retry budget.
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 5) throw Error(`${service} HTTP ${res.status}: retries exhausted`);
      const retry = res.headers.get('retry-after');
      const delay = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : 1000 * 2 ** attempt;
      await res.body?.cancel();
      if (res.status !== 429) await sleep(Math.min(30000, Math.max(1000, delay)));
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); const e = Error(`${service} HTTP ${res.status}`); e.status = res.status; throw e; }
    return { data: JSONbig.parse(await res.text()), headers: res.headers };
  }
}

function api(path) { return `https://${config.shop}/admin/api/${config.version}/${path}`; }
function nextLink(headers) {
  return headers.get('link')?.split(',').map(s => s.trim()).find(s => /rel="next"/.test(s))?.match(/<([^>]+)>/)?.[1] || null;
}

async function connect() {
  validate();
  // Fail authentication before opening MongoDB or creating indexes.
  await shopifyAuth.getToken();
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 3000, socketTimeoutMS: 10000, retryWrites: true });
  await client.connect();
  const db = client.db(config.db);
  const orders = db.collection(config.collection);
  const jobs = db.collection(`${config.collection}_sync_jobs`);
  await orders.createIndex({ id: 1 }, { unique: true });
  await jobs.createIndex({ priority: -1, nextRun: 1, lockedUntil: 1 });
  return { client, db, orders, jobs };
}

const comments = require('./manual-shipping')({ request, api, config });
const { shippingDetails, shippingCost, isFaire, isMixedOrder, getFaireOrder, faireFees } = require('./shipping-costs')({ request, api, config, comments });

async function saveOrder(orders, order, cost, details, { preserveShipping = false } = {}) {
  const id = String(order.id);
  const document = { ...order, id };
  delete document._id;
  if (!preserveShipping) {
    document.real_shipping_cost = cost;
    if (details) document.real_shipping_cost_details = details;
  } else {
    delete document.real_shipping_cost;
    delete document.real_shipping_cost_details;
    delete document.faire_fees;
  }
  // Prevent older imports/API snapshots overwriting a newer webhook snapshot.
  try {
    await orders.updateOne(
      orderFilter(id),
      [{ $replaceWith: { $cond: [
        { $lte: [{ $convert: { input: '$updated_at', to: 'date', onError: new Date(0), onNull: new Date(0) } }, new Date(order.updated_at)] },
        { $mergeObjects: [{ real_shipping_cost: null }, '$$ROOT', { $literal: document }] },
        '$$ROOT',
      ] } }],
      { upsert: true },
    );
  } catch (e) { if (e.code !== 11000) throw e; else throw Error(`Concurrent write for order ${id}; retry import`); }
}

async function enqueue(jobs, id, when = new Date(), priority = 1) {
  await jobs.updateOne({ _id: String(id) }, {
    $set: { nextRun: when, priority },
    $inc: { revision: 1 },
    $setOnInsert: { lockedUntil: new Date(0), attempts: 0 },
  }, { upsert: true });
}

// Match legacy numeric IDs too, without rounding large Shopify IDs.
function orderFilter(id) {
  const stringId = String(id);
  const ids = [stringId];
  if (/^\d+$/.test(stringId)) {
    const { Long, Decimal128 } = require('mongodb');
    if (BigInt(stringId) <= 9223372036854775807n) ids.push(Long.fromString(stringId));
    ids.push(Decimal128.fromString(stringId));
    if (Number.isSafeInteger(Number(stringId))) ids.push(Number(stringId));
  }
  return { id: { $in: ids } };
}
function needsShipping(existing) {
  return !existing || existing.real_shipping_cost == null ||
    existing.real_shipping_cost === 0 || existing.real_shipping_cost === '0';
}
async function updateShipping(orders, existing, details, fees) {
  // Compare-and-set prevents overwriting another worker's newly resolved cost.
  const filter = { _id: existing._id, real_shipping_cost: existing.real_shipping_cost ?? null };
  return orders.updateOne(filter, { $set: { real_shipping_cost: details.total,
    real_shipping_cost_details: details, ...(fees ? { faire_fees: fees } : {}) } });
}
async function prepareOrder(order, existing, lookup = shippingDetails, faireLookup = getFaireOrder, shippingOptions = {}) {
  let faireOrder, fees, faireError;
  if (isFaire(order)) {
    try {
      faireOrder = await faireLookup(order);
      fees = faireFees(faireOrder);
    } catch (error) {
      if (!faireOrder) faireError = error;
      // Keep previously reported fees through a temporary lookup failure.
      fees = existing?.faire_fees?.status === 'reported' ? existing.faire_fees : {
        status: 'pending', currency: config.currency, commission: null, processing_fee: null,
        error: error.message, checked_at: new Date(),
      };
    }
  }
  if (existing && !needsShipping(existing)) {
    if (!fees) return { result: 'skipped', operation: null };
    return { result: 'fees_updated', operation: { updateOne: {
      filter: { _id: existing._id }, update: { $set: { faire_fees: fees } },
    } } };
  }
  const details = await lookup(order, { ...shippingOptions, faireOrder, faireError });
  if (existing) {
    return { result: 'shipping_updated', operation: { updateOne: {
      filter: { _id: existing._id, real_shipping_cost: existing.real_shipping_cost ?? null },
      update: { $set: { real_shipping_cost: details.total, real_shipping_cost_details: details,
        ...(fees ? { faire_fees: fees } : {}) } },
    } } };
  }
  const document = { ...order, id: String(order.id), real_shipping_cost: details.total,
    real_shipping_cost_details: details, ...(fees ? { faire_fees: fees } : {}) };
  delete document._id;
  return { result: 'inserted', operation: { updateOne: {
    filter: orderFilter(order.id), update: { $setOnInsert: document }, upsert: true,
  } } };
}
async function importOrder(ctx, order, lookup = shippingDetails, faireLookup = getFaireOrder) {
  const existing = await ctx.orders.findOne(orderFilter(order.id));
  const plan = await prepareOrder(order, existing, lookup, faireLookup);
  if (!plan.operation) return plan.result;
  const { filter, update, upsert } = plan.operation.updateOne;
  try {
    const result = await ctx.orders.updateOne(filter, update, ...(upsert ? [{ upsert: true }] : []));
    return plan.result === 'inserted' && !result.upsertedCount ? 'skipped' : plan.result;
  } catch (error) {
    if (error.code === 11000 && plan.result === 'inserted') return 'skipped';
    throw error;
  }
}
async function main() {
  const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
  log('Starting optimized import: authenticating with Shopify and connecting to MongoDB...');
  const ctx = await connect();
  try {
    await require('./import-runner').runImport(ctx, {
      config, request, api, nextLink, orderFilter, needsShipping, prepareOrder, log,
      concurrency: Number(process.env.IMPORT_CONCURRENCY || 4), fresh: process.argv.includes('--fresh'),
    });
  } finally { await ctx.client.close(); }
}

module.exports = { faireHeaders, config, connect, request, api, nextLink, saveOrder, shippingCost, shippingDetails, isFaire, isMixedOrder, getFaireOrder, faireFees, needsShipping, orderFilter, updateShipping, prepareOrder, importOrder, enqueue, sleep, JSONbig };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
