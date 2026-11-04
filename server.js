/**
 * pronounciation-server — caching TTS server for <a-term>
 *
 * Synthesises a term's pronunciation with an upstream TTS provider on the
 * first request, writes the MP3 to disk, and serves it from cache afterwards.
 * a-term's proxy adapter calls it; the cache can also be published as static
 * files for a-term's audio adapter.
 *
 * ── Request ───────────────────────────────────────────────────────────────
 *
 *   POST /synthesize   { term, ipa, lang }
 *
 * The server builds its own SSML from (term, ipa, lang), so a cached file can
 * only ever contain that one term, spoken with that IPA.
 *
 * Validation: lang must look like a BCP-47 tag; term and ipa must be
 * non-empty, at most 100 characters, with no control characters and no
 * "/" or "\\" (they become a file name).
 *
 * ── Caching strategy ─────────────────────────────────────────────────────
 *
 * Cache path: "${lang}/${term.toLowerCase()}-${ipa}.mp3", unencoded UTF-8
 * (NFC). This is the layout a-term's audio adapter reads by default
 * (audio/{lang}/{term}-{ipa}.mp3), so the cache directory can be published
 * as-is and used with that adapter.
 * Example:  ga/niamh-niːv.mp3   (lang is whatever the element resolved,
 *                                e.g. "ga" from <a-term lang="ga">)
 *
 * The term is lower-cased, as the adapter does, so "Tomato" and "tomato"
 * share a file. The IPA is kept exactly. To recover the parts, split the
 * file name at its last "-" (terms may contain "-"; IPA normally does not).
 *
 * Only successful syntheses are cached. Writes go to a temp file and are
 * renamed into place, and concurrent requests for the same new entry share
 * one upstream call, so a partially written file is never served.
 *
 * To force re-synthesis, delete the file and restart (the index of cached
 * files is built at startup).
 *
 * ── Routes ────────────────────────────────────────────────────────────────
 *
 *   POST /synthesize     → audio/mpeg, with headers
 *                          X-Term-Path   cache path, URL-encoded (ga%2Fniamh-ni%CB%90v.mp3)
 *                          X-Term-Cache  hit | miss
 *   GET  /cache/<file>   → cached MP3s, served statically
 *   GET  /index          → browsable HTML index of the cache
 *   GET  /new            → form for creating a new pronunciation
 *   GET  /health         → { ok, provider }
 *
 * ── CDN workflow ──────────────────────────────────────────────────────────
 *
 *   aws s3 sync ./cache s3://your-bucket/audio/ --exclude index.html --content-type audio/mpeg
 *   node build-index.js ./cache ./cache/index.html   # static index, relative links
 *
 * Then point a-term's audio adapter at it instead of the proxy:
 *
 *   <meta name="a-term-audio-url" content="https://cdn.example.com/audio/{lang}/{term}-{ipa}.mp3">
 *
 * or use audio-src on a single <a-term> (URL-encode the IPA):
 *
 *   <a-term lang="ga" ipa="niːv" audio-src="https://cdn.example.com/audio/ga/niamh-ni%CB%90v.mp3">Niamh</a-term>
 *
 * ── Security ──────────────────────────────────────────────────────────────
 *
 * This server spends your TTS quota, so by default it only listens on
 * 127.0.0.1 and only accepts browser requests from the origins listed in
 * CORS_ORIGIN. Requests carrying any other Origin header are rejected
 * outright (403), not just denied a CORS header.
 *
 * The exception is GET /cache/…: cached MP3s are public and served with
 * Access-Control-Allow-Origin: *, so any page can play them.
 *
 * ── Environment variables ─────────────────────────────────────────────────
 *
 *   PROVIDER          azure | google | polly | test  (default: azure)
 *                     "test" returns fake audio bytes and needs no keys.
 *   HOST              interface to listen on (default: 127.0.0.1)
 *   PORT              HTTP port (default: 3000)
 *   CACHE_DIR         path to cache directory (default: ./cache)
 *   CORS_ORIGIN       comma-separated origins allowed to call /synthesize,
 *                     /index and /health, or * for any (/cache is always open;
 *                     the server's own pages are always allowed)
 *                     (default: http://localhost:8000,http://127.0.0.1:8000)
 *
 *   Azure:   AZURE_SUBSCRIPTION_KEY, AZURE_REGION, AZURE_VOICE (optional)
 *   Google:  GOOGLE_API_KEY, GOOGLE_SPEAKING_RATE (default: 0.85)
 *   Polly:   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, POLLY_VOICE (optional)
 *
 *   Run with:  npm start   (node --env-file=.env server.js)
 */

