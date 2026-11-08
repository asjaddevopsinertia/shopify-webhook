'use strict';
const { randomUUID, createHash } = require('node:crypto');

// Only a fully scanned, bounded snapshot is authoritative for absent shipments.
// Interrupted scans resume at their last acknowledged page. Customers/addresses
// and label contents are not copied into this cache.
async function prepareShipstationCache({ request, collection, state, log = () => {}, now = () => new Date(), assertLease = () => {}, fresh = false }) {
  if (!process.env.SHIPSTATION_API_KEY) return null;
  await collection.createIndex({ generation: 1, orderNumber: 1 });
  let scan = await state.findOne({ _id: 'shipstation-snapshot' });
  const store = process.env.SHIPSTATION_STORE_ID || '';
  const account = createHash('sha256').update(process.env.SHIPSTATION_API_KEY).digest('hex');
  // A completed snapshot may be reused briefly on an immediate restart.
  if (fresh || !scan || scan.account !== account || scan.store !== store ||
      !Number.isFinite(Date.parse(scan.startedAt)) || (scan.complete && !Number.isFinite(Date.parse(scan.completedAt))) ||
      (scan.complete ? now() - new Date(scan.completedAt) > 300000 : now() - new Date(scan.startedAt) > 21600000)) {
    scan = { _id: 'shipstation-snapshot', generation: randomUUID(), store, account, complete: false,
      nextPage: 1, count: 0, snapshotEnd: now().toISOString(), startedAt: now() };
    await state.replaceOne({ _id: scan._id }, scan, { upsert: true });
  }
  if (!scan.complete) log(`ShipStation bulk snapshot: starting/resuming page ${scan.nextPage}. Shopify processing follows once the snapshot is complete.`);
  while (!scan.complete) {
    assertLease();
    const params = new URLSearchParams({ page: String(scan.nextPage), pageSize: '100', includeShipmentItems: 'true',
      createDateEnd: scan.snapshotEnd, sortBy: 'CreateDate', sortDir: 'ASC' });
    if (store) params.set('storeId', store);
    const { data } = await request(`https://ssapi.shipstation.com/shipments?${params}`, 'shipstation');
    const pages = Number(data.pages), total = Number(data.total);
    if (!Array.isArray(data.shipments) || data.pages == null || data.total == null ||
        !Number.isInteger(pages) || pages < 0 || !Number.isInteger(total) || total < 0 ||
        (data.shipments.length === 0 && (total > scan.count || scan.nextPage < pages))) {
      throw Error('Invalid/incomplete ShipStation snapshot page; checkpoint retained. Use --fresh if the snapshot changed.');
    }
    const ids = data.shipments.map(s => String(s.shipmentId));
    if (new Set(ids).size !== ids.length) throw Error('Duplicate shipment IDs in snapshot page; use --fresh to rescan');
    const repeated = await collection.find({ generation: scan.generation, _id: { $in: ids }, snapshotPage: { $ne: scan.nextPage } }).toArray();
    if (repeated.length) throw Error('ShipStation pagination repeated a shipment from another page; use --fresh to rescan');
    const operations = data.shipments.map(s => {
      if (s.shipmentId === undefined || s.orderNumber === undefined) throw Error('ShipStation snapshot record missing identity');
      return { replaceOne: { filter: { _id: String(s.shipmentId) }, upsert: true, replacement: {
        _id: String(s.shipmentId), generation: scan.generation, snapshotPage: scan.nextPage,
        shipmentId: s.shipmentId, orderNumber: String(s.orderNumber),
        shipmentCost: s.shipmentCost ?? null, trackingNumber: s.trackingNumber || null, voided: s.voided,
        isReturnLabel: s.isReturnLabel, shipmentItems: (s.shipmentItems || []).map(i => ({ sku: i.sku, name: i.name, quantity: i.quantity })),
      } } };
    });
    assertLease();
    if (operations.length) await collection.bulkWrite(operations, { ordered: false });
    scan.count += data.shipments.length;
    scan.complete = scan.nextPage >= Number(data.pages || 1);
    if (scan.complete) {
      const uniqueCount = await collection.countDocuments({ generation: scan.generation });
      if (uniqueCount !== scan.count || scan.count !== total) {
        throw Error('ShipStation snapshot total changed or records are missing; use --fresh to rebuild before importing');
      }
    }
    log(`ShipStation snapshot page ${scan.nextPage}/${data.pages || 1}: ${scan.count} shipment records cached${scan.complete ? ' (complete)' : ''}.`);
    scan.nextPage++;
    if (scan.complete) scan.completedAt = now();
    // Advance only after the shipment writes succeed. A replay is an idempotent upsert.
    await state.replaceOne({ _id: scan._id }, scan);
  }
  log(`Using complete ShipStation snapshot: ${scan.count} shipment records; no per-order ShipStation requests needed.`);
  return {
    generation: scan.generation,
    async forOrders(orders) {
      const names = [...new Set(orders.flatMap(o => [o.name, String(o.order_number || '')]).filter(Boolean))];
      const records = names.length ? await collection.find({ generation: scan.generation, orderNumber: { $in: names } }).toArray() : [];
      const byName = new Map();
      for (const record of records) {
        if (!byName.has(record.orderNumber)) byName.set(record.orderNumber, []);
        byName.get(record.orderNumber).push(record);
      }
      return order => [...new Map([order.name, String(order.order_number || '')].flatMap(name => byName.get(name) || [])
        .map(s => [String(s.shipmentId), s])).values()];
    },
  };
}

module.exports = { prepareShipstationCache };
