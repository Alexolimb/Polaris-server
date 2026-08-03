# Polaris server — backend

Backend for the [Polaris](https://github.com/Alexolimb/Polaris) investment simulator, implementing
the **v1** contract: market data plus the "Cosmo" AI mentor.

Written in **plain Node.js** (`node:http`, built-in `fetch`) with **zero external dependencies** —
it runs and tests anywhere without `npm install`.

## API

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `{ok, ai}` — server alive, AI backend reachable |
| GET | `/v1/assets` | Asset catalogue and themes (`freshness: "demo"`) |
| GET | `/v1/quotes?symbols=AAPL,MSFT` | Quotes — prices as **integer cents** |
| GET | `/v1/candles?symbol=AAPL&range=1d\|1w\|1m\|1y` | OHLC candles |
| GET | `/v1/dividends?symbol=AAPL` | Next dividend payment |
| POST | `/v1/ai/chat` | **SSE** stream: `data:{"delta":…}` … `data:[DONE]` |
| POST | `/v1/ai/trade-comment` | `{comment}` — short reaction to a trade |

## Design decisions

- **Market data is synthetic** (`src/quotes.js`): deterministic seeded noise per symbol and
  timestamp, honestly flagged as `freshness: "demo"`. This is deliberate — the backend runs with no
  paid market-data feed. The extension point for a real free provider is marked at the bottom of
  `quotes.js`; the function contracts do not change.
  Since 2026-08-03 the **app** can fetch real quotes directly from the Finnhub free tier with a
  user-supplied key (see the app repository) — so real prices no longer depend on this server
  being deployed at all.
- **Cosmo runs on a free LLM tier** (`src/ai.js`), model `llama-3.3-70b-versatile` via Groq. It is a
  chat mentor without tools; the system prompt forbids personalised investment advice and any
  promise of returns.
- **Prices are integers.** Cents everywhere, never floats — the client's simulation core makes the
  same choice, so no rounding drift between app and server.

## Configuration

Secrets live in the environment only — none in code. Copy `.env.example` to `.env`:

```
PORT=8787
GROQ_API_KEY=<key from https://console.groq.com/keys>   # without it quotes still work, Cosmo returns 503
GROQ_MODEL=                                             # optional, defaults to llama-3.3-70b-versatile
```

## Run and test

```bash
npm start          # node src/index.js  -> listens on :PORT
npm test           # node --test        -> 22 tests, all green
```

No `npm install` needed. Requires Node ≥ 18.

## Deployment — decided 2026-08-03: not deployed, on purpose

This is a **standby** backend, and that is a decision rather than an unfinished task. The app
fetches its data from an n8n instance, not from here, and works fully without this server. Keeping
it undeployed costs nothing and removes one more moving part that could fall over at night.

Should that change, the server is stateless and listens on `PORT`. It runs as-is on any Node host
(Render, Railway, Fly, a plain VPS behind Caddy/Nginx for HTTPS) with `GROQ_API_KEY` set in the
environment. Porting to a Cloudflare Worker needs only the `node:http` entry point swapped for a
`fetch` handler, with SSE emitted through a `TransformStream` — `quotes.js` and `ai.js` carry over
unchanged. After deploying, point `defaultBaseUrl` in the app's `lib/services/api.dart` at it.

## Backups

This git repository · a dated copy on an external drive · GitHub. The GitHub repository is
**public by design** — the Polaris code doubles as a portfolio piece. No live keys are in it and
none ever should be: secrets live in the environment only.
