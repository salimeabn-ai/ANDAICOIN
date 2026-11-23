// ANDAICOIN node: direct TCP, handshake, sync, full validation, optional mining.
// Usage: node anda-node.mjs --port=47120 [--peers=host:port,...] [--mine] [--data=./chain.json]
import net from 'node:net';
import fs from 'node:fs';
import { secp256k1 as secp } from '@noble/curves/secp256k1';
import * as core from './core.js';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const PORT = Number(argv.port ?? 47120);
const DATA = argv.data ?? './chain.json';
const MINE = Boolean(argv.mine);
const SEEDS = typeof argv.peers === 'string' ? argv.peers.split(',').filter(Boolean) : [];

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const peers = new Set();          // {sock, parser, ready, outbound, addr, nonce, queue}
const selfNonces = new Set();     // used to detect connections to ourselves
let chain = [];

const tip = () => chain[chain.length - 1];
const work = () => core.cumulativeWork(chain);
const randomNonce = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function helloPayload(nonce) {
  return { version: core.PROTOCOL_VERSION, network: core.NETWORK, port: PORT,
           height: chain.length - 1, tipHash: tip().hash,
           cumulativeWork: work().toString(), nonce };
}
function locator() {
  const out = [];
  for (let i = chain.length - 1; i >= 0 && out.length < 10; i--) out.push(chain[i].hash);
  if (!out.includes(chain[0].hash)) out.push(chain[0].hash);
  return out;
}
function findCommon(loc) {
  for (let i = chain.length - 1; i >= 0; i--) if (loc.includes(chain[i].hash)) return i;
  return 0;
}
function send(p, type, obj) { if (!p.sock.destroyed) p.sock.write(core.encodeFrame(type, obj)); }
function broadcast(type, obj, except) {
  for (const p of peers) if (p.ready && p !== except) send(p, type, obj);
}

function attach(sock, outbound, addr) {
  const p = { sock, parser: new core.FrameParser(), ready: false, outbound, addr, nonce: null,
              queue: Promise.resolve() };
  peers.add(p);
  sock.on('data', buf => {
    let frames;
    try { frames = p.parser.push(new Uint8Array(buf)); }
    catch (e) { log('closing', addr, '-', e.message); sock.destroy(); return; }
    for (const f of frames) {
      // messages are processed in order per connection, so consecutive blocks never interleave
      p.queue = p.queue.then(() => onFrame(p, f)).catch(e => log('rejected message from', addr, '-', e.message));
    }
  });
  sock.on('close', () => { peers.delete(p); });
  sock.on('error', () => {});
  if (outbound) {
    p.nonce = randomNonce();
    selfNonces.add(p.nonce);
    send(p, core.T.HELLO, helloPayload(p.nonce));
  }
  log(outbound ? 'outbound connection to' : 'inbound connection from', addr);
}

async function onFrame(p, { type, payload }) {
  if (type === core.T.HELLO || type === core.T.HELLO_ACK) {
    if (payload.version !== core.PROTOCOL_VERSION || payload.network !== core.NETWORK)
      throw new Error('incompatible protocol version or network');
    if (type === core.T.HELLO) {
      if (selfNonces.has(payload.nonce)) { p.sock.destroy(); throw new Error('connected to ourselves'); }
      p.nonce = randomNonce();
      send(p, core.T.HELLO_ACK, helloPayload(p.nonce));
    }
    p.ready = true;
    log('handshake ok with', p.addr, '| peer height', payload.height);
    if (BigInt(payload.cumulativeWork) > work()) send(p, core.T.GETBLOCKS, { locator: locator() });
    return;
  }
  if (!p.ready) throw new Error('message received before handshake');
  if (type === core.T.GETBLOCKS) {
    const from = findCommon(payload.locator);
    for (let i = from + 1; i < chain.length; i++) send(p, core.T.BLOCK, chain[i]);
  } else if (type === core.T.BLOCK) {
    await acceptBlock(p, payload);
  }
}


function indexBlock(b) {
  if (b && b.hash) knownBlocks.set(b.hash, b);
}

