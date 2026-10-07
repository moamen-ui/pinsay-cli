// Loaded before every test file (package.json "test" script, `--import`). The CLI's only server is
// production (https://app.pinsay.dev); `PINSAY_SERVER` is its hidden test override. Point it at a
// closed local port for the whole run, so a test that forgets to name its stub fails fast instead
// of sending a fake key to production. Tests that need a stub set their own value.
process.env.PINSAY_SERVER = 'http://127.0.0.1:9';
