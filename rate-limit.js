'use strict';

// Independent queues prevent concurrent workers from racing the request clock.
function createRateLimiter({ intervals, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const states = new Map();
  function state(service) {
    if (!(service in intervals)) throw Error('Unknown API service');
    if (!states.has(service)) states.set(service, { tail: Promise.resolve(), next: 0, blocked: 0 });
    return states.get(service);
  }
  function pause(service, milliseconds) {
    const s = state(service);
    s.blocked = Math.max(s.blocked, now() + Math.max(0, milliseconds));
  }
  function run(service, work) {
    const s = state(service);
    const result = s.tail.then(async () => {
      let delay;
      while ((delay = Math.max(s.next, s.blocked) - now()) > 0) await sleep(Math.min(30000, delay));
      s.next = now() + intervals[service];
      return work();
    });
    s.tail = result.then(() => {}, () => {});
    return result;
  }
  function feedback(service, response, attempt = 0) {
    const reset = Number(response.headers.get('x-rate-limit-reset'));
    const remaining = response.headers.get('x-rate-limit-remaining');
    if (service === 'shipstation' && remaining !== null && Number(remaining) === 0 && Number.isFinite(reset) && reset > 0) {
      pause(service, reset * 1000 + 250);
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const parsed = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - now() : NaN;
      const fallback = service === 'shipstation' ? (reset > 0 ? reset * 1000 + 250 : 60000) : Math.min(30000, 1000 * 2 ** attempt);
      pause(service, Math.max(1000, Number.isFinite(parsed) ? parsed : fallback));
    }
  }
  return { run, pause, feedback };
}

module.exports = { createRateLimiter };
