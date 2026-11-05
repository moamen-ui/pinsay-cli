/**
 * The Vite plugin's import specifier. New configs get `@pinsay/cli/vite`; configs written by older
 * versions (`pinsay-cli/vite`, or the never-published `pinsay/vite`) are still recognised so re-running
 * init never adds a second plugin and doctor/remove still find them.
 */
export const VITE_PLUGIN_IMPORT = '@pinsay/cli/vite';

const KNOWN_IMPORTS = [VITE_PLUGIN_IMPORT, 'pinsay-cli/vite', 'pinsay/vite'];

/** True when a Vite config's text imports PinSay's plugin under any name it ever had. */
export function hasPinsayViteImport(text: string): boolean {
    return KNOWN_IMPORTS.some((spec) => text.includes(`'${spec}'`) || text.includes(`"${spec}"`));
}
