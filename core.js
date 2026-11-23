// core.js: shared consensus and protocol logic (ANDAICOIN protocol spec v0.2)
// No library imports: the secp256k1 curve is injected by the runtime via the `secp` argument.

export const NETWORK = 'test';
export const PROTOCOL_VERSION = 1;
export const MAGIC = [0xA7, 0xDA, 0x01, 0x0C];
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const REWARD = 1;
export const HALVING_INTERVAL = 210;
export const MAX_HALVINGS = 32;
export const MAX_SUPPLY = (() => {
  let total = 0;
  let r = REWARD;
  for (let h = 0; h < MAX_HALVINGS && r > 0; h++) {
    total += HALVING_INTERVAL * r;
    r = Math.floor(r / 2);
  }
  return total;
})();

export function blockReward(height = 0) {
  const h = Math.max(0, Number(height) || 0);
  const halvings = Math.floor(h / HALVING_INTERVAL);
  if (halvings >= MAX_HALVINGS) return 0;
  let r = REWARD;
  for (let i = 0; i < halvings; i++) {
    r = Math.floor(r / 2);
    if (r <= 0) return 0;
  }
  return r;
}
export const RETARGET = 5;
export const BLOCK_TIME = 20000;            // ms
export const GENESIS_T = 1n << 240n;        // starting target
export const MAX_T = (1n << 256n) - 1n;
export const ZERO64 = '0'.repeat(64);
export const T = { HELLO: 0x01, HELLO_ACK: 0x02, PING: 0x03, PONG: 0x04,
                   BLOCK: 0x12, TX: 0x13, GETBLOCKS: 0x14, GETPEERS: 0x20, PEERS: 0x21 };

// ===== Genesis: fixed for the whole network =====
// Set once with: node tools/mine-genesis.mjs
// Never change these values: any change creates a different chain.
export const GENESIS_TIME = 1795391267245;
export const GENESIS_NONCE = 18776;
export const GENESIS_HASH = '00005aff9be19d5f4e7621e4dc255b4f3ed505f55d017a19cbccd6f0751322d1';

const enc = new TextEncoder();
export const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export const fromHex = h => Uint8Array.from(h.match(/.{2}/g).map(x => parseInt(x, 16)));
export const big = h => BigInt('0x' + h);
export const hexOfBig = b => b.toString(16).padStart(64, '0');

export async function sha256(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export const sha256d = async data => sha256(await sha256(data));
export const sha256dHex = async data => toHex(await sha256d(data));
const concatBytes = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };

// ===== Merkle tree =====
export async function merkleRoot(ids) {
  if (!ids.length) return ZERO64;
  let level = ids.map(fromHex);
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);   // duplicate the last leaf
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256d(concatBytes(level[i], level[i + 1])));
    level = next;
  }
  return toHex(level[0]);
}

// ===== Transactions and signatures =====
export const txid = tx => sha256dHex(JSON.stringify({ c: !!tx.coinbase, i: tx.inputs, o: tx.outputs }));
export const sighash = tx => sha256d(JSON.stringify({ r: tx.inputs.map(i => i.ref), o: tx.outputs }));

export function checkPoint(secp, hex) {
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) throw new Error('invalid point format');
  try { secp.ProjectivePoint.fromHex(hex); } catch (e) { throw new Error('point is not on the curve'); }
}
function verifySig(secp, sigHex, msg, pHex) {
  try { return secp.verify(fromHex(sigHex), msg, fromHex(pHex)); } catch (e) { return false; }
}

// ===== Ledger (UTXO set) =====
export function applyTx(tx, utxo, spentImg) {
  for (const i of tx.inputs || []) { utxo.delete(i.ref); spentImg.add(i.img); }
  tx.outputs.forEach((o, k) => utxo.set(tx.id + ':' + k, o));
}
export function ledger(blocks, extra = []) {
  const utxo = new Map(), spentImg = new Set();
  for (const tx of [...blocks.flatMap(b => b.txs), ...extra]) applyTx(tx, utxo, spentImg);
  return { utxo, spentImg };
}

