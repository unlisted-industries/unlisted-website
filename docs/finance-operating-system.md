# UNLISTED finance operating system

This extends the existing Astro Worker, D1 database, R2 bucket, owner sign-in, products, orders and returns. The storefront design is retained.

## Accounting and operations

- Money is stored as integer Egyptian piastres. Manual journals must balance and cannot be edited or deleted; corrections use audited reversals.
- Expenses, inventory purchases, supplier invoices/payments, owner contributions/withdrawals, loans, transfers and Meta bill payments have separate accounting treatment.
- Bank/cash reports are dated observations, not revenue. Cash estimates reflect subsequent manual entries. Stale or missing balances block safe-spending estimates.
- Native revenue is recognized on delivery; payment collections and customer advances are separate. Historical Shopify fulfillment/order dates are explicitly provisional where delivery/refund/settlement evidence is missing.
- Current unit costs are versioned. New order lines capture their cost; old unknown costs must be explicitly supplied. Restocked refunds reverse known COGS; replacement exchanges capture an additional replacement cost. Existing commerce code still controls physical returns and cancellation stock.
- Batch receipt atomically increases verified stock, recalculates weighted average cost and records supplier debt once. Do not also enter a second supplier invoice for the same batch.
- PR gifts consume stock once and record product cost, collaboration fees and shipping. Configurable thresholds drive factory alerts; no daily stock count is requested.

## Imports and AI

Text, CSV, images, PDF, office documents and audio are accepted by the review workflow. Plain CSV imports work without AI. Rich files use Workers AI Markdown conversion; audio uses Whisper; extraction and advisory analysis use a configurable FINANCE_TEXT_MODEL (default @cf/qwen/qwen3.8-27b). No model is silently given a license-acceptance request.

Original files use private-finance/ keys and are excluded from the public commerce media route. The R2 bucket must not have public bucket access enabled. Only signed-in owners can download source documents. No imported transaction posts until reviewed and confirmed. Exact files and repeated posting sources are deduplicated; similar transactions require explicit duplicate review.

## Meta

Set server-side META_ACCESS_TOKEN (ads_read), META_AD_ACCOUNT_ID (act_...), and optionally META_API_VERSION (default v27.0). The account must use EGP and Africa/Cairo. Insights refresh every six hours; manual sync refreshes the last 30 days. Official-API spending, Meta attribution, linked collections, CPA and contribution are distinct. Configure campaign links using utm_id/campaign_id in ad destination URLs; the site captures a seven-day campaign cookie only when analytics is allowed. Historical attribution can be entered with evidence.

Meta bill payments use ad_payment and are not a second advertising expense. Legacy/manual advertising expenses overlapping API data remain flagged for review; no amounts are silently assumed to match. Marketing creation/budget modification is outside this phase.

## Reminders and alerts

The existing 15-minute Worker cron checks the Cairo calendar. At 21:00 it creates one daily balance reminder and an idempotent email outbox item per approved owner. RESEND_API_KEY and EMAIL_FROM are reused. Provider acceptance is tracked; the ChatGPT reminder must not be disabled until app delivery is verified. In-app alerts and device notifications while open are supported; background web push needs a separate push service. Stock and cash-risk alerts are conditional and re-arm only after recovery.

## Deployment and validation

Run npm ci, npm run build, npm test, and npm run deploy -- --dry-run. GitHub main remains Cloudflare Workers Builds' production source. Migrations 0011 and 0012 are additive; the Worker can initialize them for existing databases, keeping trigger bodies intact. No catalog bootstrap or data reset is needed.

Before deploying, retain the D1 recovery bookmark and compare product/variant/order/history/customer counts afterward. Financial inputs (balances, original unit costs, supplier debts, fees, opening investment) must come from the owner, never fixtures or estimates inserted into production.

Prepared on 2026-11-14. A private pre-deployment recovery checkpoint is retained separately. Never automatically restore an earlier database state or discard newer commerce activity.
