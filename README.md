# UNLISTED™ shop

Storefront + admin for unlisted-shop.com. Astro (SSR) on Cloudflare Workers, Supabase (DB/auth), Resend (email), Paymob (cards/wallets).
Goal: $0/month platform fees. Shopify stays live until the owner approves cutover (Phase 2).

## Status
| Step | What | State |
|---|---|---|
| 1 | Scaffold, theme CSS/fonts/logos copied from the Shopify theme | done |
| 3–6 | Home, collections, product (variants, size select, pre-order), cart, size-guide modal, static pages | done (local-tested) |
| 2 | DB schema + RLS (`supabase/migrations/001_core.sql`) + 7 RLS tests | done, applied to Supabase project `unlisted-shop` (ref zubyfzcrfxripboefban, Frankfurt) |
| 2b | Catalog loaded into Supabase (`supabase/seed.sql`: 3 collections, 6 products, 12 variants, 27 images) | done; storefront now reads Supabase live (falls back to `seed.json` if unreachable). Not yet verified from a deployed site |
| 2c | Shipping rates for 27 governorates loaded (80/110/130/150 EGP). 8 are from your past orders (Cairo, Giza, Alexandria, Suez 80; Qalyubia, Menofia 110; Minya 130; Matrouh 150), the other 19 are ESTIMATES by region: confirm or edit |
| 7+ | Checkout/COD, emails, admin, Paymob, abandoned carts, import | next |

## Run locally
```
npm install
python3 scripts/make_seed.py path/to/products_export.csv   # regenerates src/data/seed.json
npm run dev        # http://localhost:4321
npm test           # RLS tests (in-process Postgres, no accounts needed)
npm run build
```

## Where things live
- `public/css/*` – original Shopify theme CSS (fonts/logos re-pointed to `/fonts`, `/img`). Edit here to change the look.
- `src/layouts/Base.astro` – header, menu, footer, size-guide modal.
- `src/pages/` – routes. `index`, `collections/[slug]`, `products/[handle]` (pre-order products show the registration form), `cart`, `checkout` (placeholder), `pages/*`, `api/*`.
- `src/lib/catalog.ts` – product data. Reads `src/data/seed.json` now; switches to Supabase in step 2 wiring.
- `src/lib/pages.ts` – text of Shipping/About/Contact (moves to the admin page editor later).
- `public/js/site.js` – cart (localStorage), menu, size guide. `product.js`, `cart-page.js`, `forms.js` – page scripts.
- `supabase/migrations/` – SQL. `tests/` – tests.

## Old links
`/?collection=hoodies` → `/collections/hoodies`, `/?preorder=<handle>` → `/products/<handle>` (301).

## Known gaps / notes
- Product images and the hero video still load from Shopify's CDN. They move to our own storage before cutover (otherwise they break when Shopify is cancelled).
- Pre-order = free registration (name, email, WhatsApp, size, consent), same as the live site. Stored in `preorder_requests`.
- Cart prices are re-checked on the server at checkout (step 7); never trust the browser.
- Secrets: see `.env.example`. Never commit `.env`.
