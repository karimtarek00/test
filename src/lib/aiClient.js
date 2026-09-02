// Generic HTTP client for an internal, OpenAI chat-completions-shaped AI
// gateway. Deliberately tolerant of minor differences between gateways
// (auth header/scheme, response shape) so this works against whatever
// internal endpoint the org actually has, without per-vendor code.
//
// Modeled on this app's own scomSync.js/nnmiSync-style raw http(s).request
// pattern (rather than a fetch()-based client) specifically so
// allow_insecure_tls can be honored via a real https.Agent -- Node's
// built-in fetch doesn't expose a clean per-request TLS-trust override.
const http = require('http');
const https = require('https');

const REQUEST_TIMEOUT_MS = 30000;

// An https.Agent must never be handed to a plain http:// request -- Node
// throws "Protocol \"http:\" not supported. Expected \"https:\"" the
// instant it sees the mismatch, regardless of which module actually makes
// the request. allow_insecure_tls only means anything for an https:// URL
// in the first place, so this is also just correct behavior, not a
// workaround.
function agentFor(url, settings) {
  return url.protocol === 'https:' && settings.allow_insecure_tls
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;
}

function requestJson(url, options, agent) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, { ...options, agent, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch {
          return reject(new Error(`AI gateway returned non-JSON (HTTP ${res.statusCode}): ${data.slice(0, 300)}`));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(`AI gateway returned HTTP ${res.statusCode}: ${JSON.stringify(json).slice(0, 300)}`));
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`AI gateway did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`));
    });
    req.on('error', (e) => reject(new Error(`Could not reach AI gateway: ${e.message}`)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Tries the OpenAI chat-completions shape first, then a handful of common
// fallback shapes other internal gateways use, before giving up with the
// raw response body attached to the error.
function extractReply(json) {
  const reply = json?.choices?.[0]?.message?.content
    ?? json?.output
    ?? json?.output_text
    ?? json?.text
    ?? json?.response
    ?? json?.result;
  if (reply === undefined || reply === null) {
    throw new Error(`Could not find a reply in the AI gateway's response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return reply;
}

// Shared request builder for both chatComplete (plain text) and
// chatCompleteWithTools (needs the raw message, since a tool-calling
// response has tool_calls instead of/alongside content) -- one place that
// builds the request body/headers so the two never drift apart on auth or
// request-shaping behavior.
async function requestChatCompletion(settings, messages, { maxTokens = 800, temperature = 0.3, tools } = {}) {
  if (!settings?.base_url) throw new Error('AI base URL is not set.');
  // api_key is deliberately NOT required -- an internal/self-hosted gateway
  // (confirmed by a real working reference script, which explicitly leaves
  // its bearer token blank) is just as likely to need no authentication at
  // all as it is to need a key. Only send the auth header when a key is
  // actually configured.

  const url = new URL(settings.base_url);
  const authHeader = settings.auth_header || 'Authorization';
  const authScheme = settings.auth_scheme != null ? settings.auth_scheme : 'Bearer';
  const headerValue = settings.api_key
    ? (authScheme ? `${authScheme} ${settings.api_key}` : settings.api_key)
    : null;

  const body = JSON.stringify({
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(settings.model ? { model: settings.model } : {}),
    ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
  });

  return requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(headerValue ? { [authHeader]: headerValue } : {}),
    },
    body,
  }, agentFor(url, settings));
}

async function chatComplete(settings, messages, opts) {
  const json = await requestChatCompletion(settings, messages, opts);
  return extractReply(json);
}

// Returns the raw assistant message ({role, content, tool_calls}) instead
// of just extracted text -- the chat route's tool-calling loop needs to see
// tool_calls to know whether the model wants to call a tool before it has
// a final text answer. Only meaningful for a genuinely OpenAI-message-
// shaped gateway (json.choices[0].message); anything else falls back to a
// plain content-only message via extractReply, so a gateway that doesn't
// support tool calling at all still gets a normal answer, just without
// ever populating tool_calls.
async function chatCompleteWithTools(settings, messages, tools, opts) {
  const json = await requestChatCompletion(settings, messages, { ...opts, tools });
  const message = json?.choices?.[0]?.message;
  if (!message) return { role: 'assistant', content: extractReply(json), tool_calls: null };
  return message;
}

module.exports = { chatComplete, chatCompleteWithTools };