export async function validateTx(secp, tx, utxo, spentImg) {
  if (!tx.inputs || !tx.inputs.length) throw new Error('no inputs');
  if (tx.id !== await txid(tx)) throw new Error('transaction id does not match content');
  const sh = await sighash(tx);
  const seen = new Set();
  let inSum = 0;
  for (const i of tx.inputs) {
    if (seen.has(i.ref)) throw new Error('duplicate input');
    seen.add(i.ref);
    const o = utxo.get(i.ref);
    if (!o) throw new Error('input not found or already spent');
    if (spentImg.has(i.img)) throw new Error('double spend (key image already used)');
    if (o.P !== i.P) throw new Error('key does not match output');
    if (!verifySig(secp, i.sig, sh, i.P)) throw new Error('invalid ECDSA signature');
    inSum += o.amount;
  }
  let outSum = 0;
  for (const o of tx.outputs) {
    if (!(Number.isInteger(o.amount) && o.amount > 0)) throw new Error('invalid amount');
    checkPoint(secp, o.P); checkPoint(secp, o.N);
    outSum += o.amount;
  }
  if (outSum > inSum) throw new Error('outputs exceed inputs');
  return true;
}

// ===== Difficulty and proof of work =====
export const workOf = bits => (1n << 256n) / (big(bits) + 1n);
export const cumulativeWork = blocks => blocks.reduce((s, b) => s + workOf(b.bits), 0n);

export function targetForNext(blocks) {
  if (!blocks.length) return GENESIS_T;
  const h = blocks.length;
  const prevT = big(blocks[h - 1].bits);
  if (h % RETARGET !== 0) return prevT;
  const first = blocks[h - RETARGET], last = blocks[h - 1];
  const expected = BigInt(BLOCK_TIME * (RETARGET - 1));
  let actual = BigInt(Math.max(1, last.time - first.time));
  const lo = expected / 4n, hi = expected * 4n;
  if (actual < lo) actual = lo;
  if (actual > hi) actual = hi;
  let t = (prevT * actual) / expected;
  if (t > MAX_T) t = MAX_T;
  if (t < 1n) t = 1n;
  return t;
}

export const blockHash = b => sha256dHex(`${b.prev}|${b.merkle}|${b.time}|${b.bits}|${b.nonce}`);

// ===== Block validation =====
export async function validateBlock(secp, block, blocks) {
  const tip = blocks.length ? blocks[blocks.length - 1].hash : ZERO64;
  if (block.prev !== tip) throw new Error('block does not extend the chain tip');
  validateBlockTime(block, blocks);
  if (block.bits !== hexOfBig(targetForNext(blocks))) throw new Error('wrong difficulty target');
  if (block.merkle !== await merkleRoot(block.txs.map(t => t.id))) throw new Error('invalid Merkle root');
  const h = await blockHash(block);
  if (h !== block.hash) throw new Error('block hash mismatch');
  if (big(h) >= big(block.bits)) throw new Error('insufficient proof of work');
  const cb = block.txs[0];
  const expectedReward = blockReward(chain.length);
  if (!cb || !cb.coinbase || cb.inputs.length || cb.outputs.length !== 1 || cb.outputs[0].amount !== expectedReward)
    throw new Error('invalid coinbase');
  if (cb.id !== await txid(cb)) throw new Error('coinbase id mismatch');
  const { utxo, spentImg } = ledger(blocks);
  for (const tx of block.txs.slice(1)) {
    await validateTx(secp, tx, utxo, spentImg);
    applyTx(tx, utxo, spentImg);
  }
  return true;
}

// ===== Genesis =====
export function genesisHeader() {
  return { prev: ZERO64, merkle: ZERO64, time: GENESIS_TIME, bits: hexOfBig(GENESIS_T) };
}
export async function mineGenesis() {
  const h = genesisHeader();
  for (let nonce = 0; ; nonce++) {
    const hash = await blockHash({ ...h, nonce });
    if (big(hash) < big(h.bits)) return { nonce, hash };
  }
}
export async function genesisBlock() {
  if (GENESIS_NONCE === null || GENESIS_HASH === null)
    throw new Error('Genesis is not set: run tools/mine-genesis.mjs and set the values in core.js');
  const g = { ...genesisHeader(), nonce: GENESIS_NONCE, hash: GENESIS_HASH, txs: [] };
  if (await blockHash(g) !== GENESIS_HASH) throw new Error('genesis hash does not match the pinned value');
  if (big(GENESIS_HASH) >= GENESIS_T) throw new Error('genesis does not meet proof of work');
  return g;
}
export async function validateChain(secp, blocks) {
  const g = await genesisBlock();
  if (!blocks.length || blocks[0].hash !== g.hash) throw new Error('genesis does not match the pinned value');
  for (let i = 1; i < blocks.length; i++) await validateBlock(secp, blocks[i], blocks.slice(0, i));
  return true;
}

