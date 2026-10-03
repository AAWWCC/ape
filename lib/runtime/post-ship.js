import path from 'node:path';
import { currentBranch, runGit, workingTreeStatus } from './git.js';
import { readBoundedRegularFileUtf8, spawnWithTimeout } from './spawn.js';
import { resolveFrozenShippingTarget, shippingPrUrlMatches } from './shipping-target.js';
import { boundedGateSummary } from './bounded-summary.js';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TOKEN = /^[0-9]{14}-[0-9a-f]{12}$/;

export function codexRefreshPending(state, config) {
  return config.shipping?.codex_dev_refresh === true && state?.host === 'codex' &&
    state.status === 'completed' && state.merge?.provider === 'github' &&
    state.codex_plugin_refresh?.status !== 'installed';
}

// Called under the receipt-effects lock, after the completed run and checkout
// cleanup are durable. Installation is a local follow-up, never merge evidence.
// A retry reuses the published version; successful refreshes are not repeated.
export async function refreshCodexAfterShip(paths, state, config, save) {
  if (!codexRefreshPending(state, config)) return null;
  if (state.checkout_cleanup?.status !== 'returned') return null;
  const previous = state.codex_plugin_refresh;
  /** @type {{ status: string, plugin_id: string, activation: string, updated_at: string,
   * tree_sha?: string, head_oid?: string, cachebuster?: string, version?: string, reason?: string }} */
  let refresh = {
    ...(previous?.tree_sha === state.gates?.tree_sha && TOKEN.test(previous?.cachebuster ?? '') ? {
      tree_sha: previous.tree_sha, head_oid: previous.head_oid,
      cachebuster: previous.cachebuster, version: previous.version,
    } : {}),
    status: 'failed', plugin_id: 'ape@ape-dev', activation: 'unverified',
    updated_at: new Date().toISOString(),
  };
  try {
    const target = await resolveFrozenShippingTarget(paths.root, state, config);
    if (target?.repository !== 'AAWWCC/ape' || target.base !== 'main' ||
        state.base_branch !== target.base || state.merge.base !== target.base ||
        !shippingPrUrlMatches(state.merge.url, target) || !OID.test(state.merge.head_oid ?? '') ||
        state.gates?.passed !== true || !OID.test(state.gates.tree_sha ?? '')) {
      throw new Error('automatic ape-dev refresh requires a verified shipment of the canonical public APE repository');
    }
    if (await currentBranch(paths.root) !== target.base ||
        (await workingTreeStatus(paths.root)).some(line => !line.slice(3).startsWith('.ape/'))) {
      throw new Error('automatic ape-dev refresh requires the clean returned base checkout');
    }
    const head = await runGit(paths.root, ['rev-parse', 'HEAD']);
    const remote = await runGit(paths.root, ['rev-parse', `refs/remotes/origin/${target.base}`]);
    const tree = await runGit(paths.root, ['rev-parse', 'HEAD^{tree}']);
    if (head !== remote || tree !== state.gates.tree_sha) {
      throw new Error('automatic ape-dev refresh requires the exact gate-attested tree on the fetched base');
    }
    const script = path.join(paths.root, 'scripts', 'reinstall-codex-plugin.mjs');
    await readBoundedRegularFileUtf8(script);
    const manifest = JSON.parse(await readBoundedRegularFileUtf8(
      path.join(paths.root, 'plugins', 'ape', '.codex-plugin', 'plugin.json'),
    ));
    if (manifest.name !== 'ape' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
      throw new Error('automatic ape-dev refresh requires the generated APE Codex package');
    }
    const token = previous?.tree_sha === tree && TOKEN.test(previous?.cachebuster ?? '')
      ? previous.cachebuster
      : `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${head.slice(0, 12)}`;
    refresh = {
      ...refresh, status: 'installing', tree_sha: tree, head_oid: head, cachebuster: token,
      version: `${manifest.version.split('+', 1)[0]}+codex.${token}`,
    };
    state.codex_plugin_refresh = refresh;
    await save();
    const result = await spawnWithTimeout(process.execPath, [
      script, '--marketplace', 'ape-dev', '--cachebuster', token, '--preserve-open-tasks',
    ], { cwd: paths.root, shell: false, timeout_ms: 120_000, max_output: 16_384, supervise: true });
    if (result.exit_code !== 0 || result.timed_out || result.spawn_error || result.signal) {
      throw new Error(result.timed_out ? 'Codex development refresh timed out' :
        result.spawn_error || result.combined || `Codex development refresh exited ${result.exit_code}`);
    }
    refresh = { ...refresh, status: 'installed', activation: 'new_session_required' };
  } catch (error) {
    refresh = { ...refresh, status: 'failed', reason: boundedGateSummary(error?.message ?? String(error)) };
  }
  state.codex_plugin_refresh = { ...refresh, updated_at: new Date().toISOString() };
  await save();
  return state.codex_plugin_refresh;
}
