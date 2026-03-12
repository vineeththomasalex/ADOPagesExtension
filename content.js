/* global DOMParser, URLSearchParams */
(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────

  const TAB_ATTR = 'data-ado-pages-tab';
  const API_VERSION = '7.0';

  // ─── Context: parse org / project / repo / path / version from current URL ───

  function parseContext() {
    const url = new URL(location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    const gitIdx = parts.indexOf('_git');
    if (gitIdx < 0) return null;

    const org     = parts[0];
    const project = parts.slice(1, gitIdx).map(decodeURIComponent).join('/');
    const repo    = decodeURIComponent(parts[gitIdx + 1] || '');
    if (!org || !project || !repo) return null;

    const filePath = url.searchParams.get('path');
    if (!filePath || !/\.html?$/i.test(filePath)) return null;

    // AzDO version param: GBmain (branch), GC<sha> (commit), GT<name> (tag).
    const vp = url.searchParams.get('version') || '';
    let versionType = vp.startsWith('GC') ? 'commit'
                    : vp.startsWith('GT') ? 'tag'
                    : vp.startsWith('GB') ? 'branch'
                    : null;
    let version = vp.slice(2) || null;

    // When the URL has no version (user is on the default branch), AzDO omits
    // the param entirely. Fall back to the Monaco editor's data-uri attribute,
    // which always contains the full version string, e.g.:
    //   inmemory://model/git/{repoId}/GBmain/path/to/file.html
    if (!versionType) {
      const dataUri = document.querySelector('[data-uri*="inmemory://model/git/"]')
                               ?.getAttribute('data-uri') || '';
      const segs    = dataUri.split('/');
      const gitPos  = segs.indexOf('git');
      const vp2     = gitPos >= 0 ? (segs[gitPos + 2] || '') : '';
      if (vp2.startsWith('GB') || vp2.startsWith('GC') || vp2.startsWith('GT')) {
        versionType = vp2.startsWith('GC') ? 'commit' : vp2.startsWith('GT') ? 'tag' : 'branch';
        version     = vp2.slice(2);
      }
    }

    return { org, project, repo, filePath, versionType, version };
  }

  // ─── Items API URL builder ────────────────────────────────────────────────────

  function itemsUrl(ctx, filePath) {
    const base = [
      'https://dev.azure.com',
      encodeURIComponent(ctx.org),
      encodeURIComponent(ctx.project),
      '_apis/git/repositories',
      encodeURIComponent(ctx.repo),
      'items',
    ].join('/');

    const params = new URLSearchParams({
      'path':        filePath,
      '$format':     'octetStream',
      'api-version': API_VERSION,
    });
    if (ctx.versionType) {
      params.set('versionDescriptor.versionType', ctx.versionType);
      params.set('versionDescriptor.version',     ctx.version);
    }
    return `${base}?${params}`;
  }

  // Builds an AzDO file-browser URL for an in-repo HTML file, with view_as_webpage=true.
  // This is what <a href> links to other HTML files in the repo should point to.
  function browseUrl(ctx, filePath) {
    const params = new URLSearchParams({ path: filePath, view_as_webpage: 'true' });
    if (ctx.versionType) {
      const prefix = ctx.versionType === 'commit' ? 'GC'
                   : ctx.versionType === 'tag'    ? 'GT'
                   :                                'GB';
      params.set('version', prefix + ctx.version);
    }
    return `https://dev.azure.com/${encodeURIComponent(ctx.org)}/${encodeURIComponent(ctx.project)}/_git/${encodeURIComponent(ctx.repo)}?${params}`;
  }

  // ─── Path resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve a potentially relative href found in a repo file.
   * Returns an absolute repo path (starting with '/'), or null if the href
   * is an external / data / anchor URL that should be left untouched.
   */
  function resolvePath(href, fromFilePath) {
    if (!href) return null;
    // Strip query/hash before resolution (they have no meaning for repo paths)
    const stripped = href.split('?')[0].split('#')[0].trim();
    if (!stripped) return null;
    // Leave external, data, and protocol-relative URLs alone
    if (/^(https?:|data:|\/\/|mailto:|#)/i.test(stripped)) return null;

    if (stripped.startsWith('/')) {
      // Root-relative: already an absolute repo path
      return stripped;
    }

    // Relative: resolve against the directory of the current file
    const dir = fromFilePath.substring(0, fromFilePath.lastIndexOf('/'));
    const segments = (dir + '/' + stripped).split('/');
    const out = [];
    for (const seg of segments) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { out.pop(); } else { out.push(seg); }
    }
    return '/' + out.join('/');
  }

  // ─── CSS processor ───────────────────────────────────────────────────────────

  // Matches:  url('path')  url("path")  url(path)
  const CSS_URL_RE = /url\(\s*(['"]?)([^'"\)\s]+)\1\s*\)/gi;

  // Matches:  @import 'path'  @import "path"
  //           @import url('path')  @import url("path")  @import url(path)
  // Optionally followed by a media query and/or semicolon — consumed but dropped.
  const CSS_IMPORT_RE = /@import\s+(?:url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)|['"]([^'"]+)['"])[^;]*;?/gi;

  function rewriteCssUrls(cssText, cssFilePath, ctx) {
    return cssText.replace(CSS_URL_RE, (match, _q, href) => {
      const resolved = resolvePath(href, cssFilePath);
      return resolved ? `url('${itemsUrl(ctx, resolved)}')` : match;
    });
  }

  async function fetchAndRewriteCss(repoPath, ctx, visited = new Set()) {
    if (visited.has(repoPath)) return ''; // circular import guard
    visited.add(repoPath);

    let text;
    try {
      const resp = await fetch(itemsUrl(ctx, repoPath), { credentials: 'include' });
      if (!resp.ok) return `/* HTTP ${resp.status} loading ${repoPath} */`;
      text = await resp.text();
    } catch (e) {
      return `/* Error loading ${repoPath}: ${e.message} */`;
    }

    // 1. Rewrite url() references
    text = rewriteCssUrls(text, repoPath, ctx);

    // 2. Collect @import statements (after url() rewrite so we don't double-process)
    const imports = [];
    CSS_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = CSS_IMPORT_RE.exec(text)) !== null) {
      imports.push({ full: m[0], idx: m.index, href: (m[1] || m[2]) });
    }

    if (imports.length === 0) return text;

    // 3. Fetch all @imported sheets in parallel
    const inlined = await Promise.all(
      imports.map(({ href }) => {
        const resolved = resolvePath(href, repoPath);
        return resolved
          ? fetchAndRewriteCss(resolved, ctx, visited)
          : Promise.resolve(`/* Cannot resolve import: ${href} */`);
      })
    );

    // 4. Splice imported CSS in (reverse order to keep string indices valid)
    for (let i = imports.length - 1; i >= 0; i--) {
      const { full, idx } = imports[i];
      text = text.slice(0, idx) + inlined[i] + text.slice(idx + full.length);
    }

    return text;
  }

  // ─── HTML processor ──────────────────────────────────────────────────────────

  async function buildPage(ctx) {
    const resp = await fetch(itemsUrl(ctx, ctx.filePath), { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — could not fetch ${ctx.filePath}`);
    const rawHtml = await resp.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Remove <base> — it would break all our rewritten paths
    doc.querySelectorAll('base').forEach(el => el.remove());

    // --- Async: fetch and inline every <link rel="stylesheet"> ---
    const linkEls = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
    const cssJobs = linkEls.map(el => {
      const resolved = resolvePath(el.getAttribute('href'), ctx.filePath);
      return resolved
        ? fetchAndRewriteCss(resolved, ctx)
        : Promise.resolve(null);
    });

    // --- Sync rewrites (no fetching needed) ---

    // Rewrite src attributes (<img>, <script>, <source>, <video>, <audio>, etc.)
    doc.querySelectorAll('[src]').forEach(el => {
      const resolved = resolvePath(el.getAttribute('src'), ctx.filePath);
      if (resolved) el.setAttribute('src', itemsUrl(ctx, resolved));
    });

    // Rewrite href on non-stylesheet <link> elements (icons, manifests, etc.)
    doc.querySelectorAll('link[href]:not([rel~="stylesheet"])').forEach(el => {
      const resolved = resolvePath(el.getAttribute('href'), ctx.filePath);
      if (resolved) el.setAttribute('href', itemsUrl(ctx, resolved));
    });

    // Rewrite <a href> links.
    // - Relative links to .html/.htm files → AzDO viewer URL with view_as_webpage=true
    //   on the same branch, opening in a new tab.
    // - Other relative links (pdf, zip, etc.) → Items API URL so the browser can fetch them.
    // - External / anchor / mailto links → left untouched.
    doc.querySelectorAll('a[href]').forEach(el => {
      const resolved = resolvePath(el.getAttribute('href'), ctx.filePath);
      if (!resolved) return;
      if (/\.html?$/i.test(resolved)) {
        el.setAttribute('href', browseUrl(ctx, resolved));
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      } else {
        el.setAttribute('href', itemsUrl(ctx, resolved));
      }
    });

    // Rewrite url() inside inline style attributes
    doc.querySelectorAll('[style]').forEach(el => {
      el.setAttribute(
        'style',
        rewriteCssUrls(el.getAttribute('style'), ctx.filePath, ctx)
      );
    });

    // Rewrite url() inside <style> blocks
    doc.querySelectorAll('style').forEach(el => {
      el.textContent = rewriteCssUrls(el.textContent, ctx.filePath, ctx);
    });

    // --- Await CSS jobs then replace <link> with <style> ---
    const cssResults = await Promise.all(cssJobs);
    linkEls.forEach((el, i) => {
      if (cssResults[i] === null) return;
      const style = doc.createElement('style');
      style.textContent = cssResults[i];
      el.replaceWith(style);
    });

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  // ─── UI ───────────────────────────────────────────────────────────────────────

  function findTabList() {
    for (const tl of document.querySelectorAll('[role="tablist"]')) {
      if (/Contents|History|Blame/i.test(tl.textContent)) return tl;
    }
    return null;
  }

  function injectTab(ctx) {
    const tablist = findTabList();
    if (!tablist || tablist.querySelector(`[${TAB_ATTR}]`)) return;

    const tab = document.createElement('div');
    tab.setAttribute(TAB_ATTR, 'true');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('tabindex', '-1');
    tab.setAttribute('title', 'Open this HTML file rendered as a webpage in a new tab');
    tab.className = 'bolt-tab focus-treatment flex-noshrink ado-pages-tab';

    const inner = document.createElement('span');
    inner.className = 'bolt-tab-inner-container';
    const label = document.createElement('span');
    label.className = 'bolt-tab-text';
    label.setAttribute('data-content', 'View as Webpage ↗');
    label.textContent = 'View as Webpage ↗';
    inner.appendChild(label);
    tab.appendChild(inner);

    tab.addEventListener('click', () => window.open(buildFullPageUrl(), '_blank'));
    tablist.appendChild(tab);
  }

  // ─── Full-page mode ───────────────────────────────────────────────────────────

  function isFullPageMode() {
    return new URL(location.href).searchParams.get('view_as_webpage') === 'true';
  }

  function buildFullPageUrl() {
    const url = new URL(location.href);
    url.searchParams.set('view_as_webpage', 'true');
    return url.toString();
  }

  async function runFullPageMode(ctx) {
    // Take over the page: clear AzDO chrome, show only the rendered iframe.
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;padding:0;overflow:hidden;background:#fff;';

    const loading = document.createElement('div');
    loading.className = 'ado-pages-loading';
    loading.style.height = '100vh';
    loading.innerHTML = '<span>Loading\u2026</span>';
    document.body.appendChild(loading);

    try {
      const html = await buildPage(ctx);
      document.body.innerHTML = '';
      const iframe = document.createElement('iframe');
      // No sandbox — srcdoc iframes without sandbox run with the parent page's origin
// (dev.azure.com), so document.cookie, localStorage, and all JS APIs work normally.
// Security is acceptable: users already have read access to the repo content.
      iframe.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:none;';
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
    } catch (err) {
      document.body.innerHTML = `
        <div class="ado-pages-error" style="padding:32px">
          <strong>Failed to load webpage</strong>
          <p>${escHtml(err.message)}</p>
        </div>`;
    }
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Initialization & SPA navigation handling ─────────────────────────────────

  let bodyObserver    = null;
  let tablistObserver = null;

  // Phase 2: watch only the tablist's direct children. When AzDO removes our tab
  // (e.g. during a tab-switch re-render), re-inject immediately with no debounce.
  function observeTablist(tablist, ctx) {
    if (tablistObserver) tablistObserver.disconnect();
    tablistObserver = new MutationObserver(() => {
      if (!tablist.isConnected) {
        tablistObserver.disconnect();
        tablistObserver = null;
        waitForTablist(ctx);
        return;
      }
      if (!tablist.querySelector(`[${TAB_ATTR}]`)) {
        injectTab(ctx);
      }
    });
    tablistObserver.observe(tablist, { childList: true });
  }

  // Try to inject immediately; returns true if the tablist was found.
  function tryInject(ctx) {
    const tablist = findTabList();
    if (!tablist) return false;
    injectTab(ctx);
    observeTablist(tablist, ctx);
    return true;
  }

  // Phase 1: watch body (subtree) only until the tablist appears, then hand off
  // to the targeted tablist observer and disconnect the broad body observer.
  function waitForTablist(ctx) {
    if (tryInject(ctx)) return;
    if (bodyObserver) bodyObserver.disconnect();
    bodyObserver = new MutationObserver(() => {
      if (tryInject(ctx)) {
        bodyObserver.disconnect();
        bodyObserver = null;
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function onUrlChange() {
    document.querySelector(`[${TAB_ATTR}]`)?.remove();
    if (tablistObserver) { tablistObserver.disconnect(); tablistObserver = null; }
    if (bodyObserver)    { bodyObserver.disconnect();    bodyObserver    = null; }
    const ctx = parseContext();
    if (ctx) waitForTablist(ctx);
  }

  // Intercept SPA navigation (AzDO uses pushState/replaceState, not full reloads).
  const _push    = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = (...a) => { _push(...a);    onUrlChange(); };
  history.replaceState = (...a) => { _replace(...a); onUrlChange(); };
  window.addEventListener('popstate', onUrlChange);

  const initCtx = parseContext();
  if (initCtx && isFullPageMode()) {
    runFullPageMode(initCtx);
  } else if (initCtx) {
    waitForTablist(initCtx);
  }

}());