import express from 'express';
import { createReadStream, mkdirSync } from 'fs';
import { writeFile, rename, unlink, mkdir } from 'fs/promises';
import { resolve, dirname, sep } from 'path';
import { randomBytes, createHmac, createHash } from 'crypto';
import { buildIndexHtml, listCache } from './index-page.js';

// ── Config ─────────────────────────────────────────────────────────────────

const HOST      = process.env.HOST        ?? '127.0.0.1';
const PORT      = process.env.PORT        ?? 3000;
const PROVIDER  = process.env.PROVIDER    ?? 'azure';
const CACHE_DIR = resolve(process.env.CACHE_DIR ?? './cache');
const ORIGINS   = (process.env.CORS_ORIGIN ?? 'http://localhost:8000,http://127.0.0.1:8000')
  .split(',').map(s => s.trim()).filter(Boolean);
const ANY_ORIGIN = ORIGINS.includes('*');

mkdirSync(CACHE_DIR, { recursive: true });

// Cached files, as "lang/file.mp3" relative paths.
const cacheIndex = new Set(listCache(CACHE_DIR).map(e => e.path));
const inFlight = new Map(); // relative path → Promise<relative path>

// ── Middleware ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '8kb' }));

// ── Serve cached MP3s directly ─────────────────────────────────────────────
//
// Cached files are public: any site may fetch them (a-term's audio adapter
// uses fetch(), so it needs CORS). This is mounted before the origin check
// below, which therefore only guards the other routes.

app.use('/cache', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    return res.sendStatus(204);
  }
  next();
}, express.static(CACHE_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}), (req, res) => res.sendStatus(404));

// ── Origin check for everything else ───────────────────────────────────────

