// Fixed-offset local-time helpers for the organization's deployment
// (Arabia Standard Time, UTC+3, no DST) -- shared by every place the
// Reports feature interprets a browser date-range input, buckets a trend
// by calendar day/hour, or displays a timestamp. A single source of truth
// here is the whole point: the add-on brief that requested this page
// reports twice-shipped bugs where filtering and bucketing each
// reinterpreted local time a different, ad-hoc way and disagreed with each
// other as a result.
const ORG_UTC_OFFSET_MINUTES = 180; // UTC+3, Saudi Arabia -- fixed, no DST

// SQLite date-modifier fragment for shifting a UTC-stored timestamp into
// the org's local time inside a query (strftime's own modifier syntax,
// e.g. strftime('%Y-%m-%d', created_at, '+3 hours')).
const SQLITE_LOCAL_MODIFIER = '+3 hours';

// A bare "YYYY-MM-DD" from <input type=date> has no timezone marker --
// must be read as the ORG's local midnight, not UTC midnight, then
// converted to the UTC instant that represents for querying a UTC-stored
// column. (local midnight = UTC midnight minus the offset, since the org
// is ahead of UTC.)
function localDateStartToUtcIso(dateOnly) {
  const asIfUtcMidnight = new Date(`${dateOnly}T00:00:00.000Z`);
  return new Date(asIfUtcMidnight.getTime() - ORG_UTC_OFFSET_MINUTES * 60000).toISOString();
}

// Same, but the last instant of that local calendar day (inclusive upper
// bound) -- local 23:59:59.999, converted to its UTC equivalent.
function localDateEndToUtcIso(dateOnly) {
  const asIfUtcEnd = new Date(`${dateOnly}T23:59:59.999Z`);
  return new Date(asIfUtcEnd.getTime() - ORG_UTC_OFFSET_MINUTES * 60000).toISOString();
}

// SQL expression fragments for bucketing a UTC-stored timestamp column by
// the org's local calendar day / hour / month, for use directly inside a
// GROUP BY. Never bucket with a raw `strftime('%H', col)` (no modifier) or
// a JS `.slice()` on the stored string -- both silently bucket by UTC and
// can attribute a record to the wrong local day, exactly the second bug
// the report brief calls out (a record at 22:00 UTC is already the next
// calendar day, 01:00, in this org's local time).
function sqlLocalDay(column) {
  return `strftime('%Y-%m-%d', ${column}, '${SQLITE_LOCAL_MODIFIER}')`;
}
function sqlLocalHour(column) {
  return `CAST(strftime('%H', ${column}, '${SQLITE_LOCAL_MODIFIER}') AS INTEGER)`;
}
function sqlLocalMonth(column) {
  return `strftime('%Y-%m', ${column}, '${SQLITE_LOCAL_MODIFIER}')`;
}

// Formats a stored UTC ISO timestamp as the org's local time for display --
// the exact same +3-hour shift used for filtering/bucketing above, so a
// generated report's displayed timestamps can never disagree with what it
// was filtered/grouped by. Deliberately does NOT use the server process's
// own OS timezone (Date#toLocaleString) -- this app can run on a host set
// to any timezone, while the organization's real timezone is fixed
// regardless of that.
function formatLocal(isoString) {
  if (!isoString) return '';
  const shifted = new Date(new Date(isoString).getTime() + ORG_UTC_OFFSET_MINUTES * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

module.exports = {
  ORG_UTC_OFFSET_MINUTES,
  localDateStartToUtcIso,
  localDateEndToUtcIso,
  sqlLocalDay,
  sqlLocalHour,
  sqlLocalMonth,
  formatLocal,
};
