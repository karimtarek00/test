// Background auto-refresh for the Dashboard's "AI Insight" card.
//
// Before this, `last_insight_text` only ever changed when an admin
// manually clicked "Refresh" (see routes/ai.js's original
// POST /insights/refresh) -- meaning the card could show the exact same
// wording indefinitely no matter how much the fleet's real state changed
// underneath it. That's a genuinely stale, snapshot-like cache, distinct
// from the chat endpoint (which already re-builds its digest from the live
// database on every single message -- verified separately). This module
// keeps the *card* current too, on the same "scheduled background tick"
// pattern scomSync.js already uses for auto-fetch/full-sync.
const { pool } = require('./db');
const { chatComplete } = require('./aiClient');
const { buildDigest, SYSTEM_PROMPT } = require('./aiDigest');
const logger = require('./logger');

const log = logger.forModule('ai-insight');

// Fixed rather than user-configurable -- keeps this fix fast and scoped.
// 10 minutes matches how often the fleet's alert picture meaningfully
// changes in practice, without calling out to the (possibly metered) AI
// gateway on every page load.
const REFRESH_INTERVAL_MINUTES = 10;

async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM ai_settings WHERE id = 1');
  return rows[0] || null;
}

// Shared by both the manual "Refresh" button (routes/ai.js) and the
// background timer below, so there is exactly one code path that ever
// writes last_insight_text/at/error.
async function generateInsight() {
  const settings = await getSettings();
  if (!settings?.enabled) throw new Error('AI integration is not enabled.');
  const digest = await buildDigest();
  const at = new Date().toISOString();
  try {
    const reply = await chatComplete(settings, [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `DATA SNAPSHOT:\n${digest}\n\nWrite a short (3-5 sentence) operational insight for a dashboard card: call out anything that needs attention first, otherwise say things look healthy.`,
      },
    ]);
    await pool.query(`UPDATE ai_settings SET last_insight_text=$1, last_insight_at=$2, last_insight_error=NULL WHERE id=1`, [reply, at]);
    return { text: reply, at };
  } catch (err) {
    await pool.query(`UPDATE ai_settings SET last_insight_error=$1 WHERE id=1`, [err.message]);
    throw err;
  }
}

let refreshTimer = null;

function isScheduled() {
  return !!refreshTimer;
}

function scheduleInsightRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  refreshTimer = setInterval(() => {
    generateInsight().catch((err) => log.error({ err }, 'scheduled ai insight refresh failed'));
  }, REFRESH_INTERVAL_MINUTES * 60000);
}

function stopInsightRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// Called once at startup (see index.js, alongside scomSync's equivalent
// resume calls) and again whenever AI settings are saved with enabled=1 --
// so turning AI on always arms the refresh loop immediately, and turning
// it off stops calling out to the gateway.
async function resumeInsightAutoRefreshIfEnabled() {
  const settings = await getSettings();
  if (!settings?.enabled) { stopInsightRefresh(); return; }
  scheduleInsightRefresh();
  log.info({ minutes: REFRESH_INTERVAL_MINUTES }, 'ai insight auto-refresh armed');
  // Kick off one immediate refresh so a just-enabled/just-restarted app
  // doesn't sit on possibly-stale text for a full interval before the
  // first automatic tick.
  generateInsight().catch((err) => log.error({ err }, 'initial ai insight refresh failed'));
}

module.exports = { generateInsight, resumeInsightAutoRefreshIfEnabled, stopInsightRefresh, isScheduled, REFRESH_INTERVAL_MINUTES };