app.use((req, res, next) => {
  const origin = req.get('Origin');
  // The server's own pages (e.g. GET /new) are always allowed.
  const self = `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== self && !ANY_ORIGIN && !ORIGINS.includes(origin)) {
    return res.status(403).json({ error: `Origin not allowed: ${origin}` });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', ANY_ORIGIN ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Term-Path, X-Term-Cache');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── POST /synthesize ───────────────────────────────────────────────────────

const LANG_RE  = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const CTRL_RE  = /[\u0000-\u001f\u007f]/;
const SLASH_RE = /[\/\\]/;
const MAX_TEXT = 100;

app.post('/synthesize', async (req, res) => {
  const parsed = parseRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { term, ipa, lang } = parsed;

  // Same layout as a-term's audio adapter: {lang}/{term}-{ipa}.mp3, term lower-cased.
  const file = `${term.toLowerCase()}-${ipa}.mp3`;
  if (Buffer.byteLength(file) > 255) {
    return res.status(400).json({ error: 'term + ipa too long for a cache filename' });
  }
  const name = `${lang}/${file}`;

  try {
    const hit      = cacheIndex.has(name);
    const filename = await cached(name, () => synthesise({ ssml: buildSsml({ term, ipa, lang }), lang }));
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Term-Path', encodeURIComponent(filename));    // e.g. ga%2Fniamh-ni%CB%90v.mp3
    res.setHeader('X-Term-Cache', hit ? 'hit' : 'miss');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const stream = createReadStream(safePath(filename));
    stream.on('error', err => {
      // File vanished (e.g. deleted by hand): forget it so the next request re-synthesises.
      cacheIndex.delete(filename);
      console.error('[pronunciation-server] read error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Cached file unavailable; retry' });
      else res.destroy(err);
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[pronunciation-server] error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

function parseRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'Expected a JSON body' };
  let { term, ipa, lang } = body;

  if (typeof lang !== 'string' || !LANG_RE.test(lang)) return { error: 'lang must be a BCP-47 language tag' };
  for (const [k, v] of Object.entries({ term, ipa })) {
    if (typeof v !== 'string') return { error: `Body must include ${k}` };
  }
  term = term.normalize('NFC').trim();
  ipa  = ipa.normalize('NFC').trim();
  for (const [k, v] of Object.entries({ term, ipa })) {
    if (!v)                 return { error: `${k} must not be empty` };
    if (v.length > MAX_TEXT) return { error: `${k} must be at most ${MAX_TEXT} characters` };
    if (CTRL_RE.test(v))    return { error: `${k} contains control characters` };
    if (SLASH_RE.test(v))   return { error: `${k} must not contain "/" or "\\"` };
  }
  return { term, ipa, lang };
}

function buildSsml({ term, ipa, lang }) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(lang)}">` +
         `<p><phoneme alphabet="ipa" ph="${xml(ipa)}">${xml(term)}</phoneme></p></speak>`;
}

// Resolve a cache filename to an absolute path, refusing anything that would
// land outside CACHE_DIR.
function safePath(filename) {
  const p = resolve(CACHE_DIR, filename);
  if (!p.startsWith(CACHE_DIR + sep)) throw new Error('Invalid cache path');
  return p;
}

// Return the relative path for `name`, synthesising it once if needed.
async function cached(name, produce) {
  if (cacheIndex.has(name)) {
    console.log(`[pronunciation-server] cache hit     ${name}`);
    return name;
  }
  if (inFlight.has(name)) return inFlight.get(name);

  const job = (async () => {
    console.log(`[pronunciation-server] synthesising  ${name}`);
    const finalPath = safePath(name);
    const tmpPath   = `${finalPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      await writeFile(tmpPath, Buffer.from(await produce()));
      await rename(tmpPath, finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    cacheIndex.add(name);
    return name;
  })();

  inFlight.set(name, job);
  try { return await job; } finally { inFlight.delete(name); }
}

// ── GET /index ─────────────────────────────────────────────────────────────

app.get('/index', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildIndexHtml(CACHE_DIR, { hrefBase: '/cache/', showPath: true, newHref: '/new' }));
});

// ── GET /new ───────────────────────────────────────────────────────────────
//
// A form for creating a new pronunciation; it POSTs to /synthesize.

app.get('/new', (req, res) => {
  res.sendFile(resolve(import.meta.dirname, 'new.html'));
});

// ── GET /health ────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, provider: PROVIDER }));

app.listen(PORT, HOST, () => {
  console.log(`[pronunciation-server] listening on http://${HOST}:${PORT} (provider: ${PROVIDER})`);
  console.log(`[pronunciation-server] cache: ${CACHE_DIR}`);
  console.log(`[pronunciation-server] allowed origins: ${ORIGINS.join(', ')}`);
  console.log(`[pronunciation-server] index: http://${HOST}:${PORT}/index`);
});

function xml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

// ── Upstream providers ─────────────────────────────────────────────────────

async function synthesise({ ssml, lang }) {
  switch (PROVIDER) {
    case 'google': return synthesiseGoogle({ ssml, lang });
    case 'azure':  return synthesiseAzure({ ssml, lang });
    case 'polly':  return synthesisePolly({ ssml, lang });
    case 'test':   return Buffer.from(`TEST-AUDIO ${ssml}`); // no network; for local testing
    default: throw new Error(`Unknown provider: ${PROVIDER}`);
  }
}

// ── Google Cloud TTS ───────────────────────────────────────────────────────
//
// Google has quality issues with IPA phoneme + inner term text in some
// languages (produces silence or mispronunciation). We strip the term from
// inside <phoneme> before sending — the ph attribute alone drives output.

const GOOGLE_UNSUPPORTED = new Set(['ga-IE','cy-GB','eu-ES','gl-ES','mt-MT','is-IS']);

function stripPhonemeText(ssml) {
  return ssml.replace(/(<phoneme\b[^>]*>)[^<]*(<\/phoneme>)/, '$1$2');
}

async function synthesiseGoogle({ ssml, lang }) {
  const key       = requireEnv('GOOGLE_API_KEY');
  const langCode  = normaliseLang(lang);
  const voiceLang = GOOGLE_UNSUPPORTED.has(langCode) ? 'en-GB' : langCode;

  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { ssml: stripPhonemeText(ssml) },
        voice: { languageCode: voiceLang, ssmlGender: 'NEUTRAL' },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: parseFloat(process.env.GOOGLE_SPEAKING_RATE ?? '0.85'),
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Google TTS ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  const { audioContent } = await res.json();
  return Buffer.from(audioContent, 'base64');
}

// ── Azure Cognitive Services ───────────────────────────────────────────────

async function synthesiseAzure({ ssml, lang }) {
  const key       = requireEnv('AZURE_SUBSCRIPTION_KEY');
  const region    = requireEnv('AZURE_REGION');
  const langCode  = normaliseLang(lang);
  const voiceName = process.env.AZURE_VOICE || azureDefaultVoice(langCode);

  const wrappedSsml = ssml.replace(
    /(<speak[^>]*>)([\s\S]*)(<\/speak>)/,
    `$1<voice name="${xml(voiceName)}">$2</voice>$3`
  );

  const res = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'Ocp-Apim-Subscription-Key': key,
        'User-Agent': 'pronunciation-server',
      },
      body: wrappedSsml,
    }
  );

  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function azureDefaultVoice(langCode) {
  const map = {
    'en-US': 'en-US-JennyNeural', 'en-GB': 'en-GB-SoniaNeural',
    'ga-IE': 'ga-IE-OrlaNeural',  'fr-FR': 'fr-FR-DeniseNeural',
    'de-DE': 'de-DE-KatjaNeural', 'es-ES': 'es-ES-ElviraNeural',
    'it-IT': 'it-IT-ElsaNeural',  'pt-BR': 'pt-BR-FranciscaNeural',
    'ja-JP': 'ja-JP-NanamiNeural','zh-CN': 'zh-CN-XiaoxiaoNeural',
    'ko-KR': 'ko-KR-SunHiNeural',
    'he-IL': 'he-IL-HilaNeural',
  };
  return map[langCode] ?? `${langCode}-${langCode.split('-')[0]}Neural`;
}