// ===== Mining (test mode: the reward goes to a random key, so it is burned) =====
export async function mineBlock(secp, blocks, txs = [], shouldStop = () => false) {
  const bits = hexOfBig(targetForNext(blocks));
  const target = big(bits);
  const prev = blocks.length ? blocks[blocks.length - 1].hash : ZERO64;
  const P = toHex(secp.getPublicKey(secp.utils.randomPrivateKey(), true));
  const N = toHex(secp.getPublicKey(secp.utils.randomPrivateKey(), true));
  const cb = { coinbase: true, inputs: [], outputs: [{ P, N, amount: blockReward(chain.length) }] };
  cb.id = await txid(cb);
  const all = [cb, ...txs];
  const merkle = await merkleRoot(all.map(t => t.id));
  const time = Date.now();
  let nonce = 0;
  while (!shouldStop()) {
    for (let i = 0; i < 2000 && !shouldStop(); i++, nonce++) {
      const hash = await blockHash({ prev, merkle, time, bits, nonce });
      if (big(hash) < target) return { prev, merkle, time, bits, nonce, hash, txs: all };
    }
    await new Promise(r => setTimeout(r, 0));
  }
  return null;
}

// ===== TCP framing: Magic(4) | Type(1) | Length(4) | Payload(JSON) =====
export function encodeFrame(type, obj) {
  const body = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(9 + body.length);
  out.set(MAGIC, 0);
  out[4] = type;
  new DataView(out.buffer).setUint32(5, body.length);
  out.set(body, 9);
  return out;
}
export class FrameParser {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out = [];
    while (this.buf.length >= 9) {
      for (let k = 0; k < 4; k++) if (this.buf[k] !== MAGIC[k]) throw new Error('invalid magic bytes');
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(5);
      if (len > MAX_MESSAGE_BYTES) throw new Error('message exceeds size limit');
      if (this.buf.length < 9 + len) break;
      const type = this.buf[4];
      const payload = JSON.parse(new TextDecoder().decode(this.buf.subarray(9, 9 + len)));
      out.push({ type, payload });
      this.buf = this.buf.subarray(9 + len);
    }
    return out;
  }
}

// ===== Phase 1: Consensus Hardening, Time Rules, LWMA & Error Codes =====
export const MAX_FUTURE_TIME_MS = 2 * 60 * 60 * 1000;
export const LWMA_WINDOW = 30;
export const MTP_WINDOW = 11;

export const ERR_CODES = {
  FUTURE_TIME: 'ERR_FUTURE_TIME',
  MTP_VIOLATION: 'ERR_MTP_VIOLATION',
  NEGATIVE_TIMEDELTA: 'ERR_NEGATIVE_TIMEDELTA',
  INVALID_POW: 'ERR_INVALID_POW'
};

export function createConsensusError(code, detail = '') {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  return err;
}

