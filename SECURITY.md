# Security

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) rather than opening an issue.

This repository is public by design and holds no credentials. The extraction workflow
authenticates with a per-run GitHub OIDC token, and pull-request workflows are never granted one.

The only job with repository write access is **Publish corpus**, which uploads extracted page text
of public filings as release assets. It runs no install scripts, receives the write token in a
single step, and never holds an ingest identity token.
