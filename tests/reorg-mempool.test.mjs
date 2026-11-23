import test from 'node:test';
import assert from 'node:assert/strict';
import { cumulativeWork, hexOfBig } from '../core.js';

function selectHeavierChain(currentChain, candidateChain) {
  const currentWork = cumulativeWork(currentChain);
  const candidateWork = cumulativeWork(candidateChain);
  return candidateWork > currentWork ? candidateChain : currentChain;
}

function collectReorgTxs(oldBranchBlocks, newBranchBlocks) {
  const includedIds = new Set();
  for (const b of newBranchBlocks) {
    for (const tx of b.txs || []) {
      if (!tx.coinbase && tx.id) includedIds.add(tx.id);
    }
  }
  const restored = [];
  for (const b of oldBranchBlocks) {
    for (const tx of b.txs || []) {
      if (!tx.coinbase && tx.id && !includedIds.has(tx.id)) {
        restored.push(tx);
      }
    }
  }
  return restored;
}

test('selectHeavierChain prefers strictly higher cumulative work', () => {
  const easyBits = hexOfBig(1n << 240n);
  const harderBits = hexOfBig(1n << 236n);

  const chainA = [
    { bits: easyBits },
    { bits: easyBits }
  ];
  const chainB = [
    { bits: easyBits },
    { bits: harderBits }
  ];

  const chosen = selectHeavierChain(chainA, chainB);
  assert.equal(chosen, chainB);
  assert.ok(cumulativeWork(chainB) > cumulativeWork(chainA));
});

test('collectReorgTxs returns non-coinbase txs missing from new branch', () => {
  const oldBranch = [
    { txs: [{ id: 'cb1', coinbase: true }, { id: 'tx_keep' }, { id: 'tx_drop' }] }
  ];
  const newBranch = [
    { txs: [{ id: 'cb2', coinbase: true }, { id: 'tx_keep' }] }
  ];

  const restored = collectReorgTxs(oldBranch, newBranch);
  assert.deepEqual(restored.map(t => t.id), ['tx_drop']);
});
