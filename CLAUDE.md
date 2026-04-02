# SRE Copilot — CLAUDE.md

Build a **single `index.html` file** with all CSS and JavaScript inline.
No build tools, no npm, no bundler. Must open directly in a browser or with `npx serve .`.

---

## What To Build

A tool for Payabli's SRE and engineering team. The user enters one or more Linear ticket IDs
(e.g. `SRE-4421` or `SRE-4421, SRE-4418`), clicks **Analyze**, and the page:

1. Fetches each ticket from Linear (title, description, comments, metadata)
2. Searches Slack help channels and SRE channels for related messages
3. Checks SRE system health alerts from `#sre-alerts` and `#sre-prod-bug-alerts`
4. If a transaction ID is found in the ticket, fetches it from the Payabli API
5. Sends all gathered context to the Anthropic API and renders an AI copilot summary
6. Shows a numbered "Suggested Solutions" section with per-step owners

---

## Credentials

Read from a config object at the top of the `<script>` tag. The user fills these in before use.

```js
const CONFIG = {
  ANTHROPIC_API_KEY: '',   // sk-ant-...
  LINEAR_API_KEY:    '',   // lin_api_...  (linear.app/settings/api — no "Bearer" prefix needed)
  SLACK_TOKEN:       '',   // xoxb-...     (bot token with search:read + channels:history scopes)
  PAYABLI_TOKEN:     '',   // Payabli org-level API token (requestToken header)
  PAYABLI_BASE_URL:  'https://api.payabli.com',
};
```

On page load, check if any CONFIG value is empty and show a yellow banner if so:
`⚠ Missing API keys — fill in CONFIG at the top of the script before analyzing tickets.`

---

## Slack Channel IDs (hardcoded — do not search for these)

```js
const SLACK_CHANNELS = {
  // Help channels
  helpPayIn:        'C09ER2YGNDR',  // #help-pay-in
  helpPayOps:       'C09EERZE7D5',  // #help-pay-ops
  helpPayOut:       'C09EV2P2W4S',  // #help-pay-out
  helpPayPlatform:  'C09EV2REGQ2',  // #help-pay-platform
  helpPayAI:        'C09EES01RFH',  // #help-pay-ai
  // SRE channels
  sreAlerts:        'C07TKLMM36F',  // #sre-alerts
  sreProdBugAlerts: 'C0AMGPU08EB',  // #sre-prod-bug-alerts
  sreAlertsNoPage:  'C0AKVGEN77E',  // #sre-alerts-nopage
  sreTeam:          'C075VNWSVC3',  // #sre-team
  sreReports:       'C0A1127H9SS',  // #sre-reports
};
```

---

## Page Layout

```
┌─────────────────────────────────────────────────────┐
│  ✦ SRE Copilot                    Payabli Internal  │
├─────────────────────────────────────────────────────┤
│  [ SRE-4421, PIN-2776             ] [ Analyze → ]  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌── SRE-4421 ──────────────────────────────────┐  │
│  │  Title · Priority · Assignee · Status        │  │
│  │  [Description — collapsible]                 │  │
│  ├──────────────────────────────────────────────┤  │
│  │  🔍 Slack Context        (collapsible, open) │  │
│  ├──────────────────────────────────────────────┤  │
│  │  ⚡ System Health         (collapsible)      │  │
│  ├──────────────────────────────────────────────┤  │
│  │  💳 Transaction Details   (if found, open)   │  │
│  ├──────────────────────────────────────────────┤  │
│  │  ✦ Copilot Summary        (prominent AI box) │  │
│  ├──────────────────────────────────────────────┤  │
│  │  💡 Suggested Solutions   (numbered list)    │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  [second card if multiple IDs entered]              │
└─────────────────────────────────────────────────────┘
```

Render cards one at a time as they complete — do not wait for all tickets before showing the first.

---

## Step 1 — Fetch Linear Ticket

