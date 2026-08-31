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

function agentFor(settings) {
  return settings.allow_insecure_tls ? new https.Agent({ rejectUnauthorized: false }) : undefined;
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

async function chatComplete(settings, messages, { maxTokens = 800, temperature = 0.3 } = {}) {
  if (!settings?.base_url) throw new Error('AI base URL is not set.');
  if (!settings?.api_key) throw new Error('AI API key is not set.');

  const url = new URL(settings.base_url);
  const authHeader = settings.auth_header || 'Authorization';
  const authScheme = settings.auth_scheme != null ? settings.auth_scheme : 'Bearer';
  const headerValue = authScheme ? `${authScheme} ${settings.api_key}` : settings.api_key;

  const body = JSON.stringify({
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(settings.model ? { model: settings.model } : {}),
  });

  const json = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      [authHeader]: headerValue,
    },
    body,
  }, agentFor(settings));

  return extractReply(json);
}

module.exports = { chatComplete };
