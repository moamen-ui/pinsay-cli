/** The environment tag (1/2/3 or a name) as its display name: Local, Staging, Production. */
export function formatEnvironment(env: number | string): string {
  if (env === 1 || env === '1' || String(env).toLowerCase() === 'local') return 'Local';
  if (env === 2 || env === '2' || String(env).toLowerCase() === 'staging') return 'Staging';
  if (env === 3 || env === '3' || String(env).toLowerCase() === 'production' || String(env).toLowerCase() === 'prod') return 'Production';
  return String(env);
}