```js
async function fetchLinearTicket(ticketId) {
  const query = `
    query IssueByIdentifier($id: String!) {
      issue(id: $id) {
        identifier
        title
        description
        priority
        createdAt
        updatedAt
        state { name type }
        assignee { name email }
        team { name }
        labels { nodes { name } }
        comments {
          nodes { body createdAt user { name } }
        }
      }
    }
  `;

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': CONFIG.LINEAR_API_KEY,  // Linear accepts the key directly, no Bearer prefix
    },
    body: JSON.stringify({ query, variables: { id: ticketId } })
  });

  const data = await response.json();
  if (data.errors) throw new Error(`Linear: ${data.errors[0].message}`);
  if (!data.data?.issue) throw new Error(`Ticket ${ticketId} not found. Check the ID and your Linear API key.`);
  return data.data.issue;
}
```

---

## Step 2 — Extract Identifiers from Ticket

Parse the ticket title and description for useful identifiers before fetching external data.

```js
function extractIdentifiers(ticket) {
  const text = `${ticket.title} ${ticket.description ?? ''} ${
    ticket.comments?.nodes?.map(c => c.body).join(' ') ?? ''
  }`;

  return {
    // Partner name: SRE titles often follow "PartnerName — description of issue"
    partnerName: ticket.title.match(/^([^—–\-]+)[—–\-]/)?.[1]?.trim() ?? null,

    // PPID: "PPID 12345", "PPID: 12345", "ppid=12345"
    ppid: text.match(/ppid[:\s=#]*(\d{4,6})/i)?.[1] ?? null,

    // Transaction ID: Payabli v1 format "PPID-hexstring" e.g. "40469-abc123def456..."
    // or v2 format "TRN_AbCdEf..."
    transactionId: (
      text.match(/\b(\d{3,6}-[a-f0-9]{20,})\b/i)?.[1] ??
      text.match(/\b(TRN_[A-Za-z0-9]{20,})\b/)?.[1] ??
      null
    ),

    // Org ID
    orgId: text.match(/org(?:anization)?[\s_]?id[:\s#=]*(\d+)/i)?.[1] ?? null,

    // Error codes: D0xxx or E9xxx
    errorCodes: [...text.matchAll(/\b([DE]\d{4})\b/g)].map(m => m[1]),
  };
}
```

---

## Step 3 — Fetch Slack Context

### 3a — Related Messages from Help + SRE Channels

```js
async function fetchSlackContext(ticket, identifiers) {
  // Use the most specific term available
  const searchTerm = identifiers.partnerName
    ?? (identifiers.ppid ? `PPID ${identifiers.ppid}` : null)
    ?? ticket.title.split(/\s+/).slice(0, 5).join(' ');

  const channelFilter = [
    'help-pay-in', 'help-pay-ops', 'help-pay-out',
    'help-pay-platform', 'sre-team'
  ].map(c => `in:#${c}`).join(' ');

  const params = new URLSearchParams({
    query: `${searchTerm} ${channelFilter}`,
    count: 15,
    sort: 'timestamp',
    sort_dir: 'desc',
  });

  const response = await fetch(`https://slack.com/api/search.messages?${params}`, {
    headers: { 'Authorization': `Bearer ${CONFIG.SLACK_TOKEN}` }
  });

  const data = await response.json();
  if (!data.ok) return [];

  return (data.messages?.matches ?? []).map(m => ({
    sender:    m.username,
    channel:   m.channel?.name ?? 'unknown',
    ts:        m.ts,
    text:      m.text,
    permalink: m.permalink,
  }));
}
```

### 3b — System Health from SRE Alert Channels

Pull recent messages from `#sre-alerts` and `#sre-prod-bug-alerts`. Called once and
shared across all tickets being analyzed.

