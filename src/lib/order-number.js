// Customer-facing order number. Orders placed before numbering existed fall back to their short ID.
export const orderNo = (order) => Number.isInteger(order?.number) && order.number > 0
  ? '#' + order.number
  : '#' + String(order?.id ?? '').slice(0, 8).toUpperCase();
