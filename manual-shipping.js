'use strict';

// Staff comments are GraphQL CommentEvents, not REST label-purchase events.
function parseComment(event, order, currency) {
  const text = String(event.rawMessage || event.message || '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#36;/g, '$').replace(/\s+/g, ' ').trim();
  if (!/\bshipping\b/i.test(text) || !/\bpaid\b/i.test(text)) return null;
  // Only explicit completed payments by the merchant; not estimates or customer charges.
  if (!/\b(?:we|i)\s+paid\b/i.test(text) ||
      /\b(?:not|never|haven't|haven’t|didn't|didn’t|unpaid|refund\w*|void\w*|cancel\w*|estimate\w*|quote\w*|will|would|customer|retailer)\b|\?/i.test(text)) return null;
  const amounts = [...text.matchAll(/(?:USD\s*|US\$\s*|\$\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.])/gi)];
  const validPayment = /\b(?:we|i)\s+paid\s+(?:USD\s*|US\$\s*|\$\s*)[\d,.]+\s+(?:for|in)\s+(?:(?:fruit|marmalade|marmalades)\s+)?shipping\b/i.test(text);
  if (!validPayment) return null;
  if (currency !== 'USD' || /\b(?:CAD|AUD|NZD|EUR|GBP)\b|[€£]/i.test(text) || amounts.length !== 1) {
    return { warning: `Manual shipping comment ${event.id}: ambiguous amount or currency` };
  }
  const cost = Number(amounts[0][1].replace(/,/g, ''));
  if (!Number.isFinite(cost) || cost <= 0) return { warning: `Manual shipping comment ${event.id}: invalid cost` };
  const code = text.match(/\btracking(?:\s+(?:number|code))?\s*[:#]?\s*([a-z0-9-]{8,})/i)?.[1];
  const tracking = code && /\d/.test(code) ? code.replace(/[^a-z0-9]/gi, '').toUpperCase() : null;
  const marmalade = /\bmarmal(?:ade|de)s?\b|\bfruit\s+spreads?\b/i.test(text);
  const fruit = /\bfruit\b/i.test(text.replace(/fruit\s+spreads?/gi, ''));
  return { record: { source: 'shopify_comment', id: String(event.id), cost, tracking_number: tracking,
    scope: !tracking && !marmalade && !fruit ? 'order_total' : 'shipment',
    category: marmalade !== fruit ? (marmalade ? 'marmalade' : 'fruit') : null,
    method: 'manual_shipping_comment', comment: text, created_at: event.createdAt } };
}

module.exports = function createManualShipping({ request, api, config }) {
  return async order => {
    const shipments = [], warnings = [], seen = new Set(), cursors = new Set();
    let after = null;
    do {
      const { data: response } = await request(api('graphql.json'), 'shopify', {
        query: `query ShippingComments($id: ID!, $after: String) {
          order(id: $id) { events(first: 100, after: $after) {
            nodes { __typename id ... on CommentEvent { rawMessage createdAt } }
            pageInfo { hasNextPage endCursor }
          } }
        }`, variables: { id: `gid://shopify/Order/${order.id}`, after }
      });
      if (response.errors?.length) throw Error('Shopify shipping comments query failed: ' + response.errors.map(e => e.message).join('; '));
      const connection = response.data?.order?.events;
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw Error('Shopify shipping comments response missing events');
      for (const event of connection.nodes) {
        if (event.__typename !== 'CommentEvent' || seen.has(event.id)) continue;
        seen.add(event.id);
        const parsed = parseComment(event, order, config.currency);
        if (parsed?.warning) warnings.push(parsed.warning);
        if (parsed?.record) shipments.push(parsed.record);
      }
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw Error('Shopify shipping comments pagination did not advance');
      cursors.add(after);
    } while (true);
    return { shipments, warnings };
  };
};
module.exports.parseComment = parseComment;
