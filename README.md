# Order backfill

Run from this directory with Node.js 22+:

```powershell
node --env-file=.env import-orders.js
```

You can also run `node import-orders.js`: both the importer and webhook server automatically load `.env` from their script directory. Existing process environment variables take precedence over that file.

The importer reads Shopify orders but only inserts IDs missing from MongoDB. It matches both string IDs and legacy numeric IDs, and uses insert-only upserts plus the existing unique ID index. It does not delete or merge duplicates that already exist. A rerun does not replace existing order fields.

For existing orders, only a zero, null, or missing `real_shipping_cost` triggers shipping lookup. Shipping updates touch only the shipping fields; Faire fee fields are refreshed separately. Positive shipping costs are skipped, including any older incorrect partial totals. Correcting those requires a separate targeted repair; this script intentionally does not reset them.

## Shopify client credentials

Set `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` in `.env`. Copy the ID and secret from the app's Settings / Credentials in Shopify's Dev Dashboard. `SHOPIFY_ACCESS_TOKEN` is no longer used.

The app must be installed on the store, and both must belong to the same Shopify organization for this client-secret grant. Grant `read_orders` and, for history beyond 60 days, `read_all_orders` following Shopify's approval requirements. Scope changes must be released and approved on the store; the token request itself does not set scopes.

Both scripts exchange the credentials using `POST /admin/oauth/access_token` with `grant_type=client_credentials`. Tokens are kept only in memory, reused across API requests, renewed before the returned `expires_in` duration elapses, and renewed once after a 401. Concurrent requests share an exchange. Tokens are never written to `.env` or logged. A 403 is a permission/access error and does not trigger token renewal.

Keep `SHOPIFY_WEBHOOK_SECRET` set to the signing secret of the app that sends the webhooks. If you move webhooks to a new app, update that secret and its subscriptions too.

