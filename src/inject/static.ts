import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the widget block into an HTML file.
 *
 * `envGuarded` picks the Vite form from pinsay-init.md: values come from %VITE_POINTER_*%
 * placeholders instead of being baked in, so one index.html serves dev, staging and production and
 * the widget simply does not mount when VITE_PINSAY_SERVER is empty (a build that must ship
 * without the widget leaves it unset — there is no separate on/off flag). Hardcoding the server
 * (the plain form) would pin every build to whichever server happened to run `init`.
 */
export async function injectStatic(
    cwd: string,
    htmlPath: string | undefined,
    cfg: {
        server: string;
        key: string;
        environment: string;
        envGuarded?: boolean;
        /**
         * Pin the widget to one immutable build, with Subresource Integrity.
         *
         * Unpinned, `/widget.js` is whatever the server is serving today — convenient, and the
         * right default for most installs. Pinned, the page loads exactly the bytes it was tested
         * against and the browser refuses anything else, which is what a site needs when a
         * third-party script sits on a page handling real users.
         */
        pin?: { version: string; integrity: string } | null;
        /** Every environment this install covers. More than one implies the runtime-resolving form. */
        environments?: string[];
        /**
         * The caller asked for a specific environment (`--environment`), so write it into the
         * markup and let it override the server's origin-based resolution.
         */
        environmentPinned?: boolean;
    },
): Promise<string> {
    const p = htmlPath || join(cwd, 'index.html');
    let content = await fs.readFile(p, 'utf8').catch(() => '');
    if (!content) throw new Error(`HTML file not found at ${p}`);
    
    // A pinned loader sets integrity/crossOrigin as PROPERTIES on the created element rather than
    // writing an attribute string. Same effect, and it keeps the snippet working on a host page
    // that runs a strict Content-Security-Policy.
    const pinnedSrc = cfg.pin ? `?v=${cfg.pin.version}` : '';
    const pinnedProps = cfg.pin
        ? `
    s.integrity = '${cfg.pin.integrity}';
    s.crossOrigin = 'anonymous';`
        : '';
    /** The same pin, as attributes, for the forms that write a <script> tag rather than build one. */
    const pinnedAttrs = cfg.pin
        ? ` integrity="${cfg.pin.integrity}" crossorigin="anonymous"`
        : '';

    // No `environment` attribute unless the install is deliberately pinned to one.
    //
    // Absent, the server resolves it per request from the page's origin against the URLs registered
    // for the project — so the same built file reports `staging` on staging and `production` on
    // production, and changing a URL in the dashboard needs no rebuild. Writing a value here is
    // what made every deployment of one file report the same environment forever.
    const envAttr = cfg.environmentPinned ? ` environment="${cfg.environment}"` : '';

    const block = cfg.envGuarded
        ? `<!-- pinsay-feedback:start -->
<script>
  if (
    '%VITE_PINSAY_SERVER%'.indexOf('http') === 0 &&
    '%VITE_PINSAY_PROJECT%' !== ''
  ) {
    var s = document.createElement('script');
    s.src = '%VITE_PINSAY_SERVER%/widget.js${pinnedSrc}';${pinnedProps}
    s.defer = true;
    document.head.appendChild(s);
    // Deferred until the body exists. Injected just above </body> this is already true, but the
    // block gets copied into other files by hand, and inside <head> document.body is null —
    // "Cannot read properties of null (reading 'appendChild')", and nothing mounts.
    var mount = function () {
      if (document.querySelector('pinsay-feedback')) return;
      var el = document.createElement('pinsay-feedback');
      el.setAttribute('project', '%VITE_PINSAY_PROJECT%');
      el.setAttribute('server', '%VITE_PINSAY_SERVER%');
      document.body.appendChild(el);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
</script>
<!-- pinsay-feedback:end -->`
        : `<!-- pinsay-feedback:start -->
<script${pinnedAttrs} src="${cfg.server}/widget.js${pinnedSrc}" defer></script>
<pinsay-feedback project="${cfg.key}" server="${cfg.server}"${envAttr}></pinsay-feedback>
<!-- pinsay-feedback:end -->`;

    const re = /<!-- pinsay-feedback:start -->[\s\S]*?<!-- pinsay-feedback:end -->/;
    if (re.test(content)) {
        content = content.replace(re, block);
    } else if (content.toLowerCase().includes('</body>')) {
        content = content.replace(/(<\/body>)/i, `${block}\n$1`);
    } else {
        content += `\n${block}`;
    }
    
    await fs.writeFile(p, content, 'utf8');
    return p;
}
