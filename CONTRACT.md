# Ingest API contract

Wire format between this extractor and the ingest API. `src/contract.ts` is the typed version;
the API validates every field again on its side — unknown fields are dropped, enums are closed
lists, and anything outside the limits below is rejected.

Current versions: `schemaVersion` **1**, `extractorVersion` **2**.

## Authentication

Every request carries `Authorization: Bearer <GitHub OIDC token>` issued to this repository's
`extract.yml` workflow on `main`, for a `schedule` or `workflow_dispatch` event. There are no
stored credentials. Any authentication failure is a bare `401`/`403`.

## 1. Claim a task — `POST /api/v1/internal/extraction/claim`

```json
{ "kinds": ["financial_statement", "corporate_action_notice"], "extractorVersion": 2 }
```

`200` with one task, or `{ "task": null }` when there is nothing to do:

```json
{
  "task": {
    "id": "48213",
    "kind": "financial_statement",
    "sourceUrl": "https://financials.psx.com.pk/lib/DownloadPDF.php?id=272758",
    "context": { "symbol": "HPL", "reportType": "annual", "periodEnded": "2025" },
    "leaseToken": "<64 hex characters>",
    "leaseExpiresAt": "2026-09-23T10:30:00.000Z"
  }
}
```

- `reportType`: `annual | quarterly | half_yearly`
- For `corporate_action_notice`, `context` is `{ "symbol", "title", "publishedAt" }` and
  `sourceUrl` may be `null` (the notice is parsed from its title alone).
- `sourceUrl` is always `https` on `financials.psx.com.pk` or `dps.psx.com.pk`; the extractor
  refuses anything else (`host_not_allowed`).
- The lease lasts 30 minutes. The token authorises submitting a result for this one task only.

## 2. Submit a result — `POST /api/v1/internal/extraction/results`

### 2a. Financial statement

```json
{
  "schemaVersion": 1,
  "taskId": "48213",
  "leaseToken": "<same token>",
  "extractorVersion": 2,
  "outcome": "extracted",
  "document": {
    "kind": "pdf",
    "contentType": "application/pdf",
    "method": "pdftotext+tesseract",
    "pageCount": 104,
    "confidence": 0.85
  },
  "statement": {
    "status": "complete",
    "candidateCount": 57,
    "lines": [
      {
        "statementType": "income_statement",
        "canonicalLineItem": "cost_of_sales",
        "consolidationBasis": "unconsolidated",
        "label": "Cost of sales",
        "periodLabel": "2025",
        "periodEnd": "2025-12-31",
        "value": 19631164000,
        "currency": "PKR",
        "unitScale": 1000,
        "confidence": 0.86,
        "sourcePage": 37,
        "sourceText": "Cost of sales 25 (19,631,164) (18,320,291)"
      }
    ]
  },
  "pages": [{ "pageNumber": 37, "method": "pdftotext", "confidence": 0.9, "text": "..." }]
}
```

- `statementType`: `income_statement | balance_sheet | cash_flow`
- `consolidationBasis`: `consolidated | unconsolidated | unknown`
- `status`: `complete | partial | low_confidence | failed | unsupported`
- `value` is already scaled to rupees (`unitScale` records the factor applied). Expense lines
  are positive magnitudes. EPS is per share with `unitScale: 1`.
- `periodEnd` is `YYYY-MM-DD` or `null`.
- `canonicalLineItem` is one of:
  - **Income statement** — `revenue, cost_of_sales, gross_profit, selling_admin_expenses,
    distribution_cost, admin_expenses, rd_expenses, depreciation_amortization,
    other_operating_expenses, other_income, operating_expenses, operating_profit, ebitda,
    interest_income, finance_cost, net_interest_income, profit_before_tax, taxation,
    profit_after_tax, preferred_dividends, eps_basic, eps_diluted`
  - **Balance sheet** — `total_assets, current_assets, property_plant_equipment, stock_in_trade,
    trade_debts, total_liabilities, current_liabilities, trade_and_other_payables,
    short_term_borrowings, long_term_debt, total_debt, share_capital, retained_earnings,
    non_controlling_interest, total_equity, cash_and_bank`
  - **Cash flow** — `operating_cash_flow, capital_expenditure, investing_cash_flow,
    dividend_paid, financing_cash_flow`
  - **Derived ratios** (`income_statement`, `currency: null`, `unitScale: 1`, value in percent)
    — `gross_margin_pct, operating_margin_pct, net_margin_pct, tax_rate_pct`
- Derived items (`ebitda`, `operating_expenses`, `selling_admin_expenses`,
  `net_interest_income`, the ratios, and `total_equity` when not stated) must equal their inputs;
  the API recomputes and rejects a mismatch.

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
  "schemaVersion": 1, "taskId": "48213", "leaseToken": "<same token>", "extractorVersion": 2,
  "outcome": "failed",
  "error": { "code": "download_failed", "message": "download failed with HTTP 503" }
}
```

`code`: `download_failed | document_too_large | unsupported_type | extract_failed |
host_not_allowed`.

### Responses

| Status | Meaning |
|---|---|
| `202` | accepted (resubmitting the same result is also `202`) |
| `401` / `403` | identity not accepted — the run stops |
| `409` | lease expired or already superseded — the task is skipped |
| `422` | payload failed validation — nothing was stored |

## Limits

| Field | Limit |
|---|---|
| `statement.lines` | 400 |
| `pages` | 150 (pages cited by a line are kept first) |
| `pages[].text` | 20,000 characters |
| `label` | 160 characters |
| `sourceText` | 1,000 (statement lines), 300 (corporate actions) |
| `corporateActions` | 10 |
| `error.message` | 500 characters |
| request body | 8 MB |
