import { all } from './db.js';

const details = `
  p.*,
  (SELECT json_group_array(json_object(
    'id', id, 'title', title, 'sku', sku, 'options', json(options), 'price', price,
    'compare_at', compare_at, 'inventory', inventory, 'published_available', published_available,
    'active', active, 'position', position
  )) FROM (SELECT * FROM variants WHERE product_id = p.id ORDER BY position, id)) AS variants_json,
  (SELECT json_group_array(json_object(
    'key', media_key, 'alt', alt, 'position', position, 'variant_id', variant_id
  )) FROM (SELECT * FROM product_images WHERE product_id = p.id ORDER BY position, media_key)) AS images_json
`;

function parseProduct(row, admin = false) {
  if (!row) return null;
  const { variants_json, images_json, ...product } = row;
  const variants = JSON.parse(variants_json);
  return {
    ...product,
    option_names: JSON.parse(product.option_names),
    variants: admin ? variants : variants.filter((variant) => variant.active),
    images: JSON.parse(images_json),
  };
}

export function available(variant) {
  return Boolean(variant.active && (variant.inventory === null ? variant.published_available : variant.inventory > 0));
}

export async function storeSettings(db) {
  const row = await db.prepare('SELECT * FROM store_settings WHERE id = 1').first();
  return { ...row, navigation: JSON.parse(row.navigation), socials: JSON.parse(row.socials) };
}

export function getSettings(context, db) {
  context.locals.storeSettings ??= storeSettings(db);
  return context.locals.storeSettings;
}

export async function getProduct(db, handle, admin = false) {
  const visibility = admin ? '' : "AND p.status = 'active'";
  const row = await db.prepare(`SELECT ${details} FROM products p WHERE p.handle = ? ${visibility}`).bind(handle).first();
  return parseProduct(row, admin);
}

export async function featuredProducts(db, group) {
  const rows = await all(db.prepare(`
    SELECT ${details} FROM products p
    WHERE p.status = 'active' AND p.featured = 1 AND (? IS NULL OR p.category = ?)
    ORDER BY p.position, p.handle LIMIT 100
  `).bind(group ?? null, group ?? null));
  return rows.map((row) => parseProduct(row));
}

export async function getCollection(db, handle) {
  const collection = await db.prepare('SELECT * FROM collections WHERE handle = ? AND active = 1').bind(handle).first();
  if (!collection) return null;
  const products = await all(db.prepare(`
    SELECT ${details} FROM collection_products cp JOIN products p ON p.id = cp.product_id
    WHERE cp.collection_handle = ? AND p.status = 'active' ORDER BY cp.position, p.position LIMIT 100
  `).bind(handle));
  return { ...collection, products: products.map((row) => parseProduct(row)) };
}

export async function lookupPage(db, handle, admin = false) {
  return db.prepare('SELECT * FROM pages WHERE handle = ?' + (admin ? '' : ' AND active = 1')).bind(handle).first();
}

export const cozyMatch = {
  'cozy-hoodie-grey': 'cozy-straight-leg-sweats-grey',
  'cozy-straight-leg-sweats-grey': 'cozy-hoodie-grey',
};

export async function searchProducts(db, terms) {
  const words = terms.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const rows = await all(db.prepare(`
    SELECT ${details} FROM products p WHERE p.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(?) keyword WHERE instr(lower(p.title || ' ' || p.category), keyword.value) = 0
    ) ORDER BY p.position, p.handle LIMIT 24
  `).bind(JSON.stringify(words)));
  return rows.map((row) => parseProduct(row));
}
