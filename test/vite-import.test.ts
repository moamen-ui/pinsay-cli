import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPinsayViteImport, VITE_PLUGIN_IMPORT } from '../src/lib/vite-import.js';

test('VITE_PLUGIN_IMPORT is the scoped package', () => {
    assert.equal(VITE_PLUGIN_IMPORT, '@pinsay/cli/vite');
});

test('hasPinsayViteImport finds every name the plugin ever had', () => {
    assert.ok(hasPinsayViteImport("import p from '@pinsay/cli/vite';"));
    assert.ok(hasPinsayViteImport('import p from "pinsay-cli/vite";'));
    assert.ok(hasPinsayViteImport("import p from 'pinsay/vite';"));
    assert.ok(!hasPinsayViteImport("import react from '@vitejs/plugin-react';"));
});
