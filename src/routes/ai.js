const express = require('express');
const { pool } = require('../lib/db');
const { chatComplete } = require('../lib/aiClient');
const { buildDigest, SYSTEM_PROMPT } = require('../lib/aiDigest');
const { AppError, asyncHandler } = require('../lib/errors');
const { requireAdmin } = require('../lib/auth');
const logger = require('../lib/logger');

const log = logger.forModule('ai-route');
const router = express.Router();

function sanitize(settings) {
  if (!settings) return null;
  const { api_key, ...rest } = settings;
  return { ...rest, hasApiKey: !!api_key };
}

async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM ai_settings WHERE id = 1');
  return rows[0] || null;
}

router.get('/settings', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ settings: sanitize(await getSettings()) });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const { baseUrl, apiKey, authHeader, authScheme, model, allowInsecureTls, enabled } = req.body;
  const current = await getSettings();
  await pool.query(
    `UPDATE ai_settings SET base_url=$1, api_key=$2, auth_header=$3, auth_scheme=$4, model=$5,
       allow_insecure_tls=$6, enabled=$7, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`,
    [
      baseUrl?.trim() || null,
      // Keep the existing key if the client didn't send a new one -- the
      // GET route never returns it, so an unrelated settings edit
      // shouldn't wipe out a previously saved credential.
      apiKey === undefined || apiKey === '' ? current?.api_key : apiKey,
      authHeader?.trim() || 'Authorization',
      authScheme !== undefined ? authScheme : 'Bearer',
      model?.trim() || null,
      allowInsecureTls ? 1 : 0,
      enabled ? 1 : 0,
    ]
  );
  log.info({ userId: req.user?.id }, 'ai settings updated');
  res.json({ settings: sanitize(await getSettings()) });
}));

// Validates credentials using currently-entered (not-yet-saved) settings --
// sends a trivial prompt, no digest/context involved. Deliberately always
// responds 200: {ok:false, error} is a normal outcome of a connectivity/
// credential test, not a server error.
router.post('/test', requireAdmin, asyncHandler(async (req, res) => {
  const current = await getSettings();
  const { baseUrl, apiKey, authHeader, authScheme, model, allowInsecureTls } = req.body || {};
  const candidate = {
    base_url: baseUrl || current?.base_url,
    api_key: apiKey === undefined || apiKey === '' ? current?.api_key : apiKey,
    auth_header: authHeader || current?.auth_header,
    auth_scheme: authScheme !== undefined ? authScheme : current?.auth_scheme,
    model: model || current?.model,
    allow_insecure_tls: allowInsecureTls !== undefined ? !!allowInsecureTls : !!current?.allow_insecure_tls,
  };
  const at = new Date().toISOString();
  try {
    const reply = await chatComplete(candidate, [{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 10, temperature: 0 });
    await pool.query(`UPDATE ai_settings SET last_test_at=$1, last_test_status='ok', last_test_error=NULL WHERE id=1`, [at]);
    res.json({ ok: true, reply });
  } catch (err) {
    log.warn({ err }, 'ai connection test failed');
    await pool.query(`UPDATE ai_settings SET last_test_at=$1, last_test_status='error', last_test_error=$2 WHERE id=1`, [at, err.message]);
    res.json({ ok: false, error: err.message });
  }
}));

// Read-only for any authenticated user -- this only ever displays the
// cached insight, it never lets a client trigger generation.
router.get('/insights', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json({
    text: settings?.last_insight_text || null,
    at: settings?.last_insight_at || null,
    error: settings?.last_insight_error || null,
    enabled: !!settings?.enabled,
  });
}));

router.post('/insights/refresh', requireAdmin, asyncHandler(async (req, res) => {
  const settings = await getSettings();
  if (!settings?.enabled) throw AppError.badRequest('AI integration is not enabled.');
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
    log.info({ userId: req.user?.id }, 'ai insight refreshed');
    res.json({ text: reply, at });
  } catch (err) {
    log.error({ err }, 'ai insight generation failed');
    await pool.query(`UPDATE ai_settings SET last_insight_error=$1 WHERE id=1`, [err.message]);
    throw err;
  }
}));

router.post('/chat', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  if (!settings?.enabled) throw AppError.badRequest('AI integration is not enabled.');
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) throw AppError.badRequest('messages is required.');

  const digest = await buildDigest();
  const reply = await chatComplete(settings, [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATA SNAPSHOT:\n${digest}` },
    ...messages,
  ]);
  res.json({ reply });
}));

module.exports = router;
