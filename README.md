# UNLISTED™ Cloudflare store

An Astro storefront and owner dashboard on Cloudflare Workers, D1 and R2. The storefront adapts the supplied Final website theme ZIP and the public UNLISTED catalog captured on November 9, 2026. Theme styles, fonts and brand artwork are served locally. The shipping and returns copy comes from the published store.

## Local development

Use Node 24 and curl.

~~~sh
npm ci
npm run db:local
npm run catalog:local
npm run build
npx wrangler dev
npm test
~~~

The catalog importer copies images and both collection films to R2 and adds six public products, twelve variants, collection membership, and policy pages to D1. Re-running it preserves merchant edits. The transfer archive includes the original media in the local import cache for an offline restore. Imported availability reflects the public storefront. Exact inventory starts unverified. The site serves the copied media from R2 and uses D1 for commerce.

## Deploy to the existing Worker

The checked-in bindings target the existing UNLISTED Worker, the `unlisted-store-staging` D1 database, and the `unlisted-store-media` R2 bucket. Cloudflare Workers Builds compiles Astro during dependency installation so the default Wrangler deploy command uses the generated Worker configuration. The Worker initializes the password, return, and migration tables in existing databases.

For a manual deployment, sign in with Wrangler or supply account-scoped CI credentials. Override `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_D1_DATABASE_NAME`, and `CLOUDFLARE_R2_BUCKET` when using a different staging database and bucket. Use `--bootstrap-catalog` only to initialize a new database.

~~~sh
npm ci
npm run build
npm run deploy -- --bootstrap-catalog
~~~

Verify https://unlisted-website.unlisted-yh.workers.dev/api/health and the public store routes. The deploy command targets the existing Worker and declares no custom domain. The repository workflow tests every pull request and can deploy main when the UNLISTED_DEPLOY_ENABLED repository variable is true. Configure CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the cloudflare GitHub environment and set the database ID in its variables. Use one active deployment pipeline for the Worker.

## Merchant setup

- Set ADMIN_EMAILS to the approved owner address and ADMIN_ORIGIN to the exact HTTPS origin for the owner dashboard. The private owner link opens the password setup form. Save the password and sign in with it. Signed-in owners can change their password from the dashboard.
- Set EMAIL_FROM and RESEND_API_KEY in Cloudflare using a verified sender for customer sign-in, receipts, and owner email recovery.
- Confirm stock and delivery rates in the dashboard. Add each approved Egyptian governorate rate and any active discount codes. The public Shopify catalog has no stock counts or merchant shipping rates.
- Use a dedicated website test integration in the existing Paymob merchant account. Set the test secret, public key, integration IDs, HMAC secret, and `PAYMENT_ORIGIN` as Worker secrets. See `.env.example` and the [Paymob credential guide](https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials). The dashboard lists the Worker webhook and return URLs. Test hosted checkout and the signed callback in Paymob test mode before configuring live credentials. Cash on delivery can be enabled independently.
- Checkout requires both CHECKOUT_ENABLED=true in the Worker and the dashboard checkout switch. Keep the merchant gates closed while the existing store and the replacement share inventory. Perform the final inventory reconciliation at cutover.
- Customers can request a refund or size exchange from a delivered order. Review each request in Website → Returns. Approval reserves a replacement size, and receipt can restore the original stock. For refunds, complete the payment through Paymob or the courier, then record the confirmed amount and reference in the request.

## Shopify data and cutover

Export `orders.csv`, `customers.csv`, `products.csv`, `inventory.csv` and optionally `discounts.csv` from Shopify into a private directory. Prepare the snapshot with `python3 scripts/prepare-shopify-import.py .local/merchant-exports .local/merchant-exports/migration.json`. Upload it from Website → Shopify migration in the signed-in dashboard. Check the counts on the confirmation page and reconcile any untracked sizes. Initial stock import fills unverified values and preserves verified counts.

Historical orders appear in the Shopify archive and in customer accounts after email verification. New checkout, fulfillment and analytics use the replacement store's records. The imported Shopify promotions are available for review in Discounts. The checkout uses the promotion rules you enable in the new dashboard.

Verify the staged mobile storefront, merchant settings, test checkout and rollback before requesting approval for any domain or subscription change. Keep Shopify credentials and exported customer data out of Git.