```js
async function fetchSREHealthAlerts() {
  const targets = [
    { id: SLACK_CHANNELS.sreAlerts,        name: 'sre-alerts' },
    { id: SLACK_CHANNELS.sreProdBugAlerts, name: 'sre-prod-bug-alerts' },
  ];

  const results = [];

  for (const ch of targets) {
    const response = await fetch(
      `https://slack.com/api/conversations.history?channel=${ch.id}&limit=20`,
      { headers: { 'Authorization': `Bearer ${CONFIG.SLACK_TOKEN}` } }
    );
    const data = await response.json();
    if (!data.ok) continue;

    for (const msg of data.messages ?? []) {
      if (!msg.text?.trim()) continue;
      results.push({
        channel: ch.name,
        ts:      msg.ts,
        time:    new Date(parseFloat(msg.ts) * 1000).toLocaleString(),
        text:    msg.text,
      });
    }
  }

  return results
    .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
    .slice(0, 20);
}
```

---

## Step 4 — Fetch Transaction from Payabli

Only called when `identifiers.transactionId` is not null. Silently returns null on failure.

```js
async function fetchPayabliTransaction(transactionId) {
  const response = await fetch(
    `${CONFIG.PAYABLI_BASE_URL}/api/v2/query/transactions?transId=${encodeURIComponent(transactionId)}&limitRecord=1`,
    {
      headers: {
        'requestToken': CONFIG.PAYABLI_TOKEN,
        'Content-Type': 'application/json',
      }
    }
  );

  if (!response.ok) return null;

  const data = await response.json();
  const txn = data.Records?.[0] ?? data.data?.[0] ?? null;
  if (!txn) return null;

  return {
    transId:        txn.TransactionId ?? txn.transId ?? transactionId,
    amount:         txn.TransactionData?.TotalAmount ?? txn.amount ?? '—',
    status:         txn.TransactionStatus ?? txn.status ?? '—',
    resultCode:     txn.ResultCode ?? txn.resultCode ?? '—',
    resultCodeText: txn.ResultCodeText ?? txn.resultCodeText ?? '—',
    paymentMethod:  txn.PaymentData?.CardType ?? txn.PaymentData?.AccountType ?? '—',
    createdAt:      txn.TransactionDate ?? txn.createdAt ?? '—',
    ppid:           txn.PaypointId ?? txn.ppid ?? '—',
    processorRef:   txn.ReferenceData?.ProcessorReferenceId ?? '—',
  };
}
```

---

## Step 5 — Anthropic API: Copilot Summary + Solutions

Single call. Pack all gathered context into a structured prompt.

```js
async function generateCopilotSummary({ ticket, identifiers, slackMessages, healthAlerts, transaction }) {
  const priorityLabels = ['None', 'Urgent', 'High', 'Medium', 'Low'];

  const context = `
## TICKET
ID: ${ticket.identifier}
Title: ${ticket.title}
Priority: ${priorityLabels[ticket.priority] ?? 'Unknown'}
Status: ${ticket.state?.name}
Team: ${ticket.team?.name}
Assignee: ${ticket.assignee?.name ?? 'Unassigned'}
Created: ${new Date(ticket.createdAt).toLocaleString()}

Description:
${ticket.description ?? '(no description provided)'}

${ticket.comments?.nodes?.length ? `Comments:\n${
  ticket.comments.nodes.slice(0, 5).map(c =>
    `[${c.user?.name ?? 'unknown'}]: ${c.body}`
  ).join('\n')
}` : ''}

## EXTRACTED IDENTIFIERS
Partner: ${identifiers.partnerName ?? 'not detected'}
PPID: ${identifiers.ppid ?? 'not detected'}
Transaction ID: ${identifiers.transactionId ?? 'not detected'}
Error Codes: ${identifiers.errorCodes.length ? identifiers.errorCodes.join(', ') : 'none'}

## SLACK CONTEXT
${slackMessages.length
  ? slackMessages.map(m =>
      `[${m.sender}] [#${m.channel}] ${new Date(parseFloat(m.ts)*1000).toLocaleString()}: ${m.text}`
    ).join('\n')
  : 'No related Slack messages found in help or SRE channels.'}

