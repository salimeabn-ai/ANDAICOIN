import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_TIME,
  REWARD,
  ZERO64,
  ERR_CODES,
  big,
  txid,
  merkleRoot,
  blockHash,
  hexOfBig,
  targetForNext,
  genesisBlock,
  validateBlock,
  medianTimePast,
  validateBlockTime,
  computeLwmaTarget
} from '../core.js';

const mockSecp = {
  ProjectivePoint: {
    fromHex() {
      return {};
    }
  },
  verify() {
    return true;
  }
};

async function buildCandidateBlock(prevBlocks, timeMs, mineValidPow = false) {
  const prev = prevBlocks.length ? prevBlocks[prevBlocks.length - 1].hash : ZERO64;
  const bits = hexOfBig(targetForNext(prevBlocks));
  const target = big(bits);
  const cb = {
    coinbase: true,
    inputs: [],
    outputs: [{
      P: '02' + '11'.repeat(32),
      N: '02' + '22'.repeat(32),
      amount: REWARD
    }]
  };
  cb.id = await txid(cb);
  const txs = [cb];
  const merkle = await merkleRoot(txs.map(t => t.id));
  const block = {
    prev,
    merkle,
    time: timeMs,
    bits,
    nonce: 0,
    txs
  };

  if (!mineValidPow) {
    block.hash = await blockHash(block);
    return block;
  }

  for (let nonce = 0; ; nonce++) {
    block.nonce = nonce;
    const h = await blockHash(block);
    if (big(h) < target) {
      block.hash = h;
      return block;
    }
  }
}

test('rejects block timestamp too far in the future', () => {
  const futureTime = Date.now() + 3 * 60 * 60 * 1000;
  assert.throws(
    () => validateBlockTime({ time: futureTime }, []),
    err => err.code === ERR_CODES.FUTURE_TIME
  );
});

test('rejects negative time delta', () => {
  const base = GENESIS_TIME + 100000;
  const chain = [
    { time: base },
    { time: base + 20000 },
    { time: base + 40000 }
  ];
  assert.throws(
    () => validateBlockTime({ time: base + 35000 }, chain),
    err => err.code === ERR_CODES.NEGATIVE_TIMEDELTA
  );
});

test('rejects MTP violation when time is not negative delta but below or equal MTP', () => {
  const base = GENESIS_TIME + 100000;
  const chain = [
    { time: base },
    { time: base + 20000 },
    { time: base + 40000 },
    { time: base + 40000 },
    { time: base + 40000 }
  ];
  const mtp = medianTimePast(chain);
  assert.equal(mtp, base + 40000);
  assert.throws(
    () => validateBlockTime({ time: mtp }, chain),
    err => err.code === ERR_CODES.MTP_VIOLATION
  );
});

test('LWMA computes valid positive target', () => {
  const start = GENESIS_TIME + 200000;
  const blocks = [];
  for (let i = 0; i < 10; i++) {
    blocks.push({
      time: start + i * 20000,
      bits: (1n << 240n).toString(16).padStart(64, '0')
    });
  }
  const nextT = computeLwmaTarget(blocks);
  assert.ok(typeof nextT === 'bigint' && nextT > 0n);
});

test('validateBlock rejects invalid timestamp and accepts a valid block', async () => {
  const genesis = await genesisBlock();
  const chain = [genesis];

  const badFutureTime = Date.now() + 3 * 60 * 60 * 1000;
  const invalidBlock = await buildCandidateBlock(chain, badFutureTime, false);
  await assert.rejects(
    () => validateBlock(mockSecp, invalidBlock, chain),
    err => err.code === ERR_CODES.FUTURE_TIME
  );

  const validTime = Math.max(Date.now(), genesis.time + 1000);
  const validBlock = await buildCandidateBlock(chain, validTime, true);
  const ok = await validateBlock(mockSecp, validBlock, chain);
  assert.equal(ok, true);
});
