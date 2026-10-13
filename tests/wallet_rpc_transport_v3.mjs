// Bounded HTTP transport and finality observations; no real wallet or broadcast.
import assert from 'node:assert/strict';
import {walletRpcEndpoint, walletRpcFetch, waitForFinalizedSignature, DEVNET_GENESIS} from '../web/wallet-rpc-v3.mjs';

const config = {schema: 'flybrainlabs-wallet-mining-config-v3', cluster: 'devnet', genesisHash: DEVNET_GENESIS,
  apiBase: 'https://node.example', rpc: 'https://node.example/api/mining/v3/rpc'};
let checks = 0;
assert.equal(walletRpcEndpoint(config), config.rpc); checks++;
assert.equal(walletRpcEndpoint({...config, rpc: 'https://api.devnet.solana.com'}), 'https://api.devnet.solana.com'); checks++;
for (const patch of [{cluster: 'mainnet-beta'}, {genesisHash: 'wrong'}, {rpc: 'https://provider.example/?api-key=fixture'},
  {rpc: config.rpc + '?api-key=fixture'}, {apiBase: 'https://other.example'}, {apiBase: 'https://user:password@node.example'},
  {apiBase: 'https://node.example/'}, {rpc: 'https://node.example/api/another/rpc'}, {rpcUpstream: 'private'}]) {
  assert.throws(() => walletRpcEndpoint({...config, ...patch})); checks++;
}
const session = {account: {address: 'fixture-wallet'}, login: {wallet: 'fixture-wallet', token: 'fixture-token', csrfToken: 'fixture-csrf', expiresAt: Date.now() / 1000 + 600}};
let requests = 0;
const fetchRpc = walletRpcFetch(config, session, async (url, options) => {
  requests++;
  assert.equal(url, config.rpc); assert.equal(options.headers.get('Authorization'), 'Bearer fixture-token');
  assert.equal(options.headers.get('X-Mining-CSRF'), 'fixture-csrf'); assert.equal(options.credentials, 'omit');
  return new Response('{"jsonrpc":"2.0","id":1,"result":123}', {status: 200});
});
await fetchRpc(config.rpc, {method: 'POST'}); assert.equal(requests, 1); checks++;
await assert.rejects(fetchRpc('https://other.example', {})); assert.equal(requests, 1); checks++;
for (const patch of [{login: null}, {login: {...session.login, wallet: 'other-wallet'}}, {login: {...session.login, expiresAt: 1}}]) {
  await assert.rejects(walletRpcFetch(config, {...session, ...patch}, async () => { throw new Error('Must not reach RPC'); })(config.rpc), {code: 'wallet-login-required'}); checks++;
}
let limitedCalls = 0;
await assert.rejects(walletRpcFetch(config, session, async () => {limitedCalls++; return new Response('', {status: 429});})(config.rpc), {code: 'RPC_RATE_LIMITED'});
assert.equal(limitedCalls, 1); checks++;
await assert.rejects(walletRpcFetch(config, session, async () => new Response('', {status: 503}))(config.rpc), {code: 'RPC_UNAVAILABLE'}); checks++;
const sensitive = 'https://provider.invalid/?api-key=fixture-private-key';
try { await walletRpcFetch(config, session, async () => {throw new Error(sensitive);})(config.rpc); assert.fail(); }
catch (error) {assert.equal(error.code, 'RPC_UNAVAILABLE'); assert(!error.message.includes(sensitive)); checks++;}

let now = 0, observed = 0;
const connection = {
  getSignatureStatuses: async () => ({value: [++observed === 1 ? {confirmationStatus: 'confirmed', err: null} : {confirmationStatus: 'finalized', err: null}]}),
  getBlockHeight: async () => {throw new Error('An observed transaction must not be expired using only its old blockhash');},
};
const clock = {now: () => now, sleep: async ms => {now += ms;}, timeoutMs: 20, intervalMs: 5};
assert.equal((await waitForFinalizedSignature(connection, {signature: 'fixture', lastValidBlockHeight: 1}, clock)).confirmationStatus, 'finalized');
assert.equal(observed, 2); checks++;
await assert.rejects(waitForFinalizedSignature({getSignatureStatuses: async () => ({value: [{confirmationStatus: 'finalized', err: {InstructionError: [0, 'fixture']}}]})}, {signature: 'fixture'}, clock), {code: 'GRANT_TRANSACTION_FAILED'}); checks++;
await assert.rejects(waitForFinalizedSignature({getSignatureStatuses: async () => ({value: [null]}), getBlockHeight: async () => 2}, {signature: 'fixture', lastValidBlockHeight: 1}, clock), {code: 'CHAIN_STATUS_UNKNOWN'}); checks++;
now = 0;
await assert.rejects(waitForFinalizedSignature({getSignatureStatuses: async () => ({value: [{confirmationStatus: 'confirmed', err: null}]})}, {signature: 'fixture'}, clock), {code: 'CHAIN_STATUS_UNKNOWN'}); checks++;
await assert.rejects(waitForFinalizedSignature(connection, {signature: 'fixture'}, {...clock, now: () => 0, guard: () => {throw Object.assign(new Error('changed'), {code: 'STALE_WALLET'});}}), {code: 'STALE_WALLET'}); checks++;
console.log(JSON.stringify({passed: true, checks, actualRpc: false, transactions: 0}));