function restoreBranchTxs(oldTail, newTail) {
  const newTxIds = new Set();
  for (const b of newTail) {
    for (const tx of b.txs || []) if (!tx.coinbase && tx.id) newTxIds.add(tx.id);
  }
  for (const b of oldTail) {
    for (const tx of b.txs || []) {
      if (!tx.coinbase && tx.id && !newTxIds.has(tx.id) && !mempool.has(tx.id)) {
        mempool.set(tx.id, tx);
      }
    }
  }
}

async function tryReorgForBlock(p, block) {
  if (!knownBlocks.has(block.prev)) return false;
  const rev = [block];
  let curPrev = block.prev;
  while (knownBlocks.has(curPrev)) {
    const parent = knownBlocks.get(curPrev);
    rev.push(parent);
    if (parent.prev === core.ZERO64) break;
    curPrev = parent.prev;
  }
  if (rev[rev.length - 1].hash !== chain[0].hash) return false;
  const candidate = rev.reverse().map((b, idx) => ({ ...b, height: idx }));
  await core.validateChain(secp, candidate);
  if (core.cumulativeWork(candidate) <= work()) return false;

  let splitIdx = 0;
  const minLen = Math.min(chain.length, candidate.length);
  while (splitIdx < minLen && chain[splitIdx].hash === candidate[splitIdx].hash) {
    splitIdx++;
  }
  const oldTail = chain.slice(splitIdx);
  const newTail = candidate.slice(splitIdx);
  chain = candidate;
  for (const b of chain) indexBlock(b);
  restoreBranchTxs(oldTail, newTail);
  for (const b of chain) pruneConfirmedTxs(b);
  save();
  log("reorg completed -> new height=" + (chain.length - 1) + " tip=" + tip().hash.slice(0, 12));
  broadcast(core.T.BLOCK, block, p);
  await processOrphans(block.hash);
  return true;
}

async function acceptBlock(p, block) {
  if (chain.some(b => b.hash === block.hash)) return;
  if (block.prev !== tip().hash) { send(p, core.T.GETBLOCKS, { locator: locator() }); return; }
  await core.validateBlock(secp, block, chain);
  chain.push({ ...block, height: chain.length });
  save();
  log(`block accepted #${chain.length - 1} hash=${block.hash.slice(0, 12)} | target ${core.hexOfBig(core.targetForNext(chain)).slice(0, 10)}`);
  broadcast(core.T.BLOCK, block, p);
}

function save() { fs.writeFileSync(DATA, JSON.stringify(chain)); }

async function mineLoop() {
  for (;;) {
    const startTip = tip().hash;
    const b = await core.mineBlock(secp, chain, [], () => tip().hash !== startTip);
    if (!b || tip().hash !== startTip) continue;
    await core.validateBlock(secp, b, chain);
    chain.push({ ...b, height: chain.length });
    save();
    log(`mined #${chain.length - 1} nonce=${b.nonce} | next target ${core.hexOfBig(core.targetForNext(chain)).slice(0, 10)}`);
    broadcast(core.T.BLOCK, b, null);
  }
}

async function init() {
  const g = await core.genesisBlock();          // stops here if Genesis is not set
  if (fs.existsSync(DATA)) {
    chain = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    await core.validateChain(secp, chain);
  } else {
    chain = [{ ...g, height: 0 }];
    save();
  }
}

(async () => {
  try { await init(); }
  catch (e) { console.error('startup failed:', e.message); process.exit(1); }

  net.createServer(sock => attach(sock, false, sock.remoteAddress + ':' + sock.remotePort))
     .listen(PORT, () => log('node listening on port', PORT, '| height', chain.length - 1));

  for (const addr of SEEDS) {
    const [host, port] = addr.split(':');
    attach(net.connect(Number(port), host), true, addr);
  }
  if (MINE) mineLoop();

  setInterval(() => {
    const ready = [...peers].filter(p => p.ready).length;
    log(`status: height ${chain.length - 1} | connected peers ${ready} | target ${core.hexOfBig(core.targetForNext(chain)).slice(0, 10)}`);
  }, 15000);
})();
