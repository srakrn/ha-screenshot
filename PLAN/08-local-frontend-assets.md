# Local frontend assets plan

## Status

Implemented. Bootstrap 5.3.8 CSS, bundled JavaScript, and its MIT license are
vendored in `public/vendor/bootstrap/`; the application has no runtime Bootstrap
package dependency or external frontend asset source.

## Goal

Keep the gallery and administration editor fully usable on isolated LANs without depending on jsDelivr or any other external service.

## Implementation

1. Vendor the exact pinned Bootstrap CSS and JavaScript files currently referenced by the pages, including their license notice.
2. Store browser assets under a clearly named `public/vendor/bootstrap/` directory and serve them from existing static routes.
3. Update gallery and editor HTML to use same-origin asset paths.
4. Tighten the page Content Security Policy by removing jsDelivr from `style-src` and `script-src`.
5. Ensure the Docker build copies the vendor files and that no runtime package installation or network download is required.
6. Document the update procedure: choose a version, verify upstream checksums and license, replace files, update attribution, and run visual tests.

## Verification

- Test that every HTML asset reference is same-origin and resolves successfully.
- Run the UI with external networking blocked and confirm gallery, setup, editor dialogs, validation, and capture controls work.
- Check both narrow mobile and desktop layouts.
- Verify CSP has no external script/style source and pages produce no CSP violations.
- Validate that the production Docker image includes only the required Bootstrap distribution files, not an entire package tree.

## Security and maintenance

Do not add a frontend build pipeline solely for vendoring these files. Keep the exact version visible and review Bootstrap security releases deliberately. Preserve Subresource Integrity checks in project history if useful for verifying downloaded source files, although same-origin runtime tags do not require SRI.
