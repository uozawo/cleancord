# Contributing to Cleancord

Thanks for helping! Bug reports, fixes and ideas are all welcome.

## Ground rules

These keep Cleancord trustworthy, so pull requests that break them can't be merged:

1. **No dependencies in `extension/`.** It's plain JavaScript (ES modules) and CSS with no build step, so anyone can read exactly what runs.
2. **No new network destinations.** The CSP allows only Discord. No analytics, telemetry, CDNs or update checks.
3. **No remote or generated code.** No `eval`, no `new Function`, no loading scripts from anywhere.
4. **No personal data** in code, tests, fixtures or screenshots. Use the fake Discord API in `tests/mock-discord.js`.

## Project layout

```
extension/            the extension (load this folder in Chrome)
  manifest.json       permissions and Content Security Policy
  background.js       picks up the session from your Discord tab; opens the app
  content.js          the launcher button on discord.com
  app.html            the app page
  src/api.js          Discord REST client (rate limits, retries, pause/cancel)
  src/purge.js        purge engine
  src/bulk.js         bulk delete / edit / attachments / reactions
  src/export/         exporter, streaming ZIP writer, file and folder output
  src/package/        data-package reader
  src/render.js, src/markdown.js, src/message.css   Discord-style rendering (also used by HTML exports)
  src/ui/             sidebar, feed, dialogs, status panel
tests/                fake Discord API, Node tests, browser end-to-end test
scripts/              syntax check, reproducible release build, icon generator (make-icons.py)
docs/media/           README images
```

## Development

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
2. After editing, click the reload icon on the Cleancord card and reload the Cleancord tab.

## Tests

```bash
npm ci            # dev tools only: acorn + fake-indexeddb
npm run lint      # parses every script and checks the manifest/CSP
npm test          # logic tests against a fake Discord API (no network, no account needed)
npm run build     # writes dist/cleancord-v<version>.zip and SHA256SUMS.txt
```

The browser end-to-end test loads the real extension in Chrome for Testing:

```bash
pip install playwright pillow
CHROME_PATH=/path/to/chrome-for-testing python3 tests/browser_test.py
```

It also runs on GitHub Actions (**Actions → Browser end-to-end → Run workflow**).

## Releasing

1. Bump `version` in `extension/manifest.json` and `package.json`.
2. Add a section to `CHANGELOG.md`.
3. Tag and push: `git tag v1.2.3 && git push --tags`. The Release workflow tests, builds and publishes the zip with its checksum.