## SYSTEM HEALTH (recent SRE alerts)
${healthAlerts.length
  ? healthAlerts.slice(0, 10).map(a =>
      `[${a.time}] [#${a.channel}]: ${a.text}`
    ).join('\n')
  : 'No recent system alerts found.'}

## TRANSACTION DETAILS
${transaction ? `
Transaction ID:  ${transaction.transId}
Amount:          $${transaction.amount}
Status:          ${transaction.status}
Result Code:     ${transaction.resultCode} — ${transaction.resultCodeText}
Payment Method:  ${transaction.paymentMethod}
PPID:            ${transaction.ppid}
Processor Ref:   ${transaction.processorRef}
Created:         ${transaction.createdAt}
`.trim() : 'No transaction data available for this ticket.'}
`.trim();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are an SRE copilot at Payabli, a B2B payment processing company.
Payabli processes payments via processors: Fiserv, Global Payments (GP), NMI.
Key terms: PayIn=collecting payments, PayOut=vendor payments, PPID=paypoint ID,
batch close=end-of-day processing, EBF=electronic batch funding,
webhooks/notifications=event delivery to partners, SRE=site reliability engineering.
Error codes: D-codes are processor declines, E-codes are platform errors.

Analyze the following ticket context and return a structured analysis.

${context}

Return ONLY valid JSON with no markdown fences, no explanation outside the JSON:
{
  "summary": "3-5 sentences. What is broken, the most likely root cause, business impact, and what has already been tried based on Slack. Be specific — name the system, error codes, partner.",
  "suggestedSolutions": [
    {
      "step": 1,
      "action": "Short imperative action title",
      "detail": "Specific how-to: exact endpoint to call, DB query to run, Slack channel to check, or CloudWatch log to inspect. Be concrete.",
      "owner": "SRE | PayIn | PayOut | PayOps | CS"
    }
  ]
}
Provide 3-5 solutions ordered by: quickest to execute and most likely to resolve first.`
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Anthropic API: ${err.error?.message ?? response.status}`);
  }

  const data = await response.json();
  const raw = data.content[0].text;

  try {
    return JSON.parse(raw);
  } catch {
    // Strip markdown fences if Claude added them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  }
}
```

---

## Step 6 — Orchestration

```js
async function analyzeTickets(ticketIds) {
  const container = document.getElementById('results');
  container.innerHTML = '';

  // Fetch system health once — shared across all tickets
  const healthAlerts = await fetchSREHealthAlerts().catch(() => []);

  for (const ticketId of ticketIds) {
    const card = createTicketCard(ticketId);
    container.appendChild(card);

    try {
      // 1. Ticket
      updateCardStatus(card, 'Fetching from Linear...');
      const ticket = await fetchLinearTicket(ticketId);
      renderTicketHeader(card, ticket);

      // 2. Identifiers
      const identifiers = extractIdentifiers(ticket);

      // 3 + 4. Slack and Payabli in parallel
      updateCardStatus(card, 'Searching Slack and fetching transaction...');
      const [slackMessages, transaction] = await Promise.all([
        fetchSlackContext(ticket, identifiers).catch(() => []),
        identifiers.transactionId
          ? fetchPayabliTransaction(identifiers.transactionId).catch(() => null)
          : Promise.resolve(null),
      ]);

      renderSlackSection(card, slackMessages);
      renderHealthSection(card, healthAlerts);
      if (transaction) renderTransactionSection(card, transaction);

      // 5. AI analysis
      updateCardStatus(card, 'Generating AI analysis...');
      const analysis = await generateCopilotSummary({
        ticket, identifiers, slackMessages, healthAlerts, transaction
      });

      renderCopilotSummary(card, analysis.summary);
      renderSuggestedSolutions(card, analysis.suggestedSolutions);
      updateCardStatus(card, null);

    } catch (err) {
      renderCardError(card, ticketId, err.message);
    }
  }
}
```

