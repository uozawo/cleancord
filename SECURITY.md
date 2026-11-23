# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead:
**Security** tab → **Report a vulnerability**. You'll get a reply as soon as possible, and a fix will be
released before details are made public.

Never include a real Discord token in a report.

## Supported versions

Only the latest release receives fixes.

## Security model

- **No remote code.** Every script ships in `extension/` and the CSP is `script-src 'self'`. Nothing is downloaded or evaluated at runtime.
- **Discord only.** The CSP's `connect-src` allows only `discord.com` and Discord's media hosts.
- **The token stays local.** It is held in `chrome.storage.session` (memory, trusted extension contexts only), sent only to `discord.com/api`, and never to media hosts.
- **Untrusted content is escaped.** Message text, names, embeds and file names are escaped before they reach the DOM, and URLs are restricted to `http(s)`. Exported HTML contains no scripts and carries its own CSP (`script-src 'none'`).
- **No third-party code** in the extension. Development tools (`acorn`, `fake-indexeddb`) are used for tests only and are not shipped.

## Fake copies

Tools that handle Discord sessions are a common disguise for token stealers. Only install Cleancord from this
repository's **Releases** page, and check the download against `SHA256SUMS.txt`.
