# CS Copilot — Payabli

AI-powered ticket resolution tool for Payabli's CS, SRE, and engineering teams. Enter Linear ticket IDs or describe a problem in plain text, and the copilot automatically gathers context from Linear, Slack, and Payabli, then generates a diagnosis with actionable solutions.

## Features

- Fetches Linear ticket metadata, description, and comments
- Searches help and SRE Slack channels for related messages
- Pulls recent alerts from `#sre-alerts` and `#sre-prod-bug-alerts`
- Looks up Payabli transaction details when a transaction ID is found
- Generates AI-powered copilot summary with root cause analysis
- Provides numbered suggested solutions with per-step ownership (SRE, PayIn, PayOut, PayOps, CS)
- Free-text mode — describe a problem without a ticket ID
- Cards render one at a time as they complete

## Quick Start

```bash
# 1. Fill in API keys in index.html (see Configuration below)

# 2. Start the proxy server
node server.js

# 3. Open http://localhost:8081
```

## Configuration

Open `index.html` and fill in the `CONFIG` object at the top of the `<script>` tag:

```js
const CONFIG = {
  ANTHROPIC_API_KEY: '',   // sk-ant-...
  LINEAR_API_KEY:    '',   // lin_api_...
  SLACK_TOKEN:       '',   // xoxp-... or xoxb-... (needs search:read + channels:history)
  PAYABLI_TOKEN:     '',   // Payabli org-level API token
  PAYABLI_BASE_URL:  'https://api.payabli.com',
};
```

A yellow warning banner appears if any keys are missing.

## Architecture

```
Browser (index.html)
  ├─ /api/linear      → server.js proxy → Linear GraphQL API
  ├─ /api/slack/*      → server.js proxy → Slack Web API
  ├─ /api/anthropic    → server.js proxy → Anthropic Messages API
  └─ Direct call       → Payabli REST API (transaction lookup)
```

`server.js` is a lightweight Node.js proxy that forwards API requests to avoid CORS restrictions (especially Anthropic's org-level CORS policy).

## Usage

1. Enter ticket IDs (e.g. `SRE-4421, PIN-2776`) or a plain-text problem description
2. Press **Analyze →** or hit **Enter**
3. Cards appear as each ticket is processed through the pipeline

## Stack

- Single `index.html` — vanilla HTML + CSS + JS, no framework or bundler
- `server.js` — Node.js proxy server (zero dependencies)
- Anthropic API (`claude-sonnet-4-6`) for AI analysis
- Linear GraphQL API for ticket data
- Slack Web API for message search and channel history
- Payabli REST API for transaction lookup

## Team

Built by **Team 12** at the Payabli AI Hackathon 2026:
Evelio, Luis Trista, Vamsi, William Corbera, Rupal
