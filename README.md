# ANDAICOIN Node (Termux)

## Requirements
Node.js 20 or newer (Termux: pkg install nodejs)

## Setup
1. npm install
2. Genesis is already pinned in core.js. Do not change GENESIS_TIME, GENESIS_NONCE, or GENESIS_HASH.
   To verify the pinned values: node tools/mine-genesis.mjs (it must print the same nonce and hash).

## Local test on one phone (two sessions)
Session 1:
  node anda-node.mjs --port=47120 --mine --data=./chainA.json
Session 2 (New session in Termux):
  node anda-node.mjs --port=47121 --peers=127.0.0.1:47120 --data=./chainB.json

Expected:
- Session 2 shows "handshake ok", then "block accepted" for each block mined in session 1.
- Every 15 seconds the status line shows height, connected peers, and the current target.

## Two phones on the same Wi-Fi
Phone B: node anda-node.mjs --port=47120 --peers=IP_A:47120 --data=./chain.json
(IP_A is phone A's address on the network, shown by: ifconfig or ip addr)

## Known limits of this stage (intentional)
- No INV/GETDATA yet: full blocks are sent to each peer (temporary simplification).
- Fork choice by cumulative work is partial: a conflicting branch triggers GETBLOCKS, but full reorg is not implemented yet.
- Transactions are not relayed or mined yet (requires a wallet inside the node).
- Mining rewards go to a random key, so they are burned. This is for testing only.
