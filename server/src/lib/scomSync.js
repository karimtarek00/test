// SCOM sync engine - NOT YET WIRED UP.
//
// Once SQL read access to the `OperationsManager` database is available, this
// module becomes the `mssql`-backed client that:
//   - syncIncremental(): polls Alert/AlertView WHERE LastModified > lastSyncTime,
//     runs frequently, upserts into `alerts`.
//   - syncFull(): unbounded fetch of every currently-open alert
//     (WHERE ResolutionState < 255). This is the ONLY mode allowed to run
//     closure detection (lesson learned #4) - a paginated/capped fetch must
//     never be trusted to decide something is closed.
//
// Server identity must be resolved via the BaseManagedEntity join (the real
// owning computer object), not by parsing the alert's Source display text -
// the sample data showed Source is frequently not a hostname at all.
//
// Kept as an explicit two-mode interface now so the rest of the app (routes,
// dashboard, health score) never has to change shape once this is filled in.

export const SYNC_MODES = ['incremental', 'full'];

export async function syncIncremental() {
  return notConfigured();
}

export async function syncFull() {
  return notConfigured();
}

function notConfigured() {
  return {
    ok: false,
    reason: 'SCOM SQL connection not configured yet. Set it on the Configuration page once OperationsManager DB access is available.',
    upserted: 0,
    closed: 0,
  };
}
