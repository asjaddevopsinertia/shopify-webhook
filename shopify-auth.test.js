'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createShopifyAuth } = require('./shopify-auth');
const credentials = { shop: 'test-store.myshopify.com', clientId: 'test-client', clientSecret: 'test-secret' };
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('exchanges client credentials once, caches the token and renews before the returned expiry', async () => {
  let time = 1000, calls = 0;
  const auth = createShopifyAuth(credentials, { now: () => time, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://test-store.myshopify.com/admin/oauth/access_token');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(options.body), { grant_type: 'client_credentials', client_id: 'test-client', client_secret: 'test-secret' });
    return response({ access_token: `issued-${calls}`, expires_in: 100 });
  } });
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken()]), ['issued-1', 'issued-1']);
  assert.equal(calls, 1);
  time = 90000;
  assert.equal(await auth.getToken(), 'issued-1');
  time = 92000;
  assert.equal(await auth.getToken(), 'issued-2');
  assert.equal(calls, 2);
  auth.invalidate('issued-1'); // A late 401 must not invalidate a newer token.
  assert.equal(await auth.getToken(), 'issued-2');
  auth.invalidate('issued-2');
  assert.equal(await auth.getToken(), 'issued-3');
});
test('missing credentials and unsafe domains fail before sending a request', async () => {
  for (const config of [{ ...credentials, clientSecret: '' }, { ...credentials, shop: 'attacker.test' }]) {
    const auth = createShopifyAuth(config, { fetchImpl: () => { throw Error('Must not send'); } });
    await assert.rejects(auth.getToken(), /required|Invalid Shopify/);
  }
});
test('OAuth permission errors are actionable and never echo response bodies or secrets', async () => {
  let calls = 0;
  const auth = createShopifyAuth(credentials, { fetchImpl: async () => {
    calls++;
    return response({ error_description: 'test-secret should never be logged' }, 403);
  } });
  await assert.rejects(auth.getToken(), error => error.status === 403 && /same Shopify organization/.test(error.message) && !error.message.includes('test-secret'));
  assert.equal(calls, 1);
  await assert.rejects(auth.getToken()); // Failed exchanges release the lock for later attempts.
  assert.equal(calls, 2);
});
test('transient errors retry, but malformed token responses are never cached', async () => {
  let calls = 0;
  const waits = [];
  const auth = createShopifyAuth(credentials, { sleep: async ms => waits.push(ms), fetchImpl: async () => {
    calls++;
    if (calls === 1) throw Error('network');
    if (calls === 2) return response({}, 429, { 'retry-after': '2' });
    if (calls === 3) return response({}, 503);
    return response({ access_token: 'ok', expires_in: 500 });
  } });
  assert.equal(await auth.getToken(), 'ok');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  for (const data of [{}, { access_token: 'x', expires_in: 0 }, { access_token: 'x', expires_in: 'invalid' }]) {
    await assert.rejects(createShopifyAuth(credentials, { fetchImpl: async () => response(data) }).getToken(), /no valid/);
  }
});
test('Admin API requests use exchanged tokens, renew once on 401 and preserve 403 failures', async t => {
  const { config, request } = require('./import-orders');
  const previous = { ...config }, previousFetch = global.fetch;
  Object.assign(config, credentials);
  t.after(() => { Object.assign(config, previous); global.fetch = previousFetch; });
  let exchanges = 0, adminCalls = 0, status = 401;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/admin/oauth/access_token')) {
      exchanges++;
      return response({ access_token: `token-${exchanges}`, expires_in: 3600 });
    }
    adminCalls++;
    assert.equal(options.headers['X-Shopify-Access-Token'], `token-${exchanges}`);
    assert.equal(options.body, undefined);
    if (adminCalls === 1) return response({}, 401);
    return status === 200 ? response({ orders: [] }) : response({}, status);
  };
  // A persistent 401 gets one renewal, then stops.
  await assert.rejects(request('https://test-store.myshopify.com/admin/api/2026-10/orders.json', 'shopify'), error => error.status === 401);
  assert.equal(exchanges, 2);
  assert.equal(adminCalls, 2);
  status = 403;
  await assert.rejects(request('https://test-store.myshopify.com/admin/api/2026-10/orders.json', 'shopify'), error => error.status === 403);
  assert.equal(exchanges, 2);
  status = 200;
  assert.deepEqual((await request('https://test-store.myshopify.com/admin/api/2026-10/orders.json', 'shopify')).data.orders, []);
  assert.equal(exchanges, 2);
});
