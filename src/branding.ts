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
     * The Chrome extension's Web Store listing / manual-install zip — a super-admin setting
     * (`GET /api/branding` → `extension.storeUrl`/`extension.zipUrl`), never hard-coded here. Both
     * may be empty when the admin has not configured them yet.
     */
    extension: { storeUrl: string, zipUrl: string },
}> {
    let branding: { productName?: string, urls?: { app?: string }, extension?: { storeUrl?: string, zipUrl?: string } };
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

    return {
        productName: branding.productName,
        urls: { app: branding.urls?.app ?? '' },
        extension: { storeUrl: branding.extension?.storeUrl ?? '', zipUrl: branding.extension?.zipUrl ?? '' },
    };
}
