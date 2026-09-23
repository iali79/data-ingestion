import { appendFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import {
  INDEX_ASSET,
  INDEX_NEXT_ASSET,
  INDEX_TAG,
  chunkLines,
  emptyIndex,
  loadIndex,
  mergeIndex,
  readSavedRecords,
  type IndexEntry,
} from './corpus.js';
import { GithubReleases } from './github.js';

/**
 * Publish job: gathers the corpus records the extract jobs saved, uploads them as assets on
 * today's `corpus-YYYY-MM-DD` release, then points the index at them.
 *
 * Runs in its own job, the only one with `contents: write`, and that job never holds an ingest
 * identity token -- so repository write access and API access never share a runner.
 *
 * Order matters for failure: record assets go up first, the index last. A publish that dies
 * midway leaves unindexed assets (harmless: those filings are simply extracted again later),
 * never an index entry pointing at nothing.
 */
const MAX_CHUNK_BYTES = 150 * 1024 * 1024; // uncompressed; roughly 25 MB per asset once gzipped
const MAX_CHUNK_RECORDS = 250;

async function main(): Promise<void> {
  const inDir = requireEnv('CORPUS_IN_DIR');
  const repository = requireEnv('GITHUB_REPOSITORY');
  const token = requireEnv('GITHUB_TOKEN');
  const run = `${requireEnv('GITHUB_RUN_ID')}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  if (!/^\d+-\d+$/u.test(run)) throw new Error('unexpected run id');

  const files = await readdir(inDir).catch(() => [] as string[]);
  const { records, invalid } = await readSavedRecords(inDir, files);
  if (records.length === 0) {
    await report(`nothing to publish (invalid=${invalid})`);
    return;
  }

  const releases = new GithubReleases(repository, token);
  const tag = `corpus-${new Date().toISOString().slice(0, 10)}`;
  const release = await releases.ensureRelease(
    tag,
    `Document corpus ${tag.slice('corpus-'.length)}`,
    'Page text extracted from public PSX filings. Machine-generated data, not a software release. See the README.',
  );
  const existing = await releases.listAssets(release.id);

  const ordered = [...records].sort((a, b) => a.key.localeCompare(b.key));
  const chunks = chunkLines(
    ordered.map((record) => JSON.stringify(record)),
    MAX_CHUNK_BYTES,
    MAX_CHUNK_RECORDS,
  );
  const additions: Array<[string, IndexEntry]> = [];
  let offset = 0;
  for (const [n, lines] of chunks.entries()) {
    const name = `corpus-${run}-${n + 1}.jsonl.gz`;
    const stale = existing.find((asset) => asset.name === name);
    if (stale) await releases.deleteAsset(stale.id);
    const asset = await releases.uploadAsset(release, name, gzipSync(`${lines.join('\n')}\n`), 'application/gzip');
    for (const record of ordered.slice(offset, offset + lines.length)) {
      additions.push([
        record.key,
        { tag, asset: name, assetId: asset.id, textVersion: record.textVersion, extractedAt: record.extractedAt, symbol: record.symbol },
      ]);
    }
    offset += lines.length;
  }

  const indexRelease = await releases.ensureRelease(
    INDEX_TAG,
    'Document corpus index',
    'Maps each document to the release asset holding its text. Rewritten after every publish.',
  );
  const loaded = await loadIndex(releases);
  const index = mergeIndex(loaded?.index ?? emptyIndex(), additions);
  const indexAssets = loaded?.assets ?? [];
  // Upload beside the old index, then swap: readers see either the old or the new index.
  for (const leftover of indexAssets.filter((asset) => asset.name === INDEX_NEXT_ASSET)) await releases.deleteAsset(leftover.id);
  const next = await releases.uploadAsset(indexRelease, INDEX_NEXT_ASSET, gzipSync(JSON.stringify(index)), 'application/gzip');
  for (const old of indexAssets.filter((asset) => asset.name === INDEX_ASSET)) await releases.deleteAsset(old.id);
  await releases.renameAsset(next.id, INDEX_ASSET);

  await report(
    `published ${records.length} documents in ${chunks.length} asset(s) on ${tag}; index now holds ${Object.keys(index.entries).length} (invalid=${invalid})`,
  );
}

async function report(line: string): Promise<void> {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Document corpus\n\n${line}\n`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'publish failed');
  process.exit(1);
});
