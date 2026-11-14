import { currentUser } from './auth.js';
import { statements } from './db.js';
import { StoreError, textValue } from './http.js';

export async function saveCustomerProfile(env, context, form) {
  const user = await currentUser(env, context);
  if (!user) throw new StoreError('Sign in to update your profile.', 401);
  const name = textValue(form, 'name', 100);
  const phone = textValue(form, 'phone', 24, false);
  if (phone && (!/^\+?[\d ()-]{8,24}$/.test(phone) || phone.replace(/\D/g, '').length < 8)) throw new StoreError('Enter a valid phone number.');
  const values = ['address', 'city', 'governorate'].map((key) => textValue(form, key, key === 'address' ? 350 : 100, false));
  await statements(env.DB, [
    ['UPDATE customers SET name = ? WHERE id = ?', name, user.id],
    [`INSERT INTO customer_profiles (customer_id, phone, address, city, governorate) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET phone=excluded.phone, address=excluded.address,
      city=excluded.city, governorate=excluded.governorate, updated_at=unixepoch()`, user.id, phone, ...values],
  ]);
}
