import { api } from './api.js';
import { isOutage } from './errors.js';

/**
 * Resolves the server's product name and app URL.
 *
 * White-label rule (01-OVERVIEW, R1-02 §C): the CLI NEVER falls back to a literal product name.
 * Every human-readable string that names the product comes from here, so a server that cannot be
 * reached — or that answers without a productName — is a hard exit 1. Printing "PinSay" to a
 * customer who rebranded is the exact failure this rule exists to prevent, and a fallback makes it
 * silent.
 */
export async function getBranding(server: string): Promise<{
    productName: string,
    urls: { app: string },
    /**
     * The browser extensions' store listings / the manual-install zip — a super-admin setting
     * (`GET /api/branding` → `extension.storeUrl`/`extension.zipUrl`/`extension.storeUrls`), never
     * hard-coded here. Both may be empty when the admin has not configured them yet. `storeUrls`
     * holds the Chrome Web Store / Edge Add-ons / Firefox Add-ons listings; servers that do not
     * send it fall back to `chrome: storeUrl` with Edge and Firefox empty.
     */
    extension: {
        storeUrl: string,
        zipUrl: string,
        storeUrls: { chrome: string, edge: string, firefox: string },
    },
}> {
    let branding: {
        productName?: string,
        urls?: { app?: string },
        extension?: {
            storeUrl?: string,
            zipUrl?: string,
            storeUrls?: { chrome?: string, edge?: string, firefox?: string },
        },
    };
    try {
        branding = await api(server, '/api/branding');
    } catch (err) {
        if (isOutage(err)) throw err;
        console.error(`Could not reach ${server} — check the URL.`);
        process.exit(1);
    }

    if (!branding?.productName) {
        console.error(`${server} returned no product name — cannot continue without branding.`);
        process.exit(1);
    }

    const storeUrl = branding.extension?.storeUrl ?? '';
    const rawStoreUrls = branding.extension?.storeUrls;

    return {
        productName: branding.productName,
        urls: { app: branding.urls?.app ?? '' },
        extension: {
            storeUrl,
            zipUrl: branding.extension?.zipUrl ?? '',
            storeUrls: rawStoreUrls
                ? {
                      chrome: typeof rawStoreUrls.chrome === 'string' ? rawStoreUrls.chrome : '',
                      edge: typeof rawStoreUrls.edge === 'string' ? rawStoreUrls.edge : '',
                      firefox: typeof rawStoreUrls.firefox === 'string' ? rawStoreUrls.firefox : '',
                  }
                : { chrome: storeUrl, edge: '', firefox: '' },
        },
    };
}
