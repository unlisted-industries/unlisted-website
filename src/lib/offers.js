export const hoodieHandle = 'cozy-hoodie-grey';
export const sweatsHandle = 'cozy-straight-leg-sweats-grey';
export const cozyHandles = [hoodieHandle, sweatsHandle];
export const saleStartsAt = Date.parse('2026-11-27T00:00:00+02:00');
export const saleEndsAt = Date.parse('2026-11-29T00:00:00+02:00');
export const salePrice = 44900;
export const setRegularPrice = 115000;
export const setPrice = 99900;

export function blackFridayActive(now = Date.now()) {
  return now >= saleStartsAt && now < saleEndsAt;
}

export function offerPrice(handle, price, now = Date.now()) {
  return cozyHandles.includes(handle) && blackFridayActive(now) ? salePrice : price;
}
