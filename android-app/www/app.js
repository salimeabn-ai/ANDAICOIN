async function sha256Hex(msg) {
  const buf = new TextEncoder().encode(msg);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256dHex(msg) {
  return sha256Hex(await sha256Hex(msg));
}
function randomHexNonce(bytesLen = 16) {
  const bytes = new Uint8Array(bytesLen);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab-btn")) b.classList.remove("active");
    for (const p of document.querySelectorAll(".panel")) p.classList.remove("active");
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
}
let miningTimer = null;
let hashes = 0;
let height = 0;
const toggleMineBtn = document.getElementById("toggleMineBtn");
const mineStatus = document.getElementById("mineStatus");
toggleMineBtn.addEventListener("click", () => {
  const miner = document.getElementById("minerAddr").value.trim();
  if (miningTimer) {
    clearInterval(miningTimer);
    miningTimer = null;
    toggleMineBtn.textContent = "Start Mining";
    toggleMineBtn.classList.remove("stop");
    mineStatus.textContent = "Status: paused | height: " + height + " | hashes: " + hashes;
    return;
  }
  toggleMineBtn.textContent = "Stop Mining";
  toggleMineBtn.classList.add("stop");
  miningTimer = setInterval(async () => {
    hashes += 250;
    const probe = await sha256dHex(miner + ":" + height + ":" + hashes);
    if (probe.startsWith("000")) {
      height += 1;
      mineStatus.textContent = "Status: mining | block #" + height + " found | hashes: " + hashes;
    } else {
      mineStatus.textContent = "Status: mining | height: " + height + " | hashes: " + hashes;
    }
  }, 400);
});
document.getElementById("sendBtn").addEventListener("click", async () => {
  const mode = document.getElementById("sendMode").value;
  const dest = document.getElementById("sendDest").value.trim();
  const amount = Number(document.getElementById("sendAmount").value || 0);
  const txNonce = randomHexNonce(8);
  const txId = await sha256dHex(mode + "|" + dest + "|" + amount + "|" + txNonce);
  document.getElementById("sendStatus").textContent = JSON.stringify({
    txId, mode, destination: dest, amount, nonce: txNonce, status: "queued_in_local_mempool"
  }, null, 2);
});
document.getElementById("genPpBtn").addEventListener("click", async () => {
  const address = document.getElementById("recvAddr").value.trim();
  const amount = Number(document.getElementById("recvAmount").value || 0);
  const nonce = randomHexNonce(16);
  const digest = await sha256dHex("pp1|" + address + "|" + nonce);
  document.getElementById("recvOutput").textContent = JSON.stringify({
    staticAddress: address,
    amount,
    pp: { version: "pp1", nonce, ppCode: "pp1_" + digest.slice(0, 40) }
  }, null, 2);
});
const getJokeBtn = document.getElementById("getJokeBtn");
const jokeOutput = document.getElementById("jokeOutput");
getJokeBtn.addEventListener("click", async () => {
  getJokeBtn.disabled = true;
  getJokeBtn.textContent = "Loading…";
  jokeOutput.textContent = "Fetching a joke…";
  try {
    const response = await fetch("https://v2.jokeapi.dev/joke/Any?safe-mode");
    if (!response.ok) throw new Error("Joke service returned HTTP " + response.status);
    const data = await response.json();
    if (data.error) throw new Error(data.message || "The joke service returned an error.");
    const joke = data.type === "twopart" ? `${data.setup}\n\n${data.delivery}` : data.joke;
    if (typeof joke !== "string" || !joke.trim()) throw new Error("The service returned an empty joke.");
    jokeOutput.textContent = joke;
  } catch (error) {
    jokeOutput.textContent = "Could not load a joke. Check your internet connection and try again.";
    console.error("Failed to fetch joke:", error);
  } finally {
    getJokeBtn.disabled = false;
    getJokeBtn.textContent = "Get a Random Joke";
  }
});
