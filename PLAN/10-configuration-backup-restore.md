# Configuration backup and restore plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Provide deliberate, authenticated backup and restore workflows while making the secret-bearing nature of configuration exports impossible to overlook.

## Export modes

1. **Redacted template** is safe for troubleshooting and version control. It includes settings, tasks, feeds, and `configured` flags but omits access tokens and editor passwords.
2. **Full backup** contains the complete canonical configuration, including secrets. Require re-entry of the editor password and a separate confirmation immediately before download.

Both exports include a schema version, application version, export timestamp, and checksum. Responses use `Cache-Control: no-store`, attachment disposition, and strict content type.

## Restore workflow

1. Upload into memory with a conservative body-size limit; never place the unvalidated upload in the output directory.
2. Parse and migrate only explicitly supported schema versions.
3. Run complete normalization and cross-reference validation.
4. Show a secret-safe change summary: settings changed, tasks added/changed/removed, and feeds changed.
5. Require a second authenticated mutation to apply the staged restore.
6. Persist with the existing sibling-temporary-file and atomic-rename path, then hot-apply only after validation succeeds.
7. If hot-apply fails, leave the prior active configuration and capture services intact and report a redacted error.

## Implementation details

Use short-lived opaque restore IDs held in memory, bound to the authenticated editor session where practical, and expire them quickly. Never put backup contents, tokens, or passwords in URLs, logs, browser storage, previews, or error responses. Do not bundle captured images or custom CSS in the first release; document volume-level backup for those files.

## Verification

- Round-trip full and redacted exports through supported schema versions.
- Test wrong passwords, missing mutation headers, oversized files, malformed JSON, invalid references, and expired staged restores.
- Test redacted restoration semantics explicitly: omitted secrets must either retain current values by user choice or block a clean restore; never silently erase or fabricate them.
- Test atomic persistence and rollback behavior during write and hot-apply failures.
- Assert response headers and that secrets never appear in logs or change summaries.

## Scope and warning

Do not claim encryption for a downloaded full backup; transport security and storage are the operator's responsibility. Recommend volume snapshots for complete disaster recovery, because the data volume also contains last-good images and optional CSS files.
