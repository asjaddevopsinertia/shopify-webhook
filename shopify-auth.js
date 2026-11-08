'use strict';

// https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
function createShopifyAuth(config, { fetchImpl = (...args) => fetch(...args), now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let cached = null, inFlight = null;
  function validate() {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(config.shop || '')) throw Error('Invalid Shopify shop domain');
    if (!config.clientId || !config.clientSecret) throw Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required. Copy them from your app in the Shopify Dev Dashboard.');
  }
  async function exchange() {
    validate();
    for (let attempt = 0; attempt < 6; attempt++) {
      const startedAt = now();
      let response;
      try {
        response = await fetchImpl(`https://${config.shop}/admin/oauth/access_token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }),
          signal: AbortSignal.timeout(20000), redirect: 'error',
        });
      } catch {
        if (attempt === 5) throw Error('Shopify token exchange failed after network retries');
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 5) throw Error(`Shopify token exchange HTTP ${response.status}: retries exhausted`);
        const retry = Number(response.headers.get('retry-after'));
        await sleep(Math.min(30000, Math.max(1000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000 * 2 ** attempt)));
        continue;
      }
      if (!response.ok) {
        // Do not log OAuth response bodies: credentials/tokens must never enter logs.
        await response.body?.cancel();
        const error = Error(`Shopify client credentials exchange HTTP ${response.status}. Check the client ID/secret, app installation, and that the app and store belong to the same Shopify organization.`);
        error.status = response.status;
        throw error;
      }
      let data;
      try { data = await response.json(); }
      catch { throw Error('Shopify token exchange returned invalid JSON'); }
      const lifetime = Number(data.expires_in) * 1000;
      if (typeof data.access_token !== 'string' || !data.access_token.trim() || !Number.isFinite(lifetime) || lifetime <= 0) {
        throw Error('Shopify token exchange returned no valid access_token/expires_in');
      }
      // Use the actual TTL and request a replacement before expiry.
      const refreshAt = startedAt + lifetime - Math.min(60000, lifetime / 10);
      if (refreshAt <= now()) throw Error('Shopify issued a token with insufficient remaining lifetime');
      cached = { token: data.access_token, refreshAt };
      return cached.token;
    }
  }
  async function getToken() {
    if (cached && now() < cached.refreshAt) return cached.token;
    // All concurrent requests share one token exchange.
    if (!inFlight) inFlight = exchange().finally(() => { inFlight = null; });
    return inFlight;
  }
  function invalidate(token) {
    if (cached?.token === token) cached = null;
  }
  return { getToken, invalidate, validate };
}

module.exports = { createShopifyAuth };
