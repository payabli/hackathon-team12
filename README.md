# SRE Copilot — Payabli Internal

A single-page tool for Payabli's SRE and engineering team. Enter one or more Linear ticket IDs, click **Analyze**, and the page automatically fetches ticket details, searches Slack, checks system health alerts, looks up transaction data, and generates an AI-powered diagnosis with suggested solutions.

## Features

- Fetches Linear ticket metadata, description, and comments
- Searches help and SRE Slack channels for related messages
- Pulls recent alerts from `#sre-alerts` and `#sre-prod-bug-alerts`
- Looks up Payabli transaction details when a transaction ID is found in the ticket
- Sends all context to the Anthropic API and renders a structured copilot summary
- Shows numbered suggested solutions with per-step ownership (SRE, PayIn, PayOut, PayOps, CS)
- Renders cards one at a time as they complete — no waiting for all tickets

## Running the App

The app is a single `index.html` file with no build step required.

**Serve it locally with:**

```bash
npx serve .
```

Then open `http://localhost:3000` in your browser.

> **Why a server?** Opening `index.html` directly via `file://` will cause **CORS errors** on every API call (Linear, Slack, Anthropic, Payabli). Browsers block cross-origin requests from `file://` origins. Serving via `npx serve .` gives the page an `http://localhost` origin, which the APIs accept.

## Configuration

Before analyzing tickets, open `index.html` and fill in the `CONFIG` object at the top of the `<script>` tag:

```js
const CONFIG = {
  ANTHROPIC_API_KEY: '',   // sk-ant-...
  LINEAR_API_KEY:    '',   // lin_api_...
  SLACK_TOKEN:       '',   // xoxb-... (needs search:read + channels:history scopes)
  PAYABLI_TOKEN:     '',   // Payabli org-level API token
  PAYABLI_BASE_URL:  'https://api.payabli.com',
};
```

If any value is missing, a yellow warning banner appears at the top of the page.

## Usage

1. Enter one or more ticket IDs in the input box (e.g. `SRE-4421` or `SRE-4421, PIN-2776`)
2. Press **Analyze →** or hit **Enter**
3. Cards appear one at a time as each ticket is processed

## Stack

- Vanilla HTML + CSS + JavaScript — no framework, no bundler, no npm
- Anthropic API (`claude-sonnet-4-6`) for AI analysis
- Linear GraphQL API for ticket data
- Slack Web API for message search and channel history
- Payabli REST API for transaction lookup
