// Lesson learned #1: every place that matches an incoming alert's server name
// against an existing server row must compare a normalized key, not the raw
// string, or a case/whitespace/FQDN-vs-short-hostname difference silently
// creates a duplicate row. Use this helper everywhere identity is compared -
// sync, import, manual edits.
export function normalizeServerName(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase();
}

// SCOM alert "Source" text is frequently not a hostname at all (a disk, a
// cluster resource, an app pool - see the sample data). Only extract when the
// value plausibly looks like a hostname/FQDN; otherwise leave it unmatched
// rather than guessing wrong.
const HOSTNAME_IN_PARENS = /\(([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)\)/;
const LOOKS_LIKE_HOSTNAME = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;

export function extractHostnameGuess(sourceText) {
  if (!sourceText) return null;
  const trimmed = String(sourceText).trim();

  const parenMatch = trimmed.match(HOSTNAME_IN_PARENS);
  if (parenMatch) return parenMatch[1];

  const beforeBackslash = trimmed.split('\\')[0].trim();
  if (beforeBackslash.includes('.') && LOOKS_LIKE_HOSTNAME.test(beforeBackslash)) {
    return beforeBackslash;
  }
  return null;
}

export function shortHostname(name) {
  if (!name) return '';
  return String(name).split('.')[0];
}
