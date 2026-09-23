/**
 * Every failure a task can end in. The code is sent back to the ingest API as-is, so this list
 * must stay in step with the `error.code` enum in CONTRACT.md.
 */
export type ExtractionErrorCode =
  | 'download_failed'
  | 'document_too_large'
  | 'unsupported_type'
  | 'extract_failed'
  | 'host_not_allowed';

export class DocumentExtractionError extends Error {
  constructor(
    public readonly code: ExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}
