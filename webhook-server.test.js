'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHmac } = require('node:crypto');
const { createRequestHandler, validSignature, readOptions } = require('./webhook-server');
const shared = require('./import-orders');
const { memoryContext } = require('./test-helpers');
const secret = 'test-signing-secret';
const sign = body => createHmac('sha256', secret).update(body).digest('base64');
async function deliver(ctx, body, { topic = 'orders/create', shop = 'test.myshopify.com', signature = sign(body), enqueue = shared.enqueue } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST'; req.url = '/webhooks/shopify';
  req.headers = { 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': signature };
  const res = { status: null, body: null, headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; return this; }, end(value) { this.body = value; } };
  await createRequestHandler(ctx, { secret, logError() {}, apiServices: { ...shared, config: { shop: 'test.myshopify.com' }, enqueue } })(req, res);
  return res;
}
test('webhook HMAC validates the exact raw bytes and rejects altered data', () => {
  const raw = Buffer.from('{"id":123}');
  assert.equal(validSignature(raw, sign(raw), secret), true);
  assert.equal(validSignature(Buffer.from('{"id":124}'), sign(raw), secret), false);
  assert.equal(validSignature(raw, 'invalid', secret), false);
});
test('valid creation webhooks queue exact large order IDs before acknowledging', async () => {
  const ctx = memoryContext(); let acknowledgedWrite = false;
  const result = await deliver(ctx, '{"id":9007199254740993}', { enqueue: async (jobs, id) => {
    assert.equal(id, '9007199254740993'); await shared.enqueue(jobs, id); acknowledgedWrite = true;
  } });
  assert.equal(acknowledgedWrite, true);
  assert.equal(result.status, 200);
  assert.equal(ctx.jobs.docs[0]._id, '9007199254740993');
});
test('fulfillment and refund topics queue order_id rather than the resource ID', async () => {
  for (const topic of ['fulfillments/create', 'fulfillments/update', 'refunds/create']) {
    const ctx = memoryContext();
    assert.equal((await deliver(ctx, '{"id":999,"order_id":123}', { topic })).status, 200);
    assert.equal(ctx.jobs.docs[0]._id, '123');
  }
});
test('duplicate deliveries coalesce into one durable job', async () => {
  const ctx = memoryContext();
  await deliver(ctx, '{"id":123}'); await deliver(ctx, '{"id":123}');
  assert.equal(ctx.jobs.docs.length, 1);
  assert.equal(ctx.jobs.docs[0].revision, 2);
});
test('bad signatures, wrong shops, malformed JSON and unsupported topics cannot enqueue orders', async () => {
  for (const [body, options, expected] of [
    ['{"id":123}', { signature: sign('another body') }, 401],
    ['{"id":123}', { shop: 'other.myshopify.com' }, 403],
    ['not-json', {}, 400], ['{"name":"no ID"}', {}, 400],
    ['{"id":123}', { topic: 'products/create' }, 204],
  ]) {
    const ctx = memoryContext();
    assert.equal((await deliver(ctx, body, options)).status, expected);
    assert.equal(ctx.jobs.docs.length, 0);
  }
});
test('queue failures return a retryable response instead of acknowledging lost work', async () => {
  const res = await deliver(memoryContext(), '{"id":123}', { enqueue: async () => { throw Error('Database unavailable'); } });
  assert.equal(res.status, 503);
});
test('oversized requests are rejected before processing', async () => {
  assert.equal((await deliver(memoryContext(), 'x'.repeat(10 * 1024 * 1024 + 1))).status, 413);
});
test('worker/recheck configuration has bounded defaults', () => {
  assert.deepEqual(readOptions({}), { workers: 2, pendingMs: 300000, refreshMs: 21600000,
    reconcileMs: 300000, lookbackMs: 86400000, seedPending: true });
  assert.throws(() => readOptions({ WEBHOOK_WORKERS: '20' }), /WEBHOOK_WORKERS/);
  assert.throws(() => readOptions({ WEBHOOK_PENDING_MINUTES: '0' }), /WEBHOOK_PENDING_MINUTES/);
  assert.equal(readOptions({ WEBHOOK_SEED_PENDING_ORDERS: '0' }).seedPending, false);
});