---

## Rendering Functions

```js
function createTicketCard(ticketId) {
  const card = document.createElement('div');
  card.className = 'ticket-card';
  card.innerHTML = `
    <div class="card-topbar">
      <span class="ticket-id-badge">${ticketId}</span>
      <span class="card-status"></span>
    </div>
    <div class="card-body"></div>
  `;
  return card;
}

function updateCardStatus(card, msg) {
  card.querySelector('.card-status').textContent = msg ?? '';
}

function renderTicketHeader(card, ticket) {
  const priorities = ['—', '🔴 Urgent', '🟠 High', '🟡 Medium', '⚪ Low'];
  card.querySelector('.card-body').insertAdjacentHTML('beforeend', `
    <div class="ticket-header">
      <h2 class="ticket-title">${escapeHtml(ticket.title)}</h2>
      <div class="ticket-meta">
        <span class="meta-pill">${priorities[ticket.priority] ?? '—'}</span>
        <span class="meta-pill">${escapeHtml(ticket.state?.name ?? 'Unknown')}</span>
        <span class="meta-pill">${escapeHtml(ticket.assignee?.name ?? 'Unassigned')}</span>
        <span class="meta-pill">${escapeHtml(ticket.team?.name ?? '')}</span>
        <span class="meta-pill muted">${new Date(ticket.createdAt).toLocaleDateString()}</span>
      </div>
      ${ticket.description ? `
        <details class="description-block">
          <summary>Description</summary>
          <pre class="description-text">${escapeHtml(ticket.description)}</pre>
        </details>` : ''}
    </div>
  `);
}

function renderSlackSection(card, messages) {
  const html = messages.length
    ? messages.map(m => `
        <div class="slack-msg">
          <div class="slack-msg-header">
            <strong>${escapeHtml(m.sender)}</strong>
            <span class="channel-tag">#${escapeHtml(m.channel)}</span>
            <span class="msg-time">${new Date(parseFloat(m.ts)*1000).toLocaleString()}</span>
            ${m.permalink ? `<a href="${m.permalink}" target="_blank" class="msg-link">↗</a>` : ''}
          </div>
          <div class="slack-msg-text">${escapeHtml(m.text)}</div>
        </div>`).join('')
    : '<p class="empty-state">No related messages found in help or SRE channels.</p>';

  card.querySelector('.card-body').insertAdjacentHTML('beforeend', `
    <details class="section slack-section" open>
      <summary class="section-title">
        🔍 Slack Context
        ${messages.length ? `<span class="count">${messages.length} messages</span>` : ''}
      </summary>
      <div class="slack-messages">${html}</div>
    </details>
  `);
}

function renderHealthSection(card, alerts) {
  if (!alerts.length) return;
  card.querySelector('.card-body').insertAdjacentHTML('beforeend', `
    <details class="section health-section">
      <summary class="section-title">
        ⚡ System Health <span class="count">${alerts.length} recent alerts</span>
      </summary>
      <div class="health-alerts">
        ${alerts.map(a => `
          <div class="alert-row">
            <span class="alert-channel">#${escapeHtml(a.channel)}</span>
            <span class="alert-time">${escapeHtml(a.time)}</span>
            <span class="alert-text">${escapeHtml(a.text.slice(0, 220))}</span>
          </div>`).join('')}
      </div>
    </details>
  `);
}

function renderTransactionSection(card, txn) {
  const statusClass = {
    'approved': 'status-green', 'success': 'status-green',
    'declined': 'status-red',   'failed':   'status-red',
    'pending':  'status-yellow','void':     'status-muted',
  }[txn.status?.toLowerCase()] ?? 'status-muted';

  card.querySelector('.card-body').insertAdjacentHTML('beforeend', `
    <details class="section txn-section" open>
      <summary class="section-title">💳 Transaction Details</summary>
      <div class="txn-grid">
        <div class="txn-row"><span>Transaction ID</span><code>${escapeHtml(txn.transId)}</code></div>
        <div class="txn-row"><span>Amount</span><strong>$${escapeHtml(String(txn.amount))}</strong></div>
        <div class="txn-row"><span>Status</span><span class="status-badge ${statusClass}">${escapeHtml(txn.status)}</span></div>
        <div class="txn-row"><span>Result Code</span><code>${escapeHtml(txn.resultCode)}</code> <span class="muted">${escapeHtml(txn.resultCodeText)}</span></div>
        <div class="txn-row"><span>Payment Method</span>${escapeHtml(txn.paymentMethod)}</div>
        <div class="txn-row"><span>PPID</span>${escapeHtml(String(txn.ppid))}</div>
        <div class="txn-row"><span>Processor Ref</span><code>${escapeHtml(txn.processorRef)}</code></div>
        <div class="txn-row"><span>Created</span>${escapeHtml(txn.createdAt)}</div>
      </div>
    </details>
  `);
}

function renderCopilotSummary(card, summary) {
  card.querySelector('.card-body').insertAdjacentHTML('beforeend', `
    <div class="section copilot-summary">
      <div class="section-title copilot-label">✦ Copilot Summary</div>
      <p class="summary-text">${escapeHtml(summary)}</p>
    </div>
  `);
}

function renderSuggestedSolutions(card, solutions) {
  const ownerClass = {
    'SRE': 'owner-sre', 'PayIn': 'owner-payin', 'PayOut': 'owner-payout',
    'PayOps': 'owner-payops', 'CS': 'owner-cs',
  };
  card.querySelector('.card-body').insertAdjacentHTML('beforeend', `
    <div class="section solutions-section">
      <div class="section-title">💡 Suggested Solutions</div>
      <ol class="solutions-list">
        ${solutions.map(s => `
          <li class="solution-item">
            <div class="solution-action">
              ${escapeHtml(s.action)}
              <span class="owner-badge ${ownerClass[s.owner] ?? ''}">${escapeHtml(s.owner)}</span>
            </div>
            <div class="solution-detail">${escapeHtml(s.detail)}</div>
          </li>`).join('')}
      </ol>
    </div>
  `);
}

function renderCardError(card, ticketId, message) {
  updateCardStatus(card, '⚠ Error');
  card.querySelector('.card-body').innerHTML = `
    <div class="error-state">
      <strong>Failed to analyze ${escapeHtml(ticketId)}</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

