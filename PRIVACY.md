# Privacy policy

_Last updated: November 23, 2026_

Cleancord is a browser extension that runs entirely on your computer. **The developers of Cleancord do not collect, receive, store or sell any data.** There is no Cleancord server, no analytics, no crash reporting and no tracking.

## What Cleancord handles, and where it stays

| Data | Why | Where it is kept | How to remove it |
| --- | --- | --- | --- |
| Your Discord session token | To call Discord's API as you | In memory only (`chrome.storage.session`). Wiped when the browser closes. Websites and content scripts can't read it. | Account menu → **Forget session**, or close the browser |
| Messages and conversations you load | So you can browse, filter, export and resume tasks | In your browser's IndexedDB, on this computer | **Saved** tab → remove, or delete the workspace |
| Settings and export presets | Remember your choices | `chrome.storage.local`, on this computer | Remove the extension |
| Files you export | You asked for them | Wherever you save them | Delete the files |
| A Discord data package you open | To browse it | Read from the file you pick; parsed messages are stored in your workspace if you open a conversation | Same as messages above |

## Who Cleancord talks to

Only Discord:

- `discord.com` for Discord's API, using your session.
- Discord's media servers (`cdn.discordapp.com`, `media.discordapp.net` and other `*.discordapp.net` hosts) to show and download images and files. These requests never include your token.

The extension's Content Security Policy (in [`extension/manifest.json`](extension/manifest.json)) blocks connections to every other address, so the browser itself enforces this.

## Permissions

| Permission | Used for |
| --- | --- |
| `storage`, `unlimitedStorage` | Settings and your local workspace |
| `webRequest` | Reading the `Authorization` header of requests **your own Discord tab** makes to `discord.com/api`, so you don't have to paste a token |
| Access to `discord.com` and Discord's media hosts | Calling the API, downloading media, and showing the launcher button on discord.com |

Cleancord does not request access to your tabs, history, cookies, or any other website.

## Changes

Changes to this policy are tracked in this file's history on GitHub.