// ── Amazon Polly ───────────────────────────────────────────────────────────

async function synthesisePolly({ ssml, lang }) {
  const accessKeyId     = requireEnv('AWS_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('AWS_SECRET_ACCESS_KEY');
  const region          = requireEnv('AWS_REGION');
  const voiceId         = process.env.POLLY_VOICE || pollyDefaultVoice(lang);

  const body = JSON.stringify({
    Engine: 'neural', OutputFormat: 'mp3', SampleRate: '24000',
    Text: ssml, TextType: 'ssml', VoiceId: voiceId,
  });

  const url    = `https://polly.${region}.amazonaws.com/v1/speech`;
  const signed = await awsSign({
    method: 'POST', url, region, service: 'polly', body,
    credentials: { accessKeyId, secretAccessKey },
  });

  const res = await fetch(url, { method: 'POST', headers: signed.headers, body });
  if (!res.ok) throw new Error(`Polly ${res.status}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function pollyDefaultVoice(lang) {
  const map = {
    en: 'Joanna', fr: 'Celine', de: 'Marlene', es: 'Conchita',
    it: 'Carla',  pt: 'Ines',   ja: 'Mizuki',  zh: 'Zhiyu',
    ko: 'Seoyeon', ru: 'Tatyana', pl: 'Ewa', ga: 'Joanna',
  };
  return map[lang?.split('-')[0]] ?? 'Joanna';
}

// ── AWS Signature V4 ───────────────────────────────────────────────────────

async function awsSign({ method, url, region, service, body, credentials }) {
  const { accessKeyId, secretAccessKey } = credentials;
  const uri  = new URL(url);
  const now  = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const hash = createHash('sha256').update(body).digest('hex');

  const headers = {
    'content-type': 'application/json',
    'host': uri.host,
    'x-amz-date': time,
    'x-amz-content-sha256': hash,
  };

  const sortedNames   = Object.keys(headers).sort().join(';');
  const canonicalHdrs = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}\n`).join('');

  const canonicalReq = [method, uri.pathname, '', canonicalHdrs, sortedNames, hash].join('\n');
  const scope  = `${date}/${region}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${time}\n${scope}\n` +
    createHash('sha256').update(canonicalReq).digest('hex');

  const sigKey = ['aws4_request', service, region, date].reduce(
    (key, data) => createHmac('sha256', key).update(data).digest(),
    `AWS4${secretAccessKey}`
  );
  const sig = createHmac('sha256', sigKey).update(toSign).digest('hex');

  headers['Authorization'] = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}`,
    `SignedHeaders=${sortedNames}`,
    `Signature=${sig}`,
  ].join(', ');

  return { headers };
}

// ── Shared utils ────────────────────────────────────────────────────────────

function normaliseLang(lang) {
  if (!lang || lang === 'und') return 'en-US';
  if (lang.includes('-')) return lang;
  const map = {
    en: 'en-US', ga: 'ga-IE', fr: 'fr-FR', de: 'de-DE', es: 'es-ES',
    it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ja: 'ja-JP', zh: 'zh-CN',
    ko: 'ko-KR', ar: 'ar-XA', ru: 'ru-RU', pl: 'pl-PL', sv: 'sv-SE',
    da: 'da-DK', fi: 'fi-FI', nb: 'nb-NO', cs: 'cs-CZ', hu: 'hu-HU',
    he: 'he-IL',
  };
  return map[lang] ?? `${lang}-${lang.toUpperCase()}`;
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}
