// Shared server-identity key for "is this the same server we already have a
// row for" lookups (scomSync.js, importRoutes.js, manual edits). Only used
// to decide whether an existing servers.hostname/fqdn row matches an
// incoming one -- never used for what actually gets stored, so a server's
// displayed name always stays exactly what its source system sent.
//
// Without this, an exact-string match against a SCOM-reported name that
// only differs in case/whitespace/FQDN-vs-short-hostname from an
// admin-uploaded inventory sheet fails to find the already-tagged row and
// creates a second, untagged duplicate instead.
function normalizeServerName(name) {
  return String(name || '').trim().toLowerCase();
}

module.exports = { normalizeServerName };