---

## Input + Event Wiring

```js
document.getElementById('analyze-btn').addEventListener('click', () => {
  const raw = document.getElementById('ticket-input').value.trim();
  if (!raw) return;

  // Accept comma, space, or newline separated IDs
  const ids = raw
    .split(/[\s,\n]+/)
    .map(id => id.trim().toUpperCase())
    .filter(id => /^[A-Z]+-\d+$/.test(id));

  if (!ids.length) {
    alert('Enter valid ticket IDs like SRE-4421 or PIN-2776');
    return;
  }

  analyzeTickets(ids);
});

// Shift+Enter = newline in textarea, Enter alone = submit
document.getElementById('ticket-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('analyze-btn').click();
  }
});

// On load: warn about missing credentials
window.addEventListener('DOMContentLoaded', () => {
  const missing = Object.entries(CONFIG)
    .filter(([k, v]) => !v && k !== 'PAYABLI_BASE_URL')
    .map(([k]) => k);

  if (missing.length) {
    document.getElementById('config-warning').textContent =
      `⚠ Missing credentials: ${missing.join(', ')} — fill in CONFIG before analyzing.`;
    document.getElementById('config-warning').style.display = 'block';
  }
});
```

---

## CSS Design

Dark theme. Same palette as the existing `sre-copilot.html` mock.

