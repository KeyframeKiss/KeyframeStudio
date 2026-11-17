// Translation engines for Studio EX, run in the Electron main process (no browser CORS limits).
// The renderer does the chunking/progress; each call here translates one small batch and returns
// an array aligned with the input (null where an item failed).
//
//   google — Google Translate's free web endpoint (no key). Batched as newline-joined text.
//   deepl  — DeepL API (free tier: 500k chars/month with a free key; keys ending ':fx' use api-free).
//   llm    — any OpenAI-compatible chat endpoint: Ollama, LM Studio, KoboldCpp, OpenRouter, ...
//            Best quality for short names because it understands what kind of thing is being named.

const { net } = require('electron');

// Use Chromium's network stack (net.fetch), not Node's fetch: Google answers Electron's bundled
// Node TLS fingerprint with a 429 "unusual traffic" page, while Chromium looks like a normal browser.
// It also honours the system proxy. Bodies must be strings for net.fetch.
const http = (url, init = {}) =>
  net.fetch(url, { ...init, body: init.body instanceof URLSearchParams ? init.body.toString() : init.body });

const CONTEXT =
  'Names and labels from Koikatsu CharaStudio, a Japanese 3D anime character posing and animation tool: ' +
  'poses, animations, items, accessories, clothing, shaders, lighting, scene objects and mod settings.';

const LLM_SYSTEM = `You translate Japanese UI strings from Koikatsu / CharaStudio (a 3D anime character posing and animation tool) into natural, concise English.
The strings are names of poses, animations, items, accessories, clothing, shaders, lights, scene objects and plugin settings.
Rules:
- Translate the meaning, short like a menu label. Use Title Case for names.
- Keep numbers, symbols, brackets and any Latin text exactly as they are.
- Prefer meaning over romanization. Examples: えびぞり → Arched Back; 女豹 → Panther Pose; フリフリ → Wiggle; ほおづえ → Chin on Hand; 体育座り → Hugging Knees; 横寝 → Lying on Side.
- Romanize only true proper names that have no meaning.
- Each item has a "kind" hint saying where the text appears; use it.
Reply with ONLY a JSON object mapping every id to its English translation, e.g. {"0":"...","1":"..."}. No explanations.`;

async function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)));
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function httpError(r, what) {
  let body = '';
  try {
    body = (await r.text()).slice(0, 200);
  } catch {}
  if (r.status === 403 && what === 'DeepL') return new Error('DeepL rejected the key (403). Check the key in Translations settings.');
  if (r.status === 456) return new Error('DeepL quota for this month is used up (456).');
  if (r.status === 429) return new Error(`${what} is rate limiting — wait a minute and try again (429).`);
  return new Error(`${what} HTTP ${r.status}${body ? ': ' + body : ''}`);
}

// ---------------------------------------------------------------- Google (free)
async function google(items) {
  const clean = items.map((i) => i.text.replace(/[\r\n]+/g, ' '));
  const r = await withTimeout(
    http('https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=en&dt=t', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: clean.join('\n') }),
    }),
    20000,
    'Google',
  );
  if (!r.ok) throw await httpError(r, 'Google');
  const j = await r.json();
  const lines = (j?.[0] ?? []).map((s) => s?.[0] ?? '').join('').split('\n');
  if (lines.length === clean.length) return lines.map((l) => l.trim() || null);
  // Alignment lost (Google merged/split a line): fall back to one request per item.
  if (items.length === 1) return [lines.join(' ').trim() || null];
  const out = [];
  for (const it of items) {
    await new Promise((r) => setTimeout(r, 250)); // one request per item now: pace them
    try {
      out.push((await google([it]))[0]);
    } catch {
      out.push(null); // left untranslated; auto mode retries it later
    }
  }
  return out;
}

// ---------------------------------------------------------------- DeepL
async function deepl(items, s) {
  const key = (s.deeplKey || '').trim();
  if (!key) throw new Error('Add your DeepL API key first (free at deepl.com/pro-api).');
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const r = await withTimeout(
    http(`${host}/v2/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify({ text: items.map((i) => i.text), source_lang: 'JA', target_lang: 'EN-US', context: CONTEXT }),
    }),
    30000,
    'DeepL',
  );
  if (!r.ok) throw await httpError(r, 'DeepL');
  const j = await r.json();
  return items.map((_, i) => j?.translations?.[i]?.text?.trim() || null);
}

// ---------------------------------------------------------------- OpenAI-compatible (local AI)
function llmBase(s) {
  let u = (s.llmUrl || 'http://127.0.0.1:11434/v1').trim().replace(/\/+$/, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

function llmHeaders(s) {
  const h = { 'content-type': 'application/json' };
  if ((s.llmKey || '').trim()) h.authorization = `Bearer ${s.llmKey.trim()}`;
  return h;
}

function parseJsonObject(text) {
  let t = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The model did not return JSON');
  return JSON.parse(t.slice(a, b + 1));
}

async function llm(items, s) {
  if (!(s.llmModel || '').trim()) throw new Error('Pick a model for the local AI engine first.');
  const payload = items.map((it, i) => ({ id: String(i), ja: it.text, kind: it.context || undefined }));
  const r = await withTimeout(
    http(`${llmBase(s)}/chat/completions`, {
      method: 'POST',
      headers: llmHeaders(s),
      body: JSON.stringify({
        model: s.llmModel.trim(),
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: LLM_SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    }),
    180000,
    'Local AI',
  ).catch((e) => {
    if (/fetch failed|ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/i.test(String(e?.message ?? e) + String(e?.cause?.code ?? '')))
      throw new Error(`Could not reach ${llmBase(s)} — is Ollama / LM Studio running?`);
    throw e;
  });
  if (!r.ok) throw await httpError(r, 'Local AI');
  const j = await r.json();
  const obj = parseJsonObject(j?.choices?.[0]?.message?.content);
  return items.map((_, i) => {
    const v = obj[String(i)] ?? obj[i];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  });
}

async function models(s) {
  const r = await withTimeout(http(`${llmBase(s)}/models`, { headers: llmHeaders(s) }), 8000, 'Local AI').catch((e) => {
    if (/fetch failed|ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/i.test(String(e?.message ?? e) + String(e?.cause?.code ?? '')))
      throw new Error(`Could not reach ${llmBase(s)} — is Ollama / LM Studio running?`);
    throw e;
  });
  if (!r.ok) throw await httpError(r, 'Local AI');
  const j = await r.json();
  return (j?.data ?? []).map((m) => m.id).filter(Boolean);
}

// Retry rate limits / network blips with backoff before giving up.
function retrying(fn) {
  return async (items, s) => {
    const waits = [3000, 10000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(items, s);
      } catch (e) {
        const msg = String(e?.message ?? e);
        const transient = /\(429\)|HTTP 5\d\d|timed out|fetch failed|ECONNRESET|net::ERR_(?!CONNECTION_REFUSED)/i.test(msg);
        if (!transient || attempt >= waits.length) throw e;
        await new Promise((r) => setTimeout(r, waits[attempt]));
      }
    }
  };
}

const ENGINES = { google: retrying(google), deepl: retrying(deepl), llm };

function register(ipcMain) {
  ipcMain.handle('translate:batch', async (_e, engine, items, settings) => {
    const fn = ENGINES[engine];
    if (!fn) throw new Error(`Unknown engine ${engine}`);
    if (!Array.isArray(items) || !items.length) return [];
    return fn(items.slice(0, 100), settings || {});
  });
  ipcMain.handle('translate:models', (_e, settings) => models(settings || {}));
}

module.exports = { register };
