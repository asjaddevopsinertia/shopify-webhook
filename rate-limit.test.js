'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('./rate-limit');

test('concurrent requests to one service obey the interval, including after a failure', async () => {
  let time = 0;
  const starts = [];
  const limiter = createRateLimiter({ intervals: { shopify: 550 }, now: () => time, sleep: async ms => { time += ms; } });
  const outcomes = await Promise.allSettled([0, 1, 2, 3].map(i => limiter.run('shopify', () => {
    starts.push(time);
    if (i === 1) throw Error('Transient failure');
    return i;
  })));
  assert.deepEqual(starts, [0, 550, 1100, 1650]);
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[3].value, 3);
});
test('one API queue cannot block another API', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const limiter = createRateLimiter({ intervals: { shipstation: 1600, shopify: 550 } });
  const first = limiter.run('shipstation', () => blocked);
  assert.equal(await limiter.run('shopify', () => 'Shopify progressed'), 'Shopify progressed');
  release(); await first;
});
test('remaining/reset headers pause all queued ShipStation requests without a real wait', async () => {
  let time = 0;
  const waits = [];
  const limiter = createRateLimiter({ intervals: { shipstation: 1600 }, now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  const first = limiter.run('shipstation', () => {
    limiter.feedback('shipstation', new Response('', { headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '65' } }));
  });
  const second = limiter.run('shipstation', () => time);
  await first;
  assert.equal(await second, 65250);
  assert.ok(waits.every(ms => ms <= 30000));
});
test('429 honors Retry-After seconds and HTTP dates, and a safe fallback without headers', async () => {
  for (const [headers, expected] of [[{ 'retry-after': '8' }, 8000], [{ 'retry-after': 'Thu, 01 Jan 1970 00:00:10 GMT' }, 10000], [{}, 60000]]) {
    let time = 0;
    const limiter = createRateLimiter({ intervals: { shipstation: 1600 }, now: () => time, sleep: async ms => { time += ms; } });
    limiter.feedback('shipstation', new Response('', { status: 429, headers }));
    assert.equal(await limiter.run('shipstation', () => time), expected);
  }
});
