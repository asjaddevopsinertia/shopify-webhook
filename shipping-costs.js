'use strict';

// Keep a numeric total for existing reports and a uniform audit trail for every order.
module.exports = function createShippingHelpers({ request, api, config, comments }) {
  const round = n => Math.round(n * 100) / 100;
  const tracking = value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  function amount(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function category(item) {
    // The merchant's product-name rule applies consistently to order and parcel items.
    const text = String(item.title || item.name || '');
    if (/marmal(?:ade|de)s?|fruit\s+spreads?|gift\s+sets?/i.test(text)) return 'marmalade';
    return 'fruit';
  }
  function groupFor(items) {
    const groups = new Set((items || []).filter(i => Number(i.quantity ?? 1) > 0).map(category));
    return groups.size === 1 ? [...groups][0] : 'unallocated';
  }
  function groupForTracking(order, code, items = []) {
    const fulfillments = (order.fulfillments || []).filter(f => f.status !== 'cancelled' &&
      [f.tracking_number, ...(f.tracking_numbers || [])].some(t => code && tracking(t) === tracking(code)));
    const matched = fulfillments.flatMap(f => f.line_items || []);
    return groupFor(matched.length ? matched : items.length ? items : order.line_items);
  }
  function isMixedOrder(order) {
    return new Set((order.line_items || []).filter(i => Number(i.quantity ?? 1) > 0).map(category)).size > 1;
  }
  function shipmentCategory(order, source, code, items = []) {
    const group = groupForTracking(order, code, items);
    const linkedItems = (order.fulfillments || []).filter(f => f.status !== 'cancelled' &&
      [f.tracking_number, ...(f.tracking_numbers || [])].some(t => code && tracking(t) === tracking(code)))
      .flatMap(f => f.line_items || []);
    // The merchant confirmed this routing for split mixed orders. Only use it
    // when there is no direct parcel/item evidence, never for a known mixed parcel.
    if (group === 'unallocated' && isMixedOrder(order) && !linkedItems.length && !items.length) {
      return { category: source === 'shopify' ? 'marmalade' : 'fruit', category_basis: 'store_shipping_rule' };
    }
    return { category: group };
  }
  async function shipstation(order, cachedShipments) {
    if (!process.env.SHIPSTATION_API_KEY) return [];
    const shipments = new Map();
    const names = [...new Set([order.name, String(order.order_number || '')].filter(Boolean))];
    function add(s) {
      if (!names.includes(String(s.orderNumber)) || s.voided || s.isReturnLabel) return;
      if (s.shipmentId === undefined) throw Error('ShipStation shipment missing ID');
      const cost = amount(s.shipmentCost);
      if (cost === null) throw Error('ShipStation shipment has no valid label cost');
      shipments.set(String(s.shipmentId), { source: 'shipstation', id: String(s.shipmentId),
        tracking_number: tracking(s.trackingNumber) || null, cost,
        ...shipmentCategory(order, 'shipstation', s.trackingNumber, s.shipmentItems || []) });
    }
    if (cachedShipments !== undefined) {
      for (const shipment of cachedShipments) add(shipment);
      return [...shipments.values()];
    }
    for (const name of names) {
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ orderNumber: name, includeShipmentItems: 'true', page: String(page), pageSize: '100' });
        if (process.env.SHIPSTATION_STORE_ID) params.set('storeId', process.env.SHIPSTATION_STORE_ID);
        const { data } = await request(`https://ssapi.shipstation.com/shipments?${params}`, 'shipstation');
        for (const s of data.shipments || []) if (String(s.orderNumber) === name) add(s);
        if (page >= Number(data.pages || 1)) break;
      }
    }
    return [...shipments.values()];
  }
  async function events(order) {
    if (config.currency !== 'USD') return [];
    const seen = new Set(), shipments = [], warnings = [];
    let since = '0';
    let url = api(`orders/${order.id}/events.json?limit=250&since_id=${since}`);
    const pages = new Set();
    while (true) {
      if (pages.has(url)) throw Error('Shopify events pagination repeated a page');
      pages.add(url);
      const { data, headers } = await request(url, 'shopify');
      const rows = data.events || [];
      for (const e of rows) {
        if (seen.has(String(e.id))) continue;
        seen.add(String(e.id));
        const text = String(e.message || '').replace(/<[^>]*>/g, ' ').replace(/\*\*/g, '').replace(/&nbsp;/g, ' ');
        if (/shipping label/i.test(text) && /refund|void|cancel/i.test(text)) {
          warnings.push('Shopify label refund/void requires reconciliation; no final cost saved');
          continue;
        }
        if (!/purchased\b.*shipping label/i.test(text)) continue;
        const match = text.match(/purchased\s+(?:a\s+)?(?:USD\s*|US\$\s*|\$\s*)([\d,]+(?:\.\d{1,2})?)\s+(?:USD\s+)?shipping label/i) ||
          text.match(/purchased\s+(?:a\s+)?shipping label\s+for\s+(?:USD\s*|US\$\s*|\$\s*)([\d,]+(?:\.\d{1,2})?)/i);
        if (!match) { warnings.push('Shopify label purchase amount could not be parsed'); continue; }
        const candidate = text.match(/tracking(?:\s+(?:number|code))?\s*[:#]?\s*([a-z0-9-]{8,})/i)?.[1];
        const code = candidate && /\d/.test(candidate) ? candidate : undefined;
        shipments.push({ source: 'shopify', id: String(e.id), tracking_number: tracking(code) || null,
          cost: amount(match[1].replace(/,/g, '')), ...shipmentCategory(order, 'shopify', code) });
      }
      const next = headers?.get('link')?.split(',').map(s => s.trim()).find(s => /rel="next"/.test(s))?.match(/<([^>]+)>/)?.[1];
      if (next) { url = next; continue; }
      if (rows.length < 250) break;
      const last = String(rows.at(-1).id);
      if (BigInt(last) <= BigInt(since)) throw Error('Shopify events pagination did not advance');
      since = last;
      url = api(`orders/${order.id}/events.json?limit=250&since_id=${since}`);
    }
    return { shipments, warnings };
  }
  function faireAttributes(order) {
    return (order.note_attributes || []).filter(a => /^faire[_ -]?order[_ -]?(?:id|number)$/i.test(String(a.name || '').trim()) && String(a.value || '').trim());
  }
  function faireId(order) {
    const attributes = faireAttributes(order);
    const tags = Array.isArray(order.tags) ? order.tags : String(order.tags || '').split(',');
    const candidates = [...attributes.map(a => a.value), ...tags.map(t => t.trim().match(/^faire[_ -]?order[_ -]?id\s*[:=]\s*(\S+)$/i)?.[1]),
      ...tags.map(t => t.trim().match(/^bo_[a-z0-9]+$/i)?.[0]),
      String(order.note || '').match(/\bbo_[a-z0-9]+\b/i)?.[0],
      // This store preserves Faire's display order number in Shopify.
      // Only identified Faire orders may use the shared number as a fallback.
      isFaire(order) ? order.name : null,
      isFaire(order) ? order.order_number : null];
    const value = candidates.find(Boolean);
    if (!value) return null;
    const normalized = String(value).trim().replace(/^#/, '').replace(/^bo_/i, '').toLowerCase();
    return /^[a-z0-9]+$/.test(normalized) ? `bo_${normalized}` : null;
  }
  function isFaire(order) {
    const tags = Array.isArray(order.tags) ? order.tags : String(order.tags || '').split(',');
    return tags.some(t => /^faire(?:$|[_ :\-=])/i.test(t.trim())) ||
      faireAttributes(order).length > 0 ||
      /^faire$/i.test(String(order.source_name || '').trim()) ||
      /\bthis order was placed on faire\b/i.test(String(order.note || ''));
  }
  function payoutShipping(data) {
    // This residual is meaningful only when the brand pays shipping. Retailer
    // shipping charges and deductions cancel out and cannot be recovered this way.
    if (data.is_free_shipping !== true || data.free_shipping_reason !== 'FREE_SHIPPING_THRESHOLD' ||
        !data.payment_initiated_at || !Number.isFinite(Date.parse(data.payment_initiated_at)) ||
        !['PRE_TRANSIT', 'IN_TRANSIT', 'DELIVERED'].includes(data.state) ||
        !data.shipments?.length || data.shipments.some(s => s.shipping_type !== 'SHIP_WITH_FAIRE')) return null;
    if (!['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD'].includes(config.currency)) return null;
    const costs = data.payout_costs || {};
    const minor = value => value?.currency === config.currency &&
      Number.isSafeInteger(value.amount_minor) && value.amount_minor >= 0 ? value.amount_minor : null;
    const names = ['subtotal_after_brand_discounts', 'commission', 'payout_fee', 'total_payout'];
    const values = Object.fromEntries(names.map(name => [name, minor(costs[name])]));
    if (Object.values(values).some(n => n === null)) return null;
    // Do not attribute refunds, tax, subsidies or other adjustments to shipping.
    for (const name of ['payout_protection_fee', 'damaged_and_missing_items', 'net_tax', 'shipping_subsidy']) {
      if (minor(costs[name]) !== 0) return null;
    }
    if (!Array.isArray(costs.taxes) || costs.taxes.length ||
        (data.faire_covered_shipping_cost && minor(data.faire_covered_shipping_cost) !== 0)) return null;
    const known = new Set([...names, 'payout_protection_fee', 'damaged_and_missing_items', 'net_tax',
      'shipping_subsidy', 'taxes', 'total_brand_discounts', 'payout_fee_cents', 'payout_fee_bps',
      'payout_flat_fee', 'commission_cents', 'commission_bps', 'commission_flat_fee']);
    if (Object.keys(costs).some(key => !known.has(key))) return null;
    // commission and payout_fee already include flat fees. Never subtract those twice.
    const residual = values.subtotal_after_brand_discounts - values.commission - values.payout_fee - values.total_payout;
    if (!Number.isSafeInteger(residual) || residual <= 0) return null;
    return { cost: residual / 100, currency: config.currency, method: 'faire_payout_residual',
      amount_minor: residual, inputs_minor: values, payment_initiated_at: data.payment_initiated_at,
      assumption: 'Remaining deduction on a settled brand-funded free-shipping order is shipping; no other adjustments reported' };
  }
  async function getFaireOrder(order) {
    if (!process.env.FAIRE_ACCESS_TOKEN && !process.env.FAIRE_OAUTH_ACCESS_TOKEN) throw Error('Faire-tagged order needs FAIRE_ACCESS_TOKEN (or OAuth credentials)');
    const id = faireId(order);
    if (!id) throw Error('Faire-tagged order needs a valid shared order number or faire_order_id reference');
    const { data } = await request(`https://www.faire.com/external-api/v2/orders/${encodeURIComponent(id)}`, 'faire');
    if (String(data.id).toLowerCase() !== id) throw Error('Faire order ID mismatch');
    return data;
  }
  function faireFees(data) {
    const costs = data.payout_costs || {};
    function money(value) {
      return value?.currency === config.currency && Number.isSafeInteger(value.amount_minor) && value.amount_minor >= 0
        ? value.amount_minor / 100 : null;
    }
    const commission = money(costs.commission), processing = money(costs.payout_fee);
    if (commission === null || processing === null) throw Error('Faire commission/processing fee missing or currency mismatched');
    const commissionFlat = money(costs.commission_flat_fee), processingFlat = money(costs.payout_flat_fee);
    return { status: 'reported', source: 'faire_payout_costs', order_id: data.id, currency: config.currency,
      commission, processing_fee: processing, total_fees: round(commission + processing),
      commission_percentage: amount(costs.commission_bps) === null ? null : Number(costs.commission_bps) / 100,
      commission_flat_fee: commissionFlat,
      commission_variable_fee: commissionFlat !== null && commission >= commissionFlat ? round(commission - commissionFlat) : null,
      processing_fee_percentage: amount(costs.payout_fee_bps) === null ? null : Number(costs.payout_fee_bps) / 100,
      processing_flat_fee: processingFlat,
      processing_variable_fee: processingFlat !== null && processing >= processingFlat ? round(processing - processingFlat) : null,
      finalized: Boolean(data.payment_initiated_at), checked_at: new Date() };
  }
  async function faire(order, dataOverride) {
    if (!isFaire(order)) return [];
    const data = dataOverride || await getFaireOrder(order);
    const id = data.id;
    const inferred = payoutShipping(data);
    if (inferred) {
      if (data.shipments.some(s => !s.id)) throw Error('Faire shipment missing ID');
      const groups = new Set(data.shipments.map(s => groupForTracking(order, s.tracking_code)));
      // One order total covering all parcels, never the total once per parcel.
      return [{ source: 'faire', id: `payout:${id}`, tracking_number: null,
        tracking_numbers: [...new Set(data.shipments.map(s => tracking(s.tracking_code)).filter(Boolean))],
        tracking_complete: data.shipments.every(s => tracking(s.tracking_code)),
        cost: inferred.cost, category: groups.size === 1 ? [...groups][0] : 'unallocated', cost_status: 'inferred',
        method: inferred.method, payout_reconciliation: inferred,
        parcels: data.shipments.map(s => ({ id: String(s.id), carrier: s.carrier,
          tracking_number: tracking(s.tracking_code) || null, shipping_type: s.shipping_type, maker_cost: s.maker_cost || null })) }];
    }
    return (data.shipments || []).map(s => {
      if (!s.id) throw Error('Faire shipment missing ID');
      // Ship with Faire's maker_cost is not the carrier label total. In live
      // responses it can be zero even when the portal shows a positive cost.
      // Keep the parcel for tracking reconciliation; another label seller may
      // supply its real cost. Eligible settled payouts are reconciled above.
      if (s.shipping_type === 'SHIP_WITH_FAIRE') {
        return { source: 'faire', id: String(s.id), tracking_number: tracking(s.tracking_code) || null,
          cost: null, category: groupForTracking(order, s.tracking_code), shipping_type: s.shipping_type,
          maker_cost: s.maker_cost || null, cost_status: 'unavailable_from_faire_api' };
      }
      // Ship-on-your-own records report the brand's submitted shipment cost.
      const minor = amount(s.maker_cost?.amount_minor);
      if (minor === null || s.maker_cost.currency !== config.currency || !['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD'].includes(config.currency)) {
        throw Error('Faire shipment cost missing or currency unsupported/mismatched');
      }
      return { source: 'faire', id: String(s.id), tracking_number: tracking(s.tracking_code) || null,
        cost: minor / 100, category: groupForTracking(order, s.tracking_code) };
    });
  }
  function summarize(order, records, warnings = []) {
    const splitSharedCost = cost => {
      const cents = Math.round(cost * 100);
      // Preserve the exact total when an odd cent cannot be divided evenly.
      return { fruit: Math.floor(cents / 2) / 100, marmalade: Math.ceil(cents / 2) / 100,
        unallocated: 0, allocation_basis: 'fulfilled_mixed_single_cost_equal_split' };
    };
    const manualTotals = [...new Map(records.filter(s => s.source === 'shopify_comment' && s.scope === 'order_total').map(s => [s.id, s])).values()];
    if (manualTotals.length) {
      const manualWarnings = warnings.filter(w => /manual shipping|shipping comments/i.test(w));
      if (manualTotals.length > 1) manualWarnings.push('Multiple manual order shipping totals: edit or delete the old comment so only one total remains');
      const record = { ...manualTotals[0], category: groupFor(order.line_items) };
      const total = manualWarnings.length ? null : record.cost;
      const shared = total !== null && order.fulfillment_status === 'fulfilled' && isMixedOrder(order);
      return { total, currency: config.currency, fruit: 0, marmalade: 0, unallocated: 0,
        [record.category]: record.cost, observed_total: record.cost,
        ...(shared ? splitSharedCost(record.cost) : {}),
        status: total === null ? 'pending' : 'observed', method: 'manual_shipping_comment',
        shipments: manualTotals.map(s => ({ ...s, category: groupFor(order.line_items) })),
        excluded_shipments: records.filter(s => !manualTotals.includes(s)),
        warnings: manualWarnings, lookup_warnings: warnings, checked_at: new Date() };
    }
    for (const record of records.filter(s => s.source === 'shopify_comment')) {
      record.category = record.category || groupForTracking(order, record.tracking_number);
      if (records.some(s => s !== record &&
          (!record.tracking_number || !(s.tracking_number || s.tracking_numbers?.length)))) {
        warnings.push('Manual shipping comments need tracking numbers when other shipping records exist to avoid double counting');
      }
      const sameParcel = records.find(s => s !== record && record.tracking_number && s.tracking_number === record.tracking_number && s.cost !== null);
      if (sameParcel && round(sameParcel.cost) !== round(record.cost)) {
        warnings.push(`Manual shipping comment ${record.id}: cost conflicts with another record for the same tracking number`);
      }
    }
    const aggregate = records.find(s => s.method === 'faire_payout_residual');
    if (aggregate) {
      const covered = new Set(aggregate.tracking_numbers);
      // Other services may mirror the same parcels. The aggregate already covers
      // them; only independently tracked additional parcels may be added.
      records = records.filter(s => s === aggregate || s.source === 'faire' || !s.tracking_number || !covered.has(s.tracking_number));
    }
    const hasTracking = s => Boolean(s.tracking_number) || Boolean(s.tracking_numbers?.length && s.tracking_complete);
    const shipments = [], keys = new Set();
    for (const record of records) {
      const key = `${record.source}:${record.id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const duplicate = record.tracking_number && shipments.find(s => s.tracking_number === record.tracking_number);
      if (duplicate) {
        // The label seller (ShipStation/Shopify) wins over Faire's copy of a shipment.
        if (duplicate.category === 'unallocated') duplicate.category = record.category;
        if (duplicate.cost === null && record.cost !== null) {
          const category = duplicate.category;
          Object.assign(duplicate, record, { category });
        }
        continue;
      }
      // Faire may mirror another service's label. Without tracking, don't guess whether to add it.
      if (records.some(s => s.source !== 'faire') && records.some(s => s.source === 'faire') &&
          (!hasTracking(record) || records.some(s => s.source !== record.source && !hasTracking(s)))) {
        warnings.push('Cross-source Faire shipments without tracking need reconciliation');
      }
      shipments.push({ ...record });
    }
    const knownTracking = new Set(shipments.flatMap(s => [s.tracking_number, ...(s.tracking_numbers || [])]).filter(Boolean));
    const expectedTracking = (order.fulfillments || []).filter(f => f.status !== 'cancelled')
      .flatMap(f => [f.tracking_number, ...(f.tracking_numbers || [])]).map(tracking).filter(Boolean);
    // Merchant rule: one known charge on a fully fulfilled mixed order covers both
    // categories. Do not apply when extra parcels have explicitly unknown costs.
    const shared = order.fulfillment_status === 'fulfilled' && isMixedOrder(order) &&
      shipments.length === 1 && shipments[0].cost !== null && !warnings.length;
    if (!shared && expectedTracking.some(t => !knownTracking.has(t)) && shipments.every(hasTracking)) warnings.push('Some fulfilled parcels have no label cost');
    const expectedGroups = new Set((order.line_items || []).filter(i => Number(i.quantity ?? 1) > 0).map(category));
    if (!shared && expectedGroups.size > 1 && (shipments.some(s => s.category === 'unallocated') ||
        [...expectedGroups].some(group => !shipments.some(s => s.category === group)))) {
      warnings.push('Mixed fruit/marmalade order needs identifiable costs for both product groups');
    }
    const totals = { fruit: 0, marmalade: 0, unallocated: 0 };
    const priced = shipments.filter(s => s.cost !== null);
    for (const s of shipments.filter(s => s.cost === null)) {
      warnings.push(`Faire shipment ${s.id}: Ship with Faire label cost is unavailable from the order API; maker_cost is not the label total`);
    }
    for (const s of priced) totals[s.category] = round(totals[s.category] + s.cost);
    const observed = round(priced.reduce((n, s) => n + s.cost, 0));
    const total = priced.length && !warnings.length ? observed : null;
    return { total, currency: config.currency, ...totals, observed_total: priced.length ? observed : null,
      ...(shared ? splitSharedCost(observed) : {}),
      status: total === null ? 'pending' : shipments.some(s => s.cost_status === 'inferred') ? 'inferred' : 'observed',
      shipments, warnings: [...new Set(warnings)], checked_at: new Date() };
  }
  async function shippingDetails(order, options = {}) {
    const records = [], warnings = [];
    // Sources are independent. Await every result so failures cannot hide a
    // split shipment, while independent API queues can make progress together.
    const results = await Promise.allSettled([o => shipstation(o, options.shipstationShipments), events, o => {
      if (options.faireError) throw options.faireError;
      return faire(o, options.faireOrder);
    }, ...(comments ? [comments] : [])].map(lookup => Promise.resolve().then(() => lookup(order))));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (Array.isArray(result.value)) records.push(...result.value);
        else { records.push(...result.value.shipments); warnings.push(...result.value.warnings); }
      }
      else warnings.push(result.reason.message);
    }
    return summarize(order, records, warnings);
  }
  return { shippingDetails, shippingCost: async order => (await shippingDetails(order)).total,
    summarize, category, faireId, isFaire, isMixedOrder,
    payoutShipping, getFaireOrder, faireFees };
};
