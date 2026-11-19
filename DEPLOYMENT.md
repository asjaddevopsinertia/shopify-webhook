# Deploying the live Shopify sync

Use Node.js 22+ and install dependencies with `npm ci`. Deploy this whole directory's JavaScript modules and package files; the webhook server imports shared authentication, shipping, rate-limit and lease helpers. Keep `.env` private and do not deploy local test/debug logs as public assets.

## Environment

Set these on the server (or in `.env` beside `webhook-server.js`):

```dotenv
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_app_client_id
SHOPIFY_CLIENT_SECRET=your_app_client_secret
SHOPIFY_WEBHOOK_SECRET=the_secret_that_signs_these_webhooks
MONGODB_URI=your_mongodb_connection_string
MONGODB_DB=shopify
MONGODB_COLLECTION=orders
SHIPSTATION_API_KEY=your_shipstation_key
SHIPSTATION_API_SECRET=your_shipstation_secret
SHIPPING_COST_CURRENCY=USD
FAIRE_ACCESS_TOKEN=your_faire_token
PORT=7000
HOST=127.0.0.1
```

The Shopify app must be installed on the store in the same organization for the client-credentials grant. It needs order-read access and `read_all_orders` to keep syncing older orders. Release scope changes and approve them on the store. The script exchanges credentials for short-lived access tokens and renews them automatically. Existing process environment values override `.env`.

Use the signing secret from the app or Shopify-admin webhook configuration actually delivering the webhooks. This is not an Admin API access token. If `SHOPIFY_WEBHOOK_SECRET` is omitted, the app client secret is used; this fallback is appropriate only for webhooks signed by that app. When migrating apps, update subscriptions and signing secret together.

Set `SHIPSTATION_STORE_ID` if multiple stores in the ShipStation account reuse order numbers. Both ShipStation credentials are required to enable that source. Configure the Faire access token if you want Faire shipment costs/fees. API errors remain visible as pending diagnostics rather than silently becoming zero shipping costs.

## Webhook subscriptions

Register JSON/HTTPS subscriptions at:

```text
https://YOUR-DOMAIN/webhooks/shopify
```

Subscribe to every topic below, either in the sending app configuration or using its webhook subscriptions. The script does not register them for you:

```text
orders/create
orders/updated
orders/paid
orders/cancelled
orders/fulfilled
orders/partially_fulfilled
fulfillments/create
fulfillments/update
refunds/create
```

The receiver verifies HMAC against the raw body and verifies the shop domain. It saves a durable MongoDB job before responding 200; it does not wait for shipping APIs in the HTTP request. Duplicate deliveries coalesce by Shopify order ID. Jobs refetch the latest Shopify order so late/out-of-order webhook payloads do not roll back the order snapshot. New order snapshots are inserted without duplicate Shopify IDs.

## Shipping on separate days

Every live job scans all Shopify event pages and performs live ShipStation lookups, plus Faire when applicable. The historical importer's positive-cost skip rule does not apply here. A cost of $8 today can become $13.25 tomorrow when a separate $5.25 label appears. The total is recalculated from records rather than added to the previous total. Tracking numbers and source IDs deduplicate mirrored parcels/repeated events.

Names containing marmalade(s) or fruit spread(s) are marmalade; other names are fruit. Existing optional SKU overrides still apply. Fulfillment tracking and shipment items associate parcels with categories. When no direct parcel/item evidence is available on a mixed order, the merchant-confirmed routing is used: Shopify labels are marmalade and ShipStation labels are fruit, marked `category_basis: store_shipping_rule`. Direct evidence of a parcel containing both product groups takes precedence and stays unallocated. Mixed orders stay pending when one category lacks a cost or labels cannot be allocated safely. Observed partial amounts remain in `real_shipping_cost_details`, including `observed_total` and category amounts. If the order already had a resolved positive total and a later API failure/ambiguity occurs, that numeric value is retained as `last_known_total` with `status: pending`; it is not represented as a fresh complete calculation.

Shopify event parsing remains best effort and USD-only. It supports amount-before-label and label-for-amount purchase messages. Unparseable purchases/refunds/voids are recorded as warnings, but do not prevent scanning later pages. These ambiguous totals are not finalized automatically. If Shopify does not expose a label purchase in its API, it cannot be recovered from the admin timeline's appearance alone. Faire's existing brand-funded payout inference and fee calculations remain available and explicitly marked as inferred where appropriate.

## Rechecks and recovery

Defaults (all optional):

