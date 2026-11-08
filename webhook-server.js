#!/usr/bin/env node
'use strict';

if (require.main === module) {
  try { process.loadEnvFile(require('node:path').join(__dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Durable HTTPS webhook receiver + live shipping reconciliation. Node.js 22+.
// See README.md for subscriptions, signing secret, proxy and deployment setup.
// Importing this module for tests never opens a socket or connects to MongoDB.
const http = require('node:http');
const { createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const services = require('./import-orders');
const { acquireLease } = require('./import-runner');
const { syncOrder, seedPendingOrders, reconcileUpdatedOrders } = require('./live-sync');
const topics = new Set([
  'orders/create', 'orders/updated', 'orders/paid', 'orders/cancelled',
  'orders/fulfilled', 'orders/partially_fulfilled',
  'fulfillments/create', 'fulfillments/update', 'refunds/create',
]);

function validSignature(body, header, secret) {
  if (typeof header !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(header)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(header, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 10 * 1024 * 1024) throw Object.assign(Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function readOptions(env = process.env) {
  function integer(key, fallback, max) {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < 1 || value > max) throw Error(`${key} must be an integer from 1 through ${max}`);
    return value;
  }
  return {
    workers: integer('WEBHOOK_WORKERS', 2, 4),
    pendingMs: integer('WEBHOOK_PENDING_MINUTES', 5, 1440) * 60000,
    refreshMs: integer('WEBHOOK_REFRESH_MINUTES', 360, 10080) * 60000,
    reconcileMs: integer('WEBHOOK_RECONCILE_MINUTES', 5, 1440) * 60000,
    lookbackMs: integer('WEBHOOK_RECONCILE_LOOKBACK_HOURS', 24, 8760) * 3600000,
    seedPending: !['0', 'false'].includes(String(env.WEBHOOK_SEED_PENDING_ORDERS ?? '1').toLowerCase()),
  };
}
function createRequestHandler(ctx, { secret, apiServices = services, assertLease = () => {}, logError = message => console.error(message) }) {
  if (!secret) throw Error('Shopify webhook signing secret is required');
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        assertLease();
        await ctx.db.command({ ping: 1 });
        res.writeHead(200).end('ok'); return;
      }
      if (req.method !== 'POST' || req.url !== '/webhooks/shopify') { res.writeHead(404).end(); return; }
      const raw = await readBody(req);
      if (!validSignature(raw, req.headers['x-shopify-hmac-sha256'], secret)) { res.writeHead(401).end(); return; }
      if (req.headers['x-shopify-shop-domain'] !== apiServices.config.shop) { res.writeHead(403).end(); return; }
      const topic = req.headers['x-shopify-topic'];
      if (!topics.has(topic)) { res.writeHead(204).end(); return; }
      let payload;
      try { payload = apiServices.JSONbig.parse(raw.toString('utf8')); }
      catch { res.writeHead(400).end('Invalid JSON'); return; }
      const id = String(topic.startsWith('orders/') ? payload.id : payload.order_id);
      if (!/^\d+$/.test(id)) { res.writeHead(400).end('Missing order ID'); return; }
      assertLease();
      // Coalesce by Shopify ID. Duplicate/out-of-order deliveries never add costs;
      // jobs refetch current order state and recalculate all sources from scratch.
      await apiServices.enqueue(ctx.jobs, id);
      res.writeHead(200).end('queued');
    } catch (error) {
      logError(`Webhook: ${error.message}`);
      if (!res.headersSent) res.writeHead(error.status || 503);
      res.end('retry');
    }
  };
}

async function main() {
  const options = readOptions();
  const secret = (process.env.SHOPIFY_WEBHOOK_SECRET || services.config.clientSecret || '').trim();
  if (!secret) throw Error('Set SHOPIFY_WEBHOOK_SECRET to the webhook signing secret, or use the sending app client secret');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be from 1 through 65535');
  const host = process.env.HOST || '127.0.0.1';
  const ctx = await services.connect();
  let lease;
  try { lease = await acquireLease(ctx.db.collection(`${services.config.collection}_import_state`), 'lease:importer'); }
  catch (error) { await ctx.client.close(); throw error; }
  let stopping = false, shutdownPromise;
  const server = http.createServer(createRequestHandler(ctx, { secret, assertLease: lease.assertLease }));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  async function worker() {
    while (!stopping) {
      lease.assertLease();
      let job, heartbeat, renewals = Promise.resolve(), lost = false, expiry;
      const owner = randomUUID();
      function checkLease() {
        lease.assertLease();
        if (lost || Date.now() >= expiry) throw Error('Order job lease lost');
      }
      try {
        expiry = Date.now() + 120000;
        job = await ctx.jobs.findOneAndUpdate(
          { nextRun: { $lte: new Date() }, lockedUntil: { $lte: new Date() } },
          { $set: { owner, lockedUntil: new Date(expiry) } },
          { sort: { priority: -1, nextRun: 1 }, returnDocument: 'after', includeResultMetadata: false },
        );
        if (!job) { await services.sleep(1000); continue; }
        heartbeat = setInterval(() => {
          renewals = renewals.then(async () => {
            try {
              const nextExpiry = Date.now() + 120000;
              const renewed = await ctx.jobs.updateOne({ _id: job._id, owner }, { $set: { lockedUntil: new Date(nextExpiry) } });
              if (!renewed.matchedCount) lost = true; else expiry = nextExpiry;
            } catch { lost = true; }
          });
        }, 30000);
        heartbeat.unref();
        const result = await syncOrder(ctx, job, { assertLease: checkLease, policy: options });
        console.log(result.deferred ? `Newer update queued for ${result.order}; processing again.` :
          `Synced ${result.order}; shipping=${result.cost ?? 'pending'}; status=${result.status}; next check=${result.nextRun.toISOString()}`);
        if (result.warnings?.length) console.warn(`Shipping pending ${result.order}: ${result.warnings.join('; ')}`);
      } catch (error) {
        console.error(`Sync ${job?._id || 'queue'}: ${error.message}`);
        if (job && !lost) {
          try {
            lease.assertLease();
            await ctx.jobs.updateOne({ _id: job._id, owner, revision: job.revision }, {
              $set: { nextRun: new Date(Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(job.attempts || 0, 10))),
                priority: 0, lastError: error.message }, $inc: { attempts: 1 },
            });
          } catch (retryError) { console.error(`Retry scheduling: ${retryError.message}`); }
        }
        await services.sleep(1000);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await renewals;
        if (job) {
          try { await ctx.jobs.updateOne({ _id: job._id, owner }, { $set: { lockedUntil: new Date(0) }, $unset: { owner: '' } }); }
          catch (error) { console.error(`Lease release: ${error.message}`); }
        }
      }
    }
  }
  async function maintenance() {
    let seeded = !options.seedPending, due = 0;
    while (!stopping) {
      lease.assertLease();
      if (Date.now() < due) { await services.sleep(1000); continue; }
      try {
        if (!seeded) {
          const candidates = await seedPendingOrders(ctx, { assertLease: lease.assertLease });
          seeded = true;
          console.log(`Startup recovery checked ${candidates} pending/open/mixed order candidates; existing jobs preserved.`);
        }
        const count = await reconcileUpdatedOrders(ctx, { assertLease: lease.assertLease, lookbackMs: options.lookbackMs });
        console.log(`Recovery scan queued ${count} recently updated Shopify orders.`);
        due = Date.now() + options.reconcileMs;
      } catch (error) {
        console.error(`Recovery: ${error.message}`);
        due = Date.now() + 60000;
      }
    }
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) { await lease.release(); await ctx.client.close(); throw error; }
  console.log(`Listening on ${host}:${port}; ${options.workers} workers; live shipping refresh enabled even for positive costs.`);
  const tasks = [...Array.from({ length: options.workers }, () => worker()), maintenance()];
  const background = Promise.all(tasks);
  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      console.log('Stopping; draining active jobs. MongoDB queue remains durable.');
      await Promise.allSettled([...tasks, new Promise(resolve => server.close(resolve))]);
      await lease.release();
      await ctx.client.close();
    })();
    return shutdownPromise;
  }
  background.catch(error => {
    console.error(`Worker stopped: ${error.message}`);
    process.exitCode = 1;
    shutdown().catch(shutdownError => console.error(shutdownError.message));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown().catch(error => { console.error(error.message); process.exitCode = 1; }));
}

module.exports = { validSignature, readBody, createRequestHandler, readOptions, topics };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
