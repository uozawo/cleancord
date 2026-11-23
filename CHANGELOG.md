# Changelog

All notable changes to Cleancord are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-23

First public release.

### Features
- Browse servers, channels, threads, forum posts, DMs and group DMs in a Discord-style feed.
- Discord search (content, author, mentions, attachments, dates, pinned, author type) with "load all results".
- Quick filters on loaded messages, including regex and an inverse mode.
- Bulk delete, edit (find and replace with preview), remove attachments and remove reactions.
- Purge a DM, several channels, or a whole server: search-based with a final pass, or a full-history scan; archived threads are unarchived and re-archived automatically.
- Export to HTML, JSON, CSV or text with offline media, 10 presets, artist mode, and streaming to a folder or ZIP.
- Browse Discord's data package offline and clean up every message you ever sent.
- Workspaces, pausable and resumable tasks, mention analytics, dark, light and midnight themes.

### Safety
- Default delay between deletions and edits is 2 seconds (with a random spread).
- Discord-only Content Security Policy; the session token stays in memory.
