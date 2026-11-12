import { parseCairoDateTime } from './content.js';

export const reportingPeriods = [1, 7, 30, 90];
const maximumDays = 366;
const dayMilliseconds = 86400000;
const cairoDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Cairo' });

function validDate(value) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value ?? '') || value < '2000-01-01') return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function addCalendarDays(value, days) {
  return new Date(Date.parse(value + 'T12:00:00Z') + days * dayMilliseconds).toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return Math.round((Date.parse(end + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / dayMilliseconds) + 1;
}

function startOfDay(value) {
  // Cairo's spring clock change can skip midnight. Use the first valid hour.
  for (let hour = 0; hour < 4; hour++) {
    const seconds = parseCairoDateTime(value + 'T' + String(hour).padStart(2, '0') + ':00');
    if (seconds !== null) return seconds;
  }
  throw new Error('Reporting date is unavailable.');
}

function window(startDate, endDate) {
  const untilDate = addCalendarDays(endDate, 1);
  return { startDate, endDate, untilDate, start: startOfDay(startDate), end: startOfDay(untilDate), days: daysBetween(startDate, endDate) };
}

function allowedRange(start, end, today) {
  return validDate(start) && validDate(end) && start <= end && end <= today && daysBetween(start, end) <= maximumDays;
}

function previousYear(value) {
  const [year, month, day] = value.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return [year - 1, String(month).padStart(2, '0'), String(Math.min(day, lastDay)).padStart(2, '0')].join('-');
}

export function dateRangeLabel(period) {
  const format = (value, year) => new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(new Date(value + 'T12:00:00Z'));
  if (period.startDate === period.endDate) return format(period.startDate, true);
  return format(period.startDate, period.startDate.slice(0, 4) !== period.endDate.slice(0, 4)) + ' – ' + format(period.endDate, true);
}

export function reportingRange(url, now = new Date()) {
  const today = cairoDate.format(now);
  const requestedDays = Number(url.searchParams.get('days'));
  const preset = reportingPeriods.includes(requestedDays) ? requestedDays : 30;
  let start = addCalendarDays(today, 1 - preset);
  let end = today;
  let custom = false;
  let error = '';
  if (url.searchParams.has('start') || url.searchParams.has('end')) {
    const requestedStart = url.searchParams.get('start');
    const requestedEnd = url.searchParams.get('end');
    if (allowedRange(requestedStart, requestedEnd, today)) {
      start = requestedStart;
      end = requestedEnd;
      custom = true;
    } else error = 'Choose a valid date range of up to 366 days, ending today or earlier.';
  }
  const current = window(start, end);
  let comparison = url.searchParams.get('compare') ?? 'previous';
  if (!['previous', 'year', 'custom', 'none'].includes(comparison)) comparison = 'previous';
  let previous = null;
  if (comparison === 'custom') {
    const comparisonStart = url.searchParams.get('compare_start');
    const comparisonEnd = url.searchParams.get('compare_end');
    if (allowedRange(comparisonStart, comparisonEnd, today)) previous = window(comparisonStart, comparisonEnd);
    else {
      error ||= 'Choose valid comparison dates, up to 366 days.';
      comparison = 'previous';
    }
  }
  if (comparison === 'previous') previous = window(addCalendarDays(start, -current.days), addCalendarDays(start, -1));
  if (comparison === 'year') previous = window(previousYear(start), previousYear(end));
  return {
    today, current, previous, comparison, custom, error, days: current.days,
    label: custom ? dateRangeLabel(current) : preset === 1 ? 'Today' : 'Last ' + preset + ' days',
    previousLabel: previous ? dateRangeLabel(previous) : '',
  };
}

export function periodLink(url, values) {
  const target = new URL(url);
  for (const key of ['days', 'start', 'end', 'compare', 'compare_start', 'compare_end']) target.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) target.searchParams.set(key, String(value));
  return target.pathname + target.search;
}

export function metricChange(current, previous, points = false) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return { label: '—', direction: 'neutral', description: 'No comparable data for this period' };
  const difference = current - previous;
  if (Math.abs(difference) < 0.000001) return { label: 'No change', direction: 'neutral', description: 'Unchanged from the comparison period' };
  const direction = difference > 0 ? 'up' : 'down';
  if (!points && previous === 0) return { label: 'New', direction, description: 'No value was recorded in the comparison period' };
  const amount = points ? difference : 100 * difference / Math.abs(previous);
  const number = Math.abs(amount).toLocaleString('en-GB', { maximumFractionDigits: 1 });
  return { label: (difference > 0 ? '+' : '−') + number + (points ? ' pp' : '%'), direction,
    description: points ? 'Percentage-point change from the comparison period' : 'Change from the comparison period' };
}
