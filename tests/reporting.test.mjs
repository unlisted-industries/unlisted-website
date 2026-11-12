import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCalendarDays, metricChange, periodLink, reportingRange } from '../src/lib/reporting.js';

const currentTime = new Date('2026-11-12T07:00:00Z');
const range = (query, now = currentTime) => reportingRange(new URL('https://unlisted.test/admin/analytics?' + query), now);

test('reporting presets use inclusive Cairo calendar days and an equal preceding period', () => {
  const result = range('days=7');
  assert.equal(result.current.startDate, '2026-11-06');
  assert.equal(result.current.endDate, '2026-11-12');
  assert.equal(result.current.days, 7);
  assert.equal(result.previous.startDate, '2026-10-30');
  assert.equal(result.previous.endDate, '2026-11-05');
  assert.equal(new Date(result.current.start * 1000).toISOString(), '2026-11-05T22:00:00.000Z');
  assert.equal(new Date(result.current.end * 1000).toISOString(), '2026-11-12T22:00:00.000Z');
  assert.equal(range('days=1', new Date('2026-11-11T23:30:00Z')).current.startDate, '2026-11-12');
});

test('custom periods and independently chosen comparison dates remain bounded', () => {
  const result = range('start=2026-10-01&end=2026-10-15&compare=custom&compare_start=2026-08-01&compare_end=2026-08-15');
  assert.equal(result.days, 15);
  assert.equal(result.comparison, 'custom');
  assert.equal(result.previous.startDate, '2026-08-01');
  assert.equal(result.previous.endDate, '2026-08-15');
  assert.equal(result.current.untilDate, '2026-10-16');
  assert.equal(result.error, '');
  for (const bad of ['start=2026-02-30&end=2026-03-01', 'start=2026-11-12&end=2026-11-01', 'start=2024-01-01&end=2026-11-12', 'start=2026-11-01&end=2027-01-01']) {
    assert.ok(range(bad).error);
    assert.equal(range(bad).days, 30);
  }
});

test('reporting boundaries handle Cairo daylight saving and leap years', () => {
  const spring = range('start=2026-04-24&end=2026-04-24');
  assert.equal(spring.current.end - spring.current.start, 23 * 3600);
  assert.equal(new Date(spring.current.start * 1000).toISOString(), '2026-04-23T22:00:00.000Z');
  const autumn = range('start=2026-10-29&end=2026-10-29');
  assert.equal(autumn.current.end - autumn.current.start, 25 * 3600);
  const leap = range('start=2024-02-29&end=2024-03-02&compare=year');
  assert.equal(leap.previous.startDate, '2023-02-28');
  assert.equal(leap.previous.endDate, '2023-03-02');
  assert.equal(addCalendarDays('2024-02-28', 1), '2024-02-29');
});

test('comparison percentages avoid a fictitious percentage when the baseline is zero', () => {
  assert.equal(metricChange(15, 10).label, '+50%');
  assert.equal(metricChange(0, 10).label, '−100%');
  assert.equal(metricChange(10, 0).label, 'New');
  assert.equal(metricChange(0, 0).label, 'No change');
  assert.equal(metricChange(5, 2, true).label, '+3 pp');
  assert.equal(metricChange(null, 2, true).label, '—');
  assert.equal(range('compare=none').previous, null);
});

test('preset links replace old date parameters and preserve unrelated page context', () => {
  assert.equal(periodLink(new URL('https://unlisted.test/admin/analytics?start=2026-10-01&end=2026-10-15&compare_start=2026-09-01&filter=paid'), { days: 7, compare: 'previous' }), '/admin/analytics?filter=paid&days=7&compare=previous');
});
