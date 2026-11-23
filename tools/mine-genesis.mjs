// Run once to find the Genesis nonce and hash, then copy the output into core.js.
import * as core from '../core.js';

const r = await core.mineGenesis();
console.log('GENESIS_NONCE = ' + r.nonce + ';');
console.log("GENESIS_HASH = '" + r.hash + "';");
console.log('Put these two values into core.js, then restart the node.');
