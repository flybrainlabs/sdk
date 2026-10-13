// The browser receives only a credential-free gateway URL. Chain identity is
// checked independently of the transport before a financial operation.
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const PUBLIC_DEVNET_RPC = 'https://api.devnet.solana.com';

export function walletRpcEndpoint(config) {
  if (config.schema !== 'flybrainlabs-wallet-mining-config-v3' ||
      config.cluster !== 'devnet' || config.genesisHash !== DEVNET_GENESIS || Object.hasOwn(config, 'rpcUpstream')) {
    throw new Error('Unrecognized test network');
  }
  if (config.rpc === PUBLIC_DEVNET_RPC) return config.rpc;
  let gateway;
  try { gateway = new URL(config.apiBase); } catch { throw new Error('Invalid wallet RPC gateway'); }
  if (gateway.protocol !== 'https:' || gateway.origin !== config.apiBase ||
      gateway.username || gateway.password || gateway.search || gateway.hash ||
      config.rpc !== gateway.origin + '/api/mining/v3/rpc') {
    throw new Error('Wallet RPC must use the pinned credential-free gateway');
  }
  return config.rpc;
}

const rpcError = (code, status) => Object.assign(new Error(code === 'RPC_RATE_LIMITED'
  ? 'Wallet RPC is rate limited. Wait briefly and retry; saved work is retained.'
  : 'Wallet RPC is temporarily unavailable. Retry; saved work is retained.'), {code, status});

export function walletRpcFetch(config, session, fetchImpl = globalThis.fetch) {
  const endpoint = walletRpcEndpoint(config), proxied = endpoint !== PUBLIC_DEVNET_RPC;
  return async (url, options = {}) => {
    if (String(url).replace(/\/$/, '') !== endpoint.replace(/\/$/, '')) throw new Error('Wallet RPC transport changed');
    const headers = new Headers(options.headers);
    if (proxied) {
      if (!session.login || !session.account || session.login.wallet !== session.account.address ||
          Number(session.login.expiresAt) <= Date.now() / 1000) {
        throw Object.assign(new Error('Sign in before reading wallet RPC state'), {code: 'wallet-login-required'});
      }
      headers.set('Authorization', 'Bearer ' + session.login.token);
      headers.set('X-Mining-CSRF', session.login.csrfToken);
    }
    const timeout = AbortSignal.timeout(15_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response;
    try {
      response = await fetchImpl(url, {...options, headers, signal, credentials: 'omit', cache: 'no-store'});
    } catch {
      throw rpcError('RPC_UNAVAILABLE');
    }
    if (response.status === 429) throw rpcError('RPC_RATE_LIMITED', 429);
    if (response.status >= 500) throw rpcError('RPC_UNAVAILABLE', response.status);
    if (proxied && response.status === 401) throw Object.assign(new Error('Wallet login expired; sign in again'), {code: 'wallet-login-required', status: 401});
    return response;
  };
}

// HTTP polling also works with providers that do not supply a WebSocket URL.
// A timeout or expired blockhash leaves the original signature unconfirmed;
// neither condition authorizes another transaction or proves payment failure.
export async function waitForFinalizedSignature(connection, {signature, lastValidBlockHeight}, {
  guard = () => {}, timeoutMs = 120_000, intervalMs = 1500,
  now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    guard();
    const {value} = await connection.getSignatureStatuses([signature], {searchTransactionHistory: true});
    guard();
    const status = value[0];
    if (status?.confirmationStatus === 'finalized') {
      if (status.err) throw Object.assign(new Error('The grant transaction failed on chain'), {code: 'GRANT_TRANSACTION_FAILED'});
      return status;
    }
    if (!status && await connection.getBlockHeight('finalized') > lastValidBlockHeight) break;
    guard();
    await sleep(intervalMs);
  }
  throw Object.assign(new Error('The original transaction is not yet confirmed. Check its status before retrying.'), {code: 'CHAIN_STATUS_UNKNOWN'});
}
