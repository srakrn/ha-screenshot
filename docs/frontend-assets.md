# Frontend assets

The gallery, first-run setup, and administration editor use same-origin assets
so they remain functional on an isolated LAN. Bootstrap is vendored as three
files in `public/vendor/bootstrap/`; the full npm package is intentionally not a
runtime dependency.

## Current version and provenance

- Bootstrap version: 5.3.8
- Upstream package: `bootstrap@5.3.8` from the npm registry
- `bootstrap.min.css` SHA-256: `d85327d99c7a3ee1f9b5d0500d1370acea3ad2db39c163c2f51f232baedbdede`
- `bootstrap.bundle.min.js` SHA-256: `e4fd49181388c48ec5040bd3fe66f57c29c8e67fcd8502b3354b96ec7ab47cc7`
- `LICENSE` SHA-256: `4620c84ad5ce8602ff65640ed6b7c8b78ebb9e036584f0ebc1ccc88206a4bb51`

The JavaScript bundle includes Popper. Both distribution files retain their
upstream version and license banners, and the complete Bootstrap MIT license is
stored beside them.

## Updating Bootstrap

1. Choose and review a specific Bootstrap release, including its security notes.
2. Download the official npm package and verify its registry integrity value,
   distribution-file checksums, version banners, and license before copying it.
3. Replace only `bootstrap.min.css`, `bootstrap.bundle.min.js`, and `LICENSE` in
   `public/vendor/bootstrap/`.
4. Update the version and SHA-256 values in this document. Do not add Bootstrap
   to runtime dependencies or introduce a frontend build step solely for these
   files.
5. Run `npm test`, then exercise the gallery, setup flow, editor dialogs,
   validation, and capture controls with external networking blocked. Check both
   narrow mobile and desktop layouts and confirm the browser reports no CSP
   violations.
6. Build the production image and confirm it contains the three vendored files,
   not the full Bootstrap package tree.
