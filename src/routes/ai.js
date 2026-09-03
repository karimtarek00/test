const express = require('express');
const { pool } = require('../lib/db');
const { chatComplete, chatCompleteWithTools } = require('../lib/aiClient');
const { buildDigest, SYSTEM_PROMPT } = require('../lib/aiDigest');
const aiInsight = require('../lib/aiInsight');
const aiTools = require('../lib/aiTools');
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
  // Re-arm (or disarm) the background insight refresh immediately -- a
  // freshly-enabled/reconfigured AI shouldn't wait for the next server
  // restart to start keeping the Dashboard card current.
  aiInsight.resumeInsightAutoRefreshIfEnabled().catch((err) => log.error({ err }, 'failed to re-arm ai insight auto-refresh'));
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

// Manual trigger (the "Refresh" button) -- shares generateInsight() with
// the background auto-refresh timer in lib/aiInsight.js, so there's exactly
// one place that ever writes last_insight_text.
router.post('/insights/refresh', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const { text, at } = await aiInsight.generateInsight();
    log.info({ userId: req.user?.id }, 'ai insight refreshed');
    res.json({ text, at });
  } catch (err) {
    log.error({ err }, 'ai insight generation failed');
    throw AppError.badRequest(err.message);
  }
}));

const MAX_TOOL_ROUNDS = 4;

// Chat with tool-calling: the digest above covers aggregates/top-N/most-
// recent, which can never include every one of potentially hundreds of
// servers or thousands of alerts -- a question about one SPECIFIC server
// or alarm not already in a top-5 list needs a real, on-demand database
// query, not a bigger static prompt. When the model requests a tool
// (get_server_status / search_alerts, see lib/aiTools.js), this executes
// it against the live database and feeds the result back for another
// round, up to MAX_TOOL_ROUNDS times.
//
// Falls back to a plain (no-tools) chat the moment a tool-calling request
// itself fails -- not every internal gateway understands the OpenAI
// `tools` field, and this must never turn a previously-working chat into
// a broken one just because tool-calling isn't supported there.
router.post('/chat', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  if (!settings?.enabled) throw AppError.badRequest('AI integration is not enabled.');
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) throw AppError.badRequest('messages is required.');

  const digest = await buildDigest();
  const conversation = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATA SNAPSHOT:\n${digest}` },
    ...messages,
  ];

  let toolsSupported = true;
  let finalReply = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS && finalReply === null; round++) {
    let message;
    if (toolsSupported) {
      try {
        message = await chatCompleteWithTools(settings, conversation, aiTools.TOOLS);
      } catch (err) {
        log.warn({ err }, 'AI gateway rejected a tool-calling request -- falling back to plain chat for this conversation');
        toolsSupported = false;
      }
    }
    if (!toolsSupported) {
      finalReply = await chatComplete(settings, conversation);
      break;
    }
    // Not every gateway/model actually implements the OpenAI tool_calls
    // response field -- some instead emit the request as plain text using
    // the Hermes/NousResearch <tool_call>{...}</tool_call> convention
    // (confirmed live: a user saw this raw markup in the chat widget
    // instead of it being executed). Recognize both shapes identically.
    const toolCalls = message.tool_calls && message.tool_calls.length
      ? message.tool_calls
      : aiTools.extractTextToolCalls(message.content);
    if (!toolCalls.length) {
      finalReply = message.content;
      break;
    }
    conversation.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls || undefined });
    for (const call of toolCalls) {
      const result = await aiTools.executeTool(call.function.name, call.function.arguments);
      // Wrapped in <tool_response> as well as sent under the 'tool' role --
      // covers both a real OpenAI-style consumer and a text-convention
      // model that only reads the literal tag out of message content.
      conversation.push({ role: 'tool', tool_call_id: call.id, content: `<tool_response>${JSON.stringify(result)}</tool_response>` });
    }
  }

  if (finalReply === null) {
    // Exhausted MAX_TOOL_ROUNDS without a plain-text answer (kept calling
    // tools) -- ask once more with no tools available so the model is
    // forced to answer from whatever it already gathered instead of
    // looping forever.
    finalReply = await chatComplete(settings, conversation);
  }

  // Defensive strip regardless of which path produced finalReply -- raw
  // <tool_call>/<tool_response> markup must never reach the chat UI, even
  // if a model rambles with one alongside real prose or the round budget
  // ran out mid-conversation.
  res.json({ reply: aiTools.stripToolCallMarkup(finalReply) });
}));

module.exports = router;
