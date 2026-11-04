# word-tip-audio

A caching text-to-speech server that makes pronunciation audio for [`<a-term>`](https://github.com/bkardell/a-term).

`<a-term>` marks up a term in a web page with its pronunciation (IPA), and can play it aloud. This server makes that audio. You give it a term, its IPA and a language, and it asks a TTS provider (Azure, Google or Amazon Polly) to speak exactly that pronunciation. The result is saved as an MP3.

Each pronunciation is synthesised once and cached as:

```
cache/<lang>/<term, lower-cased>-<ipa>.mp3      e.g. cache/ga/niamh-niːv.mp3
```

That is the layout `<a-term>`'s audio adapter reads by default. So the usual way to use this is:

1. Run the server locally and create the pronunciations you need.
2. Publish the `cache/` folder as static files (GitHub Pages, S3, any CDN).
3. Point `<a-term>` at those files. Your pages never call the server, and your API keys stay on your machine.

## Quick start

Needs Node 22.9 or later.

```sh
npm install
cp .env.example .env     # then fill in a provider's keys (see below)
npm start                # http://127.0.0.1:3000
```

To try it without any API keys, run `PROVIDER=test npm start`. The test provider returns placeholder bytes instead of real audio.

Then open:

- **http://127.0.0.1:3000/new**: a form for a new pronunciation. Enter the term, its IPA (there's a symbol palette) and a language. It plays the result, shows where it was saved, and gives you `<a-term>` snippets to copy into a page.
- **http://127.0.0.1:3000/index**: browse and play everything in the cache.

## Configuration

Settings are read from `.env` (see [`.env.example`](.env.example)). You only need keys for the provider you use.

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDER` | `azure` | `azure`, `google`, `polly` or `test` |
| `HOST` | `127.0.0.1` | Interface to listen on |
| `PORT` | `3000` | HTTP port |
| `CACHE_DIR` | `./cache` | Where MP3s are stored |
| `CORS_ORIGIN` | `http://localhost:8000,http://127.0.0.1:8000` | Comma-separated origins allowed to call `/synthesize`, `/index` and `/health`, or `*` for any |

Provider settings:

| Provider | Required | Optional | Where to get keys |
|---|---|---|---|
| Azure | `AZURE_SUBSCRIPTION_KEY`, `AZURE_REGION` | `AZURE_VOICE` | Create a Speech resource in the Azure portal; the key and region are on its "Keys and Endpoint" page |
| Google | `GOOGLE_API_KEY` | `GOOGLE_SPEAKING_RATE` (default `0.85`) | Enable the Cloud Text-to-Speech API in Google Cloud and create an API key |
| Polly | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | `POLLY_VOICE` | An IAM user with Polly access |

If no voice is set, a default voice is picked for the language. Google has no voices for Irish, Welsh, Basque, Galician, Maltese or Icelandic, so for those it uses an en-GB voice speaking the IPA.

## Using the audio in a page

Publish the cache (MP3s plus an optional static index):

```sh
npm run build-index      # writes cache/index.html with relative links
# then upload cache/ to your static host, for example:
aws s3 sync ./cache s3://your-bucket/audio/ --content-type audio/mpeg --exclude index.html
```

Tell `<a-term>`'s audio adapter where the files live:

```html
<meta name="a-term-audio-url" content="https://example.com/audio/{lang}/{term}-{ipa}.mp3">
```

Or set it on a single term (URL-encode the IPA):

```html
<a-term lang="ga" ipa="niːv" audio-src="https://example.com/audio/ga/niamh-ni%CB%90v.mp3">Niamh</a-term>
```

The `/new` page generates both forms for you. See the [a-term README](https://github.com/bkardell/a-term) for the element and its adapters.

## API

### `POST /synthesize`

```sh
curl -X POST http://127.0.0.1:3000/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"term":"Niamh","ipa":"niːv","lang":"ga"}' \
  -o niamh.mp3 -D -
```

Returns `audio/mpeg`, with these headers:

- `X-Term-Path`: the cache path, URL-encoded (`ga%2Fniamh-ni%CB%90v.mp3`)
- `X-Term-Cache`: `hit` or `miss`

Validation: `lang` must look like a BCP-47 tag. `term` and `ipa` must be non-empty, at most 100 characters, with no control characters and no `/` or `\`. Invalid requests get a 400.

### Other routes

| Route | Returns |
|---|---|
| `GET /cache/<lang>/<file>` | A cached MP3. Public, with `Access-Control-Allow-Origin: *` |
| `GET /index` | HTML index of the cache |
| `GET /new` | The form for new pronunciations |
| `GET /health` | `{ ok, provider }`. Doesn't check that the provider's keys work |

## Things to know

- **Language is matched exactly.** `en-GB` and `en` are separate folders, so a file made as `en-GB` won't be found by a page asking for `en`. (The audio adapter falls back from `en-GB` to `en`, not the other way round.)
- **Terms are used verbatim**, apart from lower-casing. "musk-roses" and "musk roses" are different files. The IPA is kept exactly.
- **The cache index is built at startup.** If you add, rename or delete files while the server runs, restart it. To re-synthesise a term, delete its MP3 and restart.
- **Only successful syntheses are cached.** Writes are atomic, and simultaneous requests for the same new term share one upstream call.

## Security

`POST /synthesize` spends your TTS quota. By default the server listens only on `127.0.0.1`, and it rejects browser requests from origins not in `CORS_ORIGIN` (its own pages are always allowed). That's a guard against other web pages, not authentication: anything that can reach the port without sending an `Origin` header, such as `curl`, can synthesise. Don't expose it to the internet as-is. Publish the cache instead.

Never commit `.env`. It, any credential files, and `cache/` are in `.gitignore`.

## License

[MIT](LICENSE). This covers the code only. Audio generated through Azure, Google or Polly is subject to that provider's terms, so check them before you publish a cache for others to reuse.
