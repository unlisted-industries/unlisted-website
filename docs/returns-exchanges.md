# UNLISTED Returns & Exchanges

Customer route: `/returns` (`?lang=ar` for Arabic). Owner route: `/admin/returns`.

This additive upgrade preserves native orders, historical imports, earlier return records, inventory bindings, payment credentials and the existing finance workspace. Migration 0014 is initialized idempotently through the Worker and can also be applied through normal migrations. No catalog bootstrap, source reimport or inventory reset is required.

## Implemented

- Verified-email order access, historical/native order search, selected quantities and products, cross-product/size/color replacement choices, structured reasons, server-calculated discount allocations and explicit price review.
- Up to three private JPEG/PNG/WebP attachments; authenticated owner access only. Uploads are outside the public commerce media routes.
- Atomic quantity guards shared with earlier returns; atomic replacement reservation and release; inspected restock once; linked replacement work orders and tracking.
- Automatic provisional approval for paid, delivered, fully evidenced eligible orders. Inspection and settlement require explicit evidence. Configurable extended windows cannot reduce the statutory 14/30-day minima; statutory cases have no return fee. Out-of-window claims are accepted for review rather than silently discarded.
- Historical source evidence review, optional exact inventory matching and original cost evidence, revised quote confirmation by the verified customer before owner approval. Imported records are not rewritten.
- Optional personal store credit backed by a balance. Checkout requires the verified owner of that credit; partial use preserves the remainder, and cancellation restores credit once. Split-tender returns remain held for reconciliation.
- Owner actions, tracking, references, policies and customer consent have an immutable activity history. Request transitions use optimistic concurrency. Customer email outbox is atomic with request transitions and retried by the existing cron.
- Finance reports include RMA refund/exchange adjustments, store-credit liability and redemption, inspected inventory cost reversals, replacement COGS and recorded shipping costs. No synthetic cash journals are posted.
- Bilingual consumer rights content links to the official Egyptian agency. Its logo is not used because permission has not been established.

## Provider activation

Secrets remain server-side. Nothing in this file is a credential.

- Paymob refund adapter uses the existing `PAYMOB_SECRET_KEY`; enable only after merchant verification with `PAYMOB_RMA_REFUNDS_ENABLED=true`. Only a single captured original native transaction can be used. Exact refunds must fit the remaining paid balance. An uncertain result is never resent automatically; reconcile it against Paymob.
- Bosta requires `BOSTA_API_KEY`, `BOSTA_BUSINESS_LOCATION_ID`, and `RMA_SHIPPING_ENABLED=true`. Book customer-return pickups (type 25) and replacement deliveries (type 10) after verifying service/address information. Money movements are settled separately; courier booking uses zero COD.
- ShipBlu requires `SHIPBLU_API_KEY`, `SHIPBLU_PACKAGE_SIZE`, and `RMA_SHIPPING_ENABLED=true`. The owner supplies the verified courier zone ID. Return and delivery adapters use documented `/api/v1/returns/` and `/api/v1/delivery-orders/` resources. Provider-created tracking is polled by cron; returned-stock condition still requires inspection.
- Aramex has manual tracking support and is reserved for a future native adapter.
- Missing credentials leave manual settlement and shipping recording available. A configured adapter is not evidence of a successfully tested merchant service. Provider errors, timeouts and ambiguous successes are held for reconciliation, with a unique operation per case/direction.

## Verification and limits

Production build, Wrangler deployment dry-run, and 40 local regression/integration checks passed before publishing. Checks use isolated D1/R2 and mocked email/payment/courier services. They cover authentication, cross-origin protection, exact allocations, request replay, private attachments, concurrent replacement reservations, duplicate restock prevention, credit issuance/use/release, provider duplicate protection and uncertain outcomes, and historical quote review/consent.

No real refund or paid courier booking was used in these checks. Live provider activation, positive merchant sandbox tests, and live responsive verification must be reported separately. Existing historical evidence may require owner reconciliation. This implementation does not certify comprehensive legal compliance.