[Shopify client credentials setup](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

## Shipping sources and schema

Every eligible order is checked for ShipStation labels and Shopify label purchase events. Faire-tagged orders are also checked in Faire. Product names containing `marmalade` (including plural) or `fruit spread` (including plural) are marmalade; other names are fruit. Optional comma-separated `FRUIT_SKUS` and `MARMALADE_SKUS` override name classification.

`real_shipping_cost` remains a numeric total (or null when unresolved), for compatibility with reports. Every newly checked order, including single-product orders, gets `real_shipping_cost_details` with the same fields:

```json
{
  "real_shipping_cost": 13.25,
  "real_shipping_cost_details": {
    "total": 13.25,
    "currency": "USD",
    "fruit": 8,
    "marmalade": 5.25,
    "unallocated": 0,
    "observed_total": 13.25,
    "status": "observed",
    "shipments": [
      { "source": "shipstation", "id": "100", "tracking_number": "FRUIT12345", "cost": 8, "category": "fruit" },
      { "source": "shopify", "id": "200", "tracking_number": "JAM1234567", "cost": 5.25, "category": "marmalade" }
    ],
    "warnings": [],
    "checked_at": "2026-11-07T00:00:00.000Z"
  }
}
```

The example is illustrative. MongoDB stores `checked_at` as a Date. Category sums describe observed labels; a zero category amount is not proof that shipping was free. Unknown/ambiguous totals remain null with `status: pending`, warnings, and an `observed_total` for investigation.

Shipping items and Shopify fulfillment tracking associate labels with product groups. A parcel containing both categories stays unallocated; the script does not invent an allocation. Mixed orders with missing/unallocated product-group costs stay pending. A Shopify label purchase and a separate ShipStation label are summed. Shared tracking numbers are counted once across services, preferring the label seller over Faire. Faire records without enough tracking evidence to distinguish them from other sources stay pending. Same tracking numbers represent one parcel; replacement labels or reused tracking need manual reconciliation.

ShipStation scans both order-name formats and deduplicates shipment IDs. Voided and return labels are excluded. Set `SHIPSTATION_STORE_ID` when the account contains multiple stores with overlapping order numbers. ShipStation costs exclude insurance. Missing ShipStation credentials disable that source. Shopify event parsing is best effort, USD only; unrelated events are ignored. Unparseable purchases, label refunds/voids, API failures and ambiguous mixed shipments leave the cost pending instead of saving a partial final total. Customer shipping charges are never substituted for actual costs.

Pending/zero orders are queued for the webhook worker to retry, or can be retried by rerunning the importer. The historical importer preserves positive shipping costs. The live webhook worker deliberately recalculates positive costs too, so later parcels and label purchases are included. Keep the webhook service stopped while running the importer; both now share a collection-level lease. See DEPLOYMENT.md for live operation.

## Faire configuration

See `.env.example`; the actual `.env` is not modified. Set `FAIRE_ACCESS_TOKEN` for a single brand, or both `FAIRE_OAUTH_ACCESS_TOKEN` and `FAIRE_APP_CREDENTIALS` (Base64 of `applicationId:applicationSecret`). When `FAIRE_ACCESS_TOKEN` is populated, it takes precedence and unused OAuth settings are ignored. The token needs permission to read orders/shipments. [Faire API documentation](https://developers.faire.com/).

Faire orders are identified by a Faire tag, a `Faire order number`/`faire_order_id` note attribute, `source_name: Faire`, or the note `This order was placed on Faire`. The additional-detail order reference takes precedence. Because this store uses the same order numbers in Shopify and Faire, identified Faire orders otherwise automatically use Shopify's order name (or `order_number` when the name is missing). For example, Shopify `#ABC123` maps to Faire API ID `bo_abc123`. No extra tag or note attribute is required beyond the Faire tag.

An explicit reference can optionally override the shared order number:

- Note attribute `faire_order_id` with value `bo_abc123` or display ID `#ABC123`.
- Or tag `faire_order_id:bo_abc123`.

An explicit `bo_...` reference in tags or the note is also recognized. Shared order numbers are used only for identified Faire orders. Missing credentials or an invalid/missing order number leave the lookup pending with a warning. For ship-on-your-own shipments, the script reads the submitted `maker_cost.amount_minor` and currency, converting supported two-decimal currencies into major units; currency mismatches remain pending. For `SHIP_WITH_FAIRE`, `maker_cost` is not the carrier label total and can be zero while the portal shows a positive total. These parcels are recorded with `cost: null` and `cost_status: unavailable_from_faire_api`. If Shopify or ShipStation supplies an actual cost for the same tracking number it is used; otherwise eligible settled brand-funded orders use the inferred payout reconciliation described below, and other orders stay pending. The direct shipping total is not exposed in the order response for CY429ENTHE; its payout residual provides an inferred total. It does not use Faire retailer shipping charges, shipping subsidies or payout totals as label costs.

## Optimized imports and restart recovery

Run `node import-orders.js` yourself when ready. Neither the importer nor webhook server is started by `npm test`.

The importer first builds a complete ShipStation snapshot, with 100 shipment records per request, before processing Shopify orders. The snapshot is stored in `orders_shipstation_shipments` (or the configured collection name with that suffix); customer addresses and label contents are excluded. It uses a fixed creation-date cutoff, scans both valid and voided records returned by the API, excludes voided/return labels from costs, and matches both Shopify order-name formats locally. Incomplete pages, duplicate shipment IDs, and inconsistent totals cannot be used as a complete cache. If the scan fails, its last acknowledged page is retained. A later launch resumes it; use `--fresh` if the API's snapshot contents have changed. A completed snapshot may be reused for five minutes; changing the ShipStation account or store forces a rebuild. New labels after the cutoff are checked by the live webhook worker or a later import scan.

After that snapshot completes, up to four orders are prepared concurrently. Shopify, ShipStation, and Faire each have a separate rate-controlled request queue; a slow API does not block another service. The limiter respects ShipStation remaining/reset headers and shared 429 cooldowns. An order still checks every applicable source, so a Shopify label cannot hide a separate ShipStation parcel. The webhook worker uses live ShipStation lookups, not the import snapshot, and refreshes positive shipping costs too.

Each Shopify page uses batched MongoDB reads, one unordered order write batch, and a retry-job batch when needed. Existing order snapshots are preserved, new orders use insert-only upserts, and shipping updates use compare-and-set filters so another writer's positive cost is not replaced. Faire fees are refreshed independently of positive shipping costs.

Checkpoints and the importer lease are stored in `orders_import_state` (or the configured collection name with that suffix). A Shopify page checkpoint advances only after order writes and retry jobs succeed. Restarting an unfinished run resumes its next saved page; a partially written page is safely replayed. Expired Shopify cursors trigger one safe rescan from the first page. Completed runs start a new scan on the next launch. Counts describe acknowledged pages; a crash after writes but before the checkpoint can cause replayed inserts to be counted as existing orders.

To start a completely fresh scan of both sources without deleting orders:

```powershell
node import-orders.js --fresh
```

Set `IMPORT_CONCURRENCY=4` in `.env` to change order preparation concurrency (allowed range 1-16). Higher values do not bypass API limits. The default is four; no `.env` edit is required. The snapshot stage logs each shipment page, followed by per-order results and page summaries. The importer lease prevents two optimized importers writing the same collection concurrently; keep the webhook worker stopped during the import. A process stopped abruptly may leave a lease that takes up to two minutes to expire.

Offline tests cover caching, split-shipment totals, bounded concurrency, rate-limit cooldowns, database races, interrupted scans, page replay, expired cursors, and lease conflicts. These tests do not contact production APIs, modify the live database, or establish a live throughput benchmark.

## Validation

```powershell
npm test
```

Tests use mocked requests and database operations; they do not contact live APIs or write production data. Live Faire field availability, Shopify timeline text, and store-specific matching still need validation against actual orders.

## Brand-funded Faire shipping inferred from payouts

For settled `FREE_SHIPPING_THRESHOLD` orders shipped entirely using Ship with Faire, the importer can infer the shipping deduction as discounted subtotal minus commission minus processing fees minus actual payout. Flat fees are already included in commission/processing totals and are not subtracted twice. This applies only when tax, damage/missing-item adjustments, protection fees, subsidies, and Faire-covered shipping are absent/zero, all required money fields share the configured currency, and no unknown payout fields appear. Other free-shipping reasons, unsettled orders, mixed Faire shipping methods, or nonpositive residuals stay pending.

These amounts are explicitly `status: inferred`, not carrier-reported label costs. `payout_reconciliation` records the inputs and assumption that the remaining deduction is shipping. One aggregate covers all Faire parcels; its amount is never multiplied by the parcel count. Tracking numbers deduplicate mirrored parcels from other sources. Costs for genuinely separate tracked parcels may be added. Product costs stay unallocated/pending if a mixed-product aggregate cannot be split reliably. Retailer-paid shipping cannot be inferred this way and still requires another source or export.

Verified examples: CY429ENTHE produces $50.10; 6QSTBZ7CTE produces $39.96. Existing positive costs remain untouched; rerunning rechecks zero/null/missing costs.

## Faire commission and processing fees

Each recognized Faire order gets a `faire_fees` object from `payout_costs`. Both importer and webhook worker sync fees even when the order already has a positive shipping cost. The importer leaves other order fields unchanged. One fetched Faire response is shared with shipping lookup.

`commission` includes percentage commission and any new-customer flat fee; `processing_fee` includes percentage processing and its flat fee. `total_fees` is their sum. `commission_flat_fee`, `commission_variable_fee`, `commission_percentage`, `processing_flat_fee`, `processing_variable_fee`, and `processing_fee_percentage` expose the components without counting the flat fees twice. Values are numeric amounts in `currency`. For EQ56K26EJZ, commission is $30.09 ($20.09 percentage plus $10 new-customer fee), processing is $4.99, and total fees are $35.08. `finalized` indicates whether Faire reports payment initiated; reported values before that may still change. Missing or currency-mismatched fees stay pending; temporary failures preserve previously reported fees.

## Live webhook service

See [DEPLOYMENT.md](DEPLOYMENT.md) for required subscriptions, environment, recovery and startup. `npm start` runs the service; `npm test` only runs offline tests and does not open a server or access the live database. Live order updates preserve MongoDB enrichment fields, mirror partial/full fulfillment and refunds, and recalculate all applicable shipping sources even when the previous cost was positive. Periodic rechecks include labels created on a different day without waiting for another Shopify webhook.