| Variable | Default | Behavior |
| --- | ---: | --- |
| `WEBHOOK_WORKERS` | 2 | Concurrent MongoDB queue workers, allowed 1-4 |
| `WEBHOOK_PENDING_MINUTES` | 5 | Eligibility interval for pending/partially fulfilled orders or unresolved Faire fees |
| `WEBHOOK_REFRESH_MINUTES` | 360 | Ongoing eligibility interval even for resolved, fully fulfilled orders |
| `WEBHOOK_RECONCILE_MINUTES` | 5 | Poll recently updated Shopify order IDs to recover missed webhooks |
| `WEBHOOK_RECONCILE_LOOKBACK_HOURS` | 24 | Initial recovery window when no prior watermark exists |
| `WEBHOOK_SEED_PENDING_ORDERS` | 1 | Seed jobs for existing non-cancelled pending/open/mixed MongoDB orders at startup |

Intervals determine when a job becomes eligible, not a guaranteed completion time. API rate limits and queue backlog still apply. A fresh webhook gets higher queue priority than routine rechecks. Shopify label creation or ShipStation activity might not trigger a useful webhook; ongoing rechecks therefore remain enabled with no fixed expiry. Lower the resolved refresh interval if your workload/API capacity allows it and you require faster detection without a webhook.

Startup seeding never postpones existing jobs or resets their leases/revisions. Existing fully fulfilled single-category orders with positive costs and no existing jobs are not all reprocessed at startup; subsequent updates/recovery scans enqueue them. Mixed orders are seeded even if their old cost is positive. For historical backfill, use the importer separately.

The updated-order recovery watermark is stored in `orders_import_state` (using the configured collection-name prefix). On restart, it resumes from the last completed window with a five-minute overlap. Each window follows all pages and advances its watermark only after queue writes succeed. This recovers order changes during downtime; a first-ever deployment only scans its configured lookback window. It does not automatically fetch all historical orders.

Importer and webhook service share a collection-level lease. Run one service instance, with its configured internal worker count, and stop it before running `import-orders.js`. After an abrupt shutdown, a lease/job lock may take up to two minutes to expire. SIGTERM/SIGINT stop receiving new work, drain active jobs and release the lease. Persistent jobs survive restarts. A failed source does not block order-status mirroring; inspect job `lastError`/`lastShippingError`, `faire_fee_sync`, and shipping warnings for unresolved costs.

## Starting and checking the service

After configuring subscriptions and environment, start it yourself with your hosting platform's process supervisor:

```sh
npm start
```

Configure automatic restart on failure. `/health` checks MongoDB connectivity and the service lease. From the same host, check it with:

```sh
curl http://127.0.0.1:7000/health
```

For a local nginx reverse proxy, a sample route is:

```nginx
location /webhooks/shopify {
    proxy_pass http://127.0.0.1:7000;
    proxy_set_header Host $host;
    client_max_body_size 10m;
}
```

Terminate public HTTPS at the proxy/platform. Use `HOST=0.0.0.0` instead when a container needs to accept connections from outside its own loopback interface. Do not expose MongoDB or credentials through the HTTP service.

## Verification performed

`npm test` uses mocked Shopify/ShipStation/Faire requests, in-memory database operations and direct HTTP-handler calls. It does not start the server or contact production data. Tests cover raw-body authentication, queue failures, duplicate deliveries, new/partial/full fulfillment updates, refunds, shipping labels added on different days, refreshing positive totals, source failures, revision/lease races, missed-webhook recovery, and startup seeding. Deployment subscriptions, signing-secret correctness and real API field availability still need verification on the deployed service.

## Manual shipping payments in Shopify timeline comments

The live worker reads paginated Shopify GraphQL `CommentEvent` records alongside the existing shipping sources. Use an explicit USD payment statement:

```text
We paid $51.36 for shipping
```

Without a category or tracking number, this is the complete order shipping total. It replaces the source-calculated total; Shopify, ShipStation and Faire costs are not added again. On mixed fruit/marmalade orders the amount is stored in `real_shipping_cost` and `real_shipping_cost_details.unallocated`, without guessing a product split. Single-category orders allocate it to that category. The comment ID, text and method are retained for audit.

For a payment covering just one parcel, include its tracking number, for example `We paid $12.50 for shipping tracking: 1Z1234567890123456`. Matching tracking numbers are deduplicated. Conflicting costs remain pending. Category-specific comments can say `We paid $12.50 for marmalade shipping`; tracking is needed when other shipping records exist.

Keep only one whole-order payment comment: edit the existing comment instead of appending a replacement. Multiple whole-order totals remain pending. Estimates, customer payments, refund statements and ambiguous amounts are not accepted as final shipping costs. Removing a comment does not automatically erase a previously saved positive cost, following the worker's existing preservation behavior.

Comments are checked on the next queued order sync or scheduled refresh; do not rely on a comment alone delivering an immediate order webhook. Existing defaults retry pending orders every five minutes and refresh resolved orders every six hours. Deploy `manual-shipping.js`, `shipping-costs.js` and `import-orders.js` together and restart the webhook service. No additional environment variables are needed. The historical importer still preserves existing positive costs.