```
Background:   #0a0c10
Surface:      #111318
Surface 2:    #181c24
Border:       #1e2330
Text:         #e2e6f0
Muted:        #606880
Accent blue:  #4f7cff
Green:        #2dd98f
Red:          #ff5f5f
Yellow:       #f5c842
Purple:       #a78bfa
Orange:       #ff8c42

Fonts (Google Fonts):
  IBM Plex Mono — IDs, code, badges, timestamps, channel names
  DM Sans       — all body text, labels, actions
```

Key styling rules:

- **Copilot Summary box**: gradient top border (blue → purple), slightly lighter background,
  `✦` sparkle icon, `font-size: 15px`, generous padding. This is the most important element.

- **Suggested Solutions**: numbered `<ol>`, each `<li>` has a bold action line with an
  inline owner badge. Owner badge colors:
  - SRE    → purple bg  (`#a78bfa` tint)
  - PayIn  → blue bg    (`#4f7cff` tint)
  - PayOut → green bg   (`#2dd98f` tint)
  - PayOps → orange bg  (`#ff8c42` tint)
  - CS     → yellow bg  (`#f5c842` tint)

- **Slack messages**: mini message bubbles with sender bold, channel in a `#channel` pill,
  timestamp in muted mono font, optional `↗` permalink

- **Transaction grid**: two-column key/value layout, `code` elements for IDs and result codes

- **`<details>/<summary>`**: custom styling — arrow replaced with a `›` that rotates on open,
  section titles use the section emoji + label pattern shown above

- **Card topbar**: flex row with ticket ID badge on left, loading status text on right
  (status clears when analysis is complete)

- **Status badge colors** for transaction status:
  - approved/success → green
  - declined/failed  → red
  - pending          → yellow
  - void/unknown     → muted

- Loading state: while `card-status` has text, show a subtle pulsing animation on the
  card's left border (use CSS `@keyframes` on `border-left-color`)

---

## Complete File Structure

One file: `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SRE Copilot — Payabli</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    /* all CSS here */
  </style>
</head>
<body>
  <div id="config-warning" style="display:none"></div>

  <header>
    <div class="logo">✦ SRE Copilot</div>
    <div class="logo-sub">Payabli Internal</div>
  </header>

  <div class="input-bar">
    <textarea id="ticket-input" placeholder="SRE-4421&#10;SRE-4418, PIN-2776" rows="2"></textarea>
    <button id="analyze-btn">Analyze →</button>
  </div>

  <div id="results"></div>

  <script>
    const CONFIG = { ... };
    const SLACK_CHANNELS = { ... };

    /* all functions */
    /* event listeners at bottom */
  </script>
</body>
</html>
```

---

## Error Handling Reference

| Situation | Behavior |
|---|---|
| Linear ticket not found | Throw with "Ticket X not found. Check the ID and your Linear API key." |
| Linear API key invalid | Throw with Linear's error message |
| Slack search returns nothing | Render "No related messages found" — not an error state |
| Slack API auth failure | Silently return `[]` — log to console |
| Payabli transaction not found | Skip the transaction section — not an error |
| Payabli API auth failure | Silently return `null` — log to console |
| Anthropic API error | Show error in card but still display the ticket header + Slack data |
| JSON parse failure on Claude response | Log raw text to console, show "AI analysis failed" in card |
| All CONFIG values empty | Yellow banner at top of page — do not prevent ticket input from rendering |

---

## Pre-flight Checklist

1. Fill in all `CONFIG` values
2. In browser console: `fetchLinearTicket('SRE-4421')` → confirm ticket data returns
3. In browser console: `fetchSREHealthAlerts()` → confirm you get SRE alert messages
4. Run one full ticket end-to-end and verify all 6 sections render
5. Prepare 2–3 real ticket IDs with known Slack context for the demo
