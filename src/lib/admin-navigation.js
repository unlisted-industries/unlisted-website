export const workspaceSections = [
  { key: 'website', label: 'Website', description: 'Manage your store, catalog, orders, and customers.' },
  { key: 'finance', label: 'Finance', description: 'Track paid revenue and order value.' },
  { key: 'marketing', label: 'Marketing', description: 'Review store traffic, conversion, and promotions.' },
  { key: 'automations', label: 'Automations', description: 'See your business workflows.' },
];

export const websiteSections = [
  { key: 'orders', label: 'Orders' },
  { key: 'returns', label: 'Returns & exchanges' },
  { key: 'products', label: 'Products', children: [
    { key: 'collections', label: 'Collections' },
    { key: 'inventory', label: 'Inventory' },
  ] },
  { key: 'customers', label: 'Customers' },
  { key: 'discounts', label: 'Discounts' },
  { key: 'content', label: 'Content', children: [{ key: 'media', label: 'Files' }] },
  { key: 'analytics', label: 'Analytics' },
  { key: 'online-store', label: 'Online Store' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'settings', label: 'Settings', children: [{ key: 'shipping', label: 'Shipping' }, { key: 'migration', label: 'Shopify migration' }] },
];