export function medianTimePast(blocks, windowSize = MTP_WINDOW) {
  if (!Array.isArray(blocks) || blocks.length === 0) return GENESIS_TIME;
  const slice = blocks.slice(-windowSize).map(b => Number(b.time)).filter(Number.isFinite);
  if (!slice.length) return GENESIS_TIME;
  const sorted = [...slice].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.floor((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function validateBlockTime(block, blocks, nowMs = Date.now()) {
  if (typeof block?.time !== 'number' || !Number.isFinite(block.time)) {
    throw createConsensusError(ERR_CODES.NEGATIVE_TIMEDELTA, 'invalid block timestamp');
  }
  if (block.time > nowMs + MAX_FUTURE_TIME_MS) {
    throw createConsensusError(ERR_CODES.FUTURE_TIME, `time=${block.time} > max=${nowMs + MAX_FUTURE_TIME_MS}`);
  }
  if (Array.isArray(blocks) && blocks.length > 0) {
    const prevBlock = blocks[blocks.length - 1];
    if (block.time < Number(prevBlock.time)) {
      throw createConsensusError(ERR_CODES.NEGATIVE_TIMEDELTA, `time=${block.time} < prev.time=${prevBlock.time}`);
    }
    const mtp = medianTimePast(blocks, MTP_WINDOW);
    if (block.time <= mtp) {
      throw createConsensusError(ERR_CODES.MTP_VIOLATION, `time=${block.time} <= mtp=${mtp}`);
    }
  }
  return true;
}

export function computeLwmaTarget(blocks, windowSize = LWMA_WINDOW, targetTimeMs = BLOCK_TIME) {
  if (!Array.isArray(blocks) || blocks.length < 2) return GENESIS_T;
  const n = Math.min(blocks.length - 1, windowSize);
  const startIdx = blocks.length - 1 - n;
  let weightedSolvetime = 0n;
  let weightSum = 0n;
  let targetSum = 0n;

  for (let i = 1; i <= n; i++) {
    const prev = blocks[startIdx + i - 1];
    const curr = blocks[startIdx + i];
    const dt = BigInt(curr.time) - BigInt(prev.time);
    if (dt < 0n) {
      throw createConsensusError(ERR_CODES.NEGATIVE_TIMEDELTA, `negative delta between #${startIdx + i - 1} and #${startIdx + i}`);
    }
    const clampedDt = dt > BigInt(targetTimeMs * 6) ? BigInt(targetTimeMs * 6) : dt;
    const w = BigInt(i);
    weightedSolvetime += clampedDt * w;
    weightSum += w;
    targetSum += big(curr.bits);
  }

  const avgTarget = targetSum / BigInt(n);
  const expectedWeighted = BigInt(targetTimeMs) * weightSum;
  if (weightedSolvetime === 0n) weightedSolvetime = 1n;

  let nextT = (avgTarget * weightedSolvetime) / expectedWeighted;
  const maxStepDown = (avgTarget * 70n) / 100n;
  const maxStepUp = (avgTarget * 130n) / 100n;
  if (nextT < maxStepDown) nextT = maxStepDown;
  if (nextT > maxStepUp) nextT = maxStepUp;
  if (nextT > MAX_T) nextT = MAX_T;
  if (nextT < 1n) nextT = 1n;
  return nextT;
}

// ===== Payment Pulse (PP): One-Time / Nonce-Bound Receiving Code =====
export const PP_VERSION = 'pp1';

export function createPulseNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function generatePaymentPulse(recipientKey, nonceHex = createPulseNonce()) {
  if (!recipientKey || typeof recipientKey !== 'string') {
    throw new Error('recipientKey is required for Payment Pulse');
  }
  const cleanNonce = String(nonceHex).trim().toLowerCase();
  if (!/^[0-9a-f]{8,128}$/.test(cleanNonce)) {
    throw new Error('invalid nonceHex for Payment Pulse');
  }
  const digest = await sha256dHex(`${PP_VERSION}|${recipientKey.trim()}|${cleanNonce}`);
  return {
    version: PP_VERSION,
    nonce: cleanNonce,
    ppCode: `${PP_VERSION}_${digest.slice(0, 40)}`
  };
}

export async function verifyPaymentPulse(ppCode, recipientKey, nonceHex) {
  if (!ppCode || !recipientKey || !nonceHex) return false;
  const expected = await generatePaymentPulse(recipientKey, nonceHex);
  return expected.ppCode === ppCode;
}

export async function buildPulseOutput(recipientKey, amount, nonceHex = createPulseNonce()) {
  const pulse = await generatePaymentPulse(recipientKey, nonceHex);
  return {
    address: recipientKey.trim(),
    amount,
    pp: {
      version: pulse.version,
      nonce: pulse.nonce,
      ppCode: pulse.ppCode
    }
  };
}
