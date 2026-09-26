# Ingest API contract

Wire format between this extractor and the ingest API. `src/contract.ts` is the typed version;
the API validates every field again on its side — unknown fields are dropped, enums are closed
lists, and anything outside the limits below is rejected.

Current versions: `schemaVersion` **2** for financial statements and **1** for corporate-action
notices; `extractorVersion` **8**.

## Authentication

Every request carries `Authorization: Bearer <GitHub OIDC token>` issued to this repository's
`extract.yml` workflow on `main`, for a `schedule` or `workflow_dispatch` event. There are no
stored credentials. Any authentication failure is a bare `401`/`403`.

## 1. Claim a task — `POST /api/v1/internal/extraction/claim`

```json
{ "kinds": ["financial_statement", "corporate_action_notice"], "extractorVersion": 2 }
```

`200` with one task, or `{ "data": { "task": null } }` when there is nothing to do. Every
response body is wrapped in `data`:

```json
{
  "data": {
    "task": {
      "id": "48213",
      "kind": "financial_statement",
      "sourceUrl": "https://financials.psx.com.pk/lib/DownloadPDF.php?id=272758",
      "context": { "symbol": "HPL", "reportType": "annual", "periodEnded": "2025" },
      "leaseToken": "<64 hex characters>",
      "leaseExpiresAt": "2026-09-23T10:30:00.000Z"
    }
  }
}
```

- `reportType`: `annual | quarterly | half_yearly`
- For `corporate_action_notice`, `context` is `{ "symbol", "title", "publishedAt" }` and
  `sourceUrl` may be `null` (the notice is parsed from its title alone).
- `sourceUrl` is always `https` on `financials.psx.com.pk` or `dps.psx.com.pk`; the extractor
  refuses anything else (`host_not_allowed`).
- The lease lasts 30 minutes. The token authorises submitting a result for this one task only.
- A `financial_statement` context may also carry `hints`, set by a reviewer for that filing:
  `{ "unitScale": 1000, "statements": [{ "type": "balance_sheet", "pages": [82], "basis": "unconsolidated" }] }`.
  `unitScale` is 1, 1000 or 1000000; each `statements` entry (at most 6) names a statement type
  (`income_statement`, `balance_sheet`, `cash_flow`), 1 to 6 ascending page numbers and optionally
  a basis. The key is absent when there are no hints. The extractor uses them only when every part
  is well-formed for the document (RULEBOOK.md H0 to H3).

## 2. Submit a result — `POST /api/v1/internal/extraction/results`

### 2a. Financial statement (schema version 2)

The full shape, with every field, is in [FINANCIALS.md](FINANCIALS.md): the envelope (`schemaVersion`
2, `taskId`, `leaseToken`, `extractorVersion`, `outcome`), then `document`, `periods`, `pages` and
`log`. The item keys of each period's `income`, `balance`, `cashFlow` and `ratios` are the closed
lists in [financial-items.json](financial-items.json); a key outside them is a `400`.

Each item is `null`, or one of:

- `{ "value", "source": "reported", "page", "text", "checks" }` — read from the filing;
- `{ "value", "source": "derived", "formula" }` — calculated from reported figures;
- `{ "value": 0, "source": "runtime", "formula" }` — market-based, calculated by the server from the
  day's close. Never stored as a figure.

What the API does again on its side, whatever the payload says:

- The filing's identity (company, period, document) comes from the task, never the payload.
- Every value must be finite and within ±1e15; a period must end within 18 months of the filing's.
- The accounting identities (revenue − cost of sales = gross profit, profit before tax − taxation =
  profit after tax, current + non-current assets = total assets, operating + investing + financing =
  net change in cash, opening + change = closing cash) and every derived formula are recomputed. A
  group that fails is dropped, and the drop is logged.

### 2b. Corporate-action notice

```json
{
  "schemaVersion": 1,
  "taskId": "90117",
  "leaseToken": "<same token>",
  "extractorVersion": 2,
  "outcome": "extracted",
  "document": { "kind": "pdf", "contentType": "application/pdf", "method": "pdftotext", "pageCount": 2, "confidence": 0.9 },
  "corporateActions": [
    {
      "actionType": "dividend",
      "exDate": "2026-09-05",
      "details": { "dividendPercent": 20 },
      "confidence": 0.82,
      "sourceText": "Cash dividend 20% ... Ex-date 05 Sep 2026"
    }
  ]
}
```

- `document` is `null` when the notice had no attachment or it could not be downloaded.
- `actionType`: `dividend | bonus | right | split`. `details` has exactly one key for the type:
  `dividendPercent`, `bonusPercent`, `rightPercent` (0–10,000) or `splitRatio` (`N:N`).
- `exDate` is `YYYY-MM-DD` or `null`. The event date is taken from the notice itself, not sent.

### 2c. Failure

```json
{
  "schemaVersion": 2, "taskId": "48213", "leaseToken": "<same token>", "extractorVersion": 4,
  "outcome": "failed",
  "error": { "code": "download_failed", "message": "download failed with HTTP 503" }
}
```

`code`: `download_failed | document_too_large | unsupported_type | extract_failed |
host_not_allowed`.

### Responses

| Status | Meaning |
|---|---|
| `202` | `{ "data": { "accepted": true } }` — resubmitting the same result is also `202` |
| `401` / `403` | identity not accepted — the run stops |
| `409` | lease not held (expired, superseded or unknown) — the task is skipped |
| `400` | payload failed validation — nothing was stored |

## Limits

| Field | Limit |
|---|---|
| `periods` | 40 |
| `log.drops` | 200 |
| `pages` | 150 (pages cited by a line are kept first) |
| `pages[].text` | 20,000 characters |
| `label` | 160 characters |
| `sourceText` | 1,000 (statement lines), 300 (corporate actions) |
| `corporateActions` | 10 |
| `error.message` | 500 characters |
| request body | 8 MB |
