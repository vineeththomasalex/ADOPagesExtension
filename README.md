# ADO Pages

A Chrome extension that renders HTML files in Azure DevOps repositories as live webpages.

## What it does

When viewing an `.html` file in an Azure DevOps Git repository, ADO Pages adds a **"View as Webpage ↗"** tab alongside the built-in Contents / History / Blame tabs. Clicking it opens the file rendered as a full webpage in a new tab — with CSS, images, and relative links resolved from the repo.

### Features

- **Live rendering** — HTML files are fetched via the AzDO Items API and displayed in an iframe, fully rendered with styles and assets.
- **CSS inlining** — `<link rel="stylesheet">` references and `@import` chains are recursively fetched and inlined.
- **Asset rewriting** — `src`, `href`, inline `style`, and CSS `url()` references are rewritten to point at the correct repo files.
- **Relative link support** — Links to other `.html` files in the repo open as rendered pages; other relative links resolve to API download URLs.
- **Branch/tag/commit aware** — Works on any branch, tag, or commit ref.
- **SPA-safe** — Handles Azure DevOps single-page-app navigation (pushState/replaceState).

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.

## How it works

The extension runs a content script on `https://dev.azure.com/*/_git/*` pages. It parses the current URL to extract the org, project, repo, file path, and version context, then:

1. **Tab mode** (default) — Injects a "View as Webpage" tab into the AzDO file viewer UI.
2. **Full-page mode** (`?view_as_webpage=true`) — Fetches the HTML file and all its dependencies via the AzDO REST API, rewrites asset URLs, and renders the result in a sandboxed iframe.

A declarative net request rule removes `X-Frame-Options` and `Content-Security-Policy` headers on `dev.azure.com` responses so the iframe can render correctly.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome extension manifest (MV3) |
| `content.js` | Content script — URL parsing, API calls, HTML/CSS processing, tab injection |
| `content.css` | Minimal styles for the injected tab |
| `rules.json` | Declarative net request rules (header removal) |

## Security

> **⚠️ Use at your own risk.** This extension has known security limitations. Only install it if you trust the HTML files in the Azure DevOps repositories you browse.

### Known concerns

1. **Unsandboxed iframe** — Rendered HTML pages run in an iframe without a `sandbox` attribute, meaning JavaScript in a repo HTML file executes with full `dev.azure.com` origin privileges. A malicious HTML file could access your AzDO session cookies, localStorage, and make authenticated API calls on your behalf (read/write repos, pipelines, work items, etc.).

2. **Global CSP/X-Frame-Options stripping** — The extension removes `Content-Security-Policy` and `X-Frame-Options` headers on *all* `dev.azure.com` page loads, not just when rendering HTML files. This weakens Azure DevOps's built-in XSS protections for your entire browsing session while the extension is enabled.

3. **No content sanitization** — HTML fetched from the repository is rendered as-is with no sanitization or script filtering.

### Recommendations

- Only enable this extension when you need it.
- Be cautious when viewing HTML files from repositories you don't control.
- Consider disabling the extension when working with untrusted repositories.

## License

This project is licensed under the [MIT License](LICENSE).
