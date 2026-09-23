# data-ingestion

Extracts structured figures from public Pakistan Stock Exchange filings — annual, half-yearly and
quarterly financial statements, and corporate-action notices — and submits them to an ingest API.

## How it works

A scheduled GitHub Actions workflow runs several workers side by side. Each one loops:

1. **Claim** a task from the ingest API (a document URL on a PSX host, plus its symbol and period).
2. **Extract** text with `pdftotext`, falling back to `tesseract` OCR for scanned pages.
3. **Parse** statement line items (income statement, balance sheet, cash flow — consolidated and
   unconsolidated kept separately) or dividend/bonus/right/split entitlements.
4. **Submit** the result, as described in [CONTRACT.md](CONTRACT.md).

The workflow authenticates with its short-lived GitHub OIDC identity; the repository stores no
credentials.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run scan   # secret scan -- also runs in CI
```

Local OCR needs `poppler-utils` and `tesseract-ocr` on the `PATH`; the extractor refuses to start
without them (set `INGEST_SKIP_TOOLCHAIN_CHECK=1` only for local API testing). The manual
**Self-test** workflow runs the full toolchain on public sample filings without contacting the API.

## Configuration (workflow)

| Name | Kind | Purpose |
|---|---|---|
| `INGEST_API_URL` | secret | Base URL of the ingest API (a secret only so it is masked in public logs) |
| `INGEST_OIDC_AUDIENCE` | secret | Audience the OIDC token is requested for |
