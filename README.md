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

## Financial statements pipeline (schema version 2)

Every income statement, balance sheet and cash flow item and ratio, per period (annual, half-year,
nine months, quarter; consolidated and unconsolidated), each either read from the filing, calculated
with its formula, or null. Staged so each step does only what it must, and writes what it did:

| Stage | Code | What it does |
|---|---|---|
| 1 Analyse | `src/pipeline/analyse.ts` | Text layer and image coverage of every page (milliseconds). A page is **native** or **scanned**; scanned pages get only their title strip OCR'd. |
| 2 Classify | `src/pipeline/classify.ts` | Keeps the statements and the notes the balance sheet cites; drops everything else, charts included. Every page records why. |
| 3 Subset | `src/pipeline/subset.ts` | Cuts the kept pages out: native pages as a small PDF, scanned pages as 300 dpi images. |
| 4 Tables | `python/docstage` | [Docling](https://github.com/docling-project/docling) (MIT) layout model and TableFormer recover each table's cell grid, from the text layer or by OCR. |
| 5 Normalize | `src/pipeline/normalize.ts`, `labels.ts` | Dates every value column from its header; maps printed labels to items with ordered, explainable rules. |
| 6 Validate | `src/pipeline/validate.ts`, `notes.ts` | Table arithmetic, accounting identities and cross-statement ties. Values that fail are dropped; OCR'd values must be confirmed. |
| 7 Derive | `src/financials/derive.ts` | Everything calculable from what was read, each with its formula. |

The rules are listed in [RULEBOOK.md](RULEBOOK.md), the output in [FINANCIALS.md](FINANCIALS.md).
The manual **Evaluate** workflow runs the pipeline on sample filings as a dry run (no identity token,
no API client) and scores it against hand-checked figures. Its last job compares filings with each
other: a figure printed in two filings (the current period of one, the comparative of the next)
must agree, and every difference is listed for review (`src/crosscheck.ts`).

The **Extract** workflow runs the same pipeline on claimed tasks and submits schema version 2
(`src/financials/task.ts`). Market-based items (P/E, market capitalisation, ...) are sent as
`source: "runtime"`: the server calculates them from the day's close.

## Document corpus

Every filing's extracted page text is kept, so a document is downloaded and OCR'd once. When the
parser improves, re-running the backlog re-reads saved text (seconds per filing) instead of
fetching PDFs and running OCR again (minutes per filing).

The text lives in **release assets**, not in git (it runs to gigabytes, and git history never
shrinks):

| Release | Assets | Contents |
|---|---|---|
| `corpus-YYYY-MM-DD` | `corpus-<run>-<attempt>-<n>.jsonl.gz` | Gzipped JSON Lines, one document per line, up to 250 per file |
| `corpus-index` | `index.json.gz` | Maps each document key to the asset that holds it (newest extraction wins) |

One line (one document):

```json
{
  "key": "<first 32 hex characters of sha256(sourceUrl)>",
  "corpusVersion": 1,
  "textVersion": 1,
  "sourceUrl": "https://financials.psx.com.pk/lib/DownloadPDF.php?id=272758",
  "symbol": "HPL",
  "extractedAt": "2026-09-23T10:12:00.000Z",
  "source": { "byteLength": 7433301, "sha256": "<64 hex characters>" },
  "document": {
    "kind": "pdf",
    "method": "pdftotext+tesseract",
    "contentType": "application/pdf",
    "confidence": 0.84,
    "pages": [
      { "pageNumber": 1, "method": "pdftotext", "confidence": 0.85, "text": "…" },
      { "pageNumber": 2, "method": "tesseract", "confidence": 0.71, "text": "…" }
    ]
  }
}
```

- `key` is the first 32 hex characters of the SHA-256 of `sourceUrl`.
- `method` per page: `pdftotext` (text layer), `tesseract` (OCR), `sparse` (almost no text and
  OCR found nothing better), or `xlsx` / `html` / `text` for other formats.
- `document.text` appears only when the full text isn't just the pages joined with form feeds
  (spreadsheets).
- `source` identifies the exact bytes downloaded, so a re-published filing is detectable.

Reading one document by hand:

```sh
gh release download corpus-index -p index.json.gz -R iali79/data-ingestion
zcat index.json.gz | jq '.entries["<key>"]'          # -> tag + asset
gh release download <tag> -p <asset> -R iali79/data-ingestion
zcat <asset> | grep '^{"key":"<key>"' | jq '.document.pages[].text'
```

**How it's written.** Extract jobs save the text of each document they process to a workflow
artifact. A separate **Publish corpus** job, after all of them finish, uploads those as assets on
the day's release, then updates the index. That job is the only one with repository write access
and never holds an ingest identity token. A publish that fails midway leaves unindexed assets,
which just means those documents get extracted again later.

**How it's read.** At start, each Extract job loads the index. For a claimed task whose document
is indexed at the current `textVersion`, the job downloads that asset (once per job) and uses the
saved text; otherwise it downloads the filing and extracts it. Any corpus problem falls back to a
fresh download, so the corpus can never fail a task. Dispatch Extract with `corpus: ignore` to
force fresh extraction.

`TEXT_VERSION` (in `src/extraction.ts`) must be bumped whenever the page text for the same
document would change (OCR resolution, tesseract mode, the sparse-page threshold); older text is
then ignored and re-extracted.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run scan   # secret scan -- also runs in CI
```

Local OCR needs `poppler-utils` and `tesseract-ocr` on the `PATH`; the extractor refuses to start
without them (set `INGEST_SKIP_TOOLCHAIN_CHECK=1` only for local API testing). The manual
**Self-test** workflow runs the full toolchain on public sample filings without contacting the API,
publishes their text to the corpus, and reads it back on a runner with no OCR tools.

## Configuration (workflow)

| Name | Kind | Purpose |
|---|---|---|
| `INGEST_API_URL` | secret | Base URL of the ingest API (a secret only so it is masked in public logs) |
| `INGEST_OIDC_AUDIENCE` | secret | Audience the OIDC token is requested for |

The corpus uses each job's built-in `GITHUB_TOKEN` (read-only in Extract, write only in Publish
corpus); it needs no configuration.
