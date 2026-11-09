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

1. Authorize GitHub write access for unlisted-industries/unlisted-website and Cloudflare access for the account containing unlisted-website. Provision the D1 database and R2 bucket or confirm the existing resources. Default names are unlisted-store and unlisted-store-media.
2. Set CLOUDFLARE_D1_DATABASE_ID in the deployment environment. Use CLOUDFLARE_D1_DATABASE_NAME and CLOUDFLARE_R2_BUCKET if the resources use different names. Use Cloudflare CLI sign-in or account-scoped CI secrets.
3. Run the one-time bootstrap.

~~~sh
npm ci
npm run build
npm run deploy -- --bootstrap-catalog
~~~

Verify https://unlisted-website.unlisted-yh.workers.dev/api/health and the public store routes. The deploy command targets the existing Worker and declares no custom domain. The repository workflow tests every pull request and can deploy main when the UNLISTED_DEPLOY_ENABLED repository variable is true. Configure CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the cloudflare GitHub environment and set the database ID in its variables. Use one active deployment pipeline for the Worker.

## Merchant setup

- Set ADMIN_EMAILS to the approved owner address and ADMIN_ORIGIN to the exact HTTPS origin for owner passkeys. Sign in once with a private owner link, then add a passkey from the dashboard. Owner passkeys are tied to that origin.
- Set EMAIL_FROM and RESEND_API_KEY in Cloudflare using a verified sender for customer sign-in, receipts, and owner email recovery.
- Confirm stock and delivery rates in the dashboard. Add each approved Egyptian governorate rate and any active discount codes. The public Shopify catalog has no stock counts or merchant shipping rates.
- Configure the Paymob test secret, public key, integration IDs, HMAC secret, and PAYMENT_ORIGIN. See .env.example. Test a hosted card payment and a signed callback with the staging Worker. Cash on delivery can be enabled independently.
- Checkout requires both CHECKOUT_ENABLED=true in the Worker and the dashboard checkout switch. Keep the merchant gates closed while the existing store and the replacement share inventory. Perform the final inventory reconciliation at cutover.
- Order refunds are recorded after the merchant completes them in Paymob or with the courier. Shipping status and tracking references are maintained in the dashboard.

## Shopify data and cutover

The live store data is read-only during migration. For authenticated inventory, provide Shopify access with product and inventory read scopes and run node scripts/shopify-export.mjs inventory. Review the private SQL output under .local/shopify, then apply it to D1. Initial stock import only fills unverified values. Untracked and backorder variants require merchant review.

The history mode exports accessible orders and customer emails with the corresponding protected-data scopes. Import history.sql privately into D1 to populate the Shopify archive in admin. Shopify may require all-orders access for older history. Legacy records do not affect current orders, inventory, or new-store analytics. Customers sign in with new email links.

Verify the staged mobile storefront, merchant settings, test checkout and rollback before requesting approval for any domain or subscription change. Keep Shopify credentials and exported customer data out of Git.
