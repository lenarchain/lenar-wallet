import init, {
  generate_mnemonic,
  validate_mnemonic,
  derive_address,
  derive_ed25519_privkey_hex,
  address_from_pubkey_hex,
  build_hardened_path,
  sign_transaction,
  verify_transaction,
  tx_hash_hex,
  sign_message,
  verify_message,
} from "./pkg/libcrypto.js";

const COIN_TYPE = 15000;
const ADDRESS_PREFIX = "rx";
const AUTO_LOCK_MS = 5 * 60 * 1000;
const U256_MAX = (1n << 256n) - 1n;

const DEFAULT_NETWORK = Object.freeze({
  id: "default", name: "Alpha", type: "mainnet", rpcUrl: "https://alpha.lenarchain.xyz/", chainId: 1, symbol: "LP", builtin: true,
});
const NETWORK_TYPES = ["mainnet", "testnet"];
const MAX_NETWORKS = 20;
const NETWORK_NAME_MAX = 24;
const U32_MAX = 0xFFFFFFFF;
const SYMBOL_RE = /^[A-Za-z0-9]{1,12}$/;
const RPC_TIMEOUT_MS = 8000;
const ADDRESS_PREFIX_RX = "rx";
const TRANSFER_POWER = 1200n;
const POLL_MAX_TRY = 15;
const POLL_DELAY_MS = 2000;
const HISTORY_MAX_ENTRIES = 50;
const MAX_FEE = 10n ** 17n;
const MAX_TIP = 10n ** 17n;
const MAX_SIGN_MSG_BYTES = 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function errMsg(e) {
  if (e instanceof Error) return e.message || e.name || "Unknown error";
  if (typeof e === "string" && e) return e;
  if (e && typeof e.message === "string" && e.message) return e.message;
  return "Unknown error";
}

class WalletError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const lockedError = () => new WalletError("Wallet is locked, unlock first", "LOCKED");

function errorResponse(e) {
  const r = { error: errMsg(e) };
  if (e && typeof e.code === "string") r.code = e.code;
  if (e && e.extra && typeof e.extra === "object") Object.assign(r, toPlain(e.extra));
  return r;
}

function toPlain(v, depth = 0) {
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v !== "object") return v;
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.map((x) => toPlain(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = toPlain(x, depth + 1);
  return out;
}

function getStorage() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    throw new Error(
      'chrome.storage.local is not available. Make sure "storage" is in the ' +
      'manifest.json permissions and the code is running as the extension service worker.'
    );
  }
  return chrome.storage.local;
}
async function storageGet(keys) { return getStorage().get(keys); }
async function storageSet(obj) { return getStorage().set(obj); }

function hexToBytes(hex) {
  const text = String(hex);
  const clean = text.startsWith("rx") ? text.slice(2) : text;
  if (clean.length % 2 !== 0) throw new Error("Hex string has odd length");
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error("Hex string contains non-hex characters");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stripPrefix(v) {
  return String(v).replace(new RegExp("^" + ADDRESS_PREFIX_RX, "i"), "");
}
function rejectLegacyPrefix(v, label) {
  if (/^0x/i.test(String(v))) {
    throw new Error(label + " with the 0x prefix is not supported. Use the rx prefix.");
  }
}

function toRx(v) { return ADDRESS_PREFIX_RX + stripPrefix(v).toLowerCase(); }

function normalizeAddress(address, label = "Address") {
  if (typeof address !== "string") throw new Error(`${label} must be rx + 40 hex characters.`);
  rejectLegacyPrefix(address, label);
  const hex = stripPrefix(address.trim()).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`${label} must be rx + 40 hex characters.`);
  return ADDRESS_PREFIX_RX + hex;
}

function normalizeTxHash(txHash) {
  if (typeof txHash !== "string") throw new Error("Invalid tx hash format");
  const hex = stripPrefix(txHash.trim()).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Invalid tx hash format");
  return ADDRESS_PREFIX_RX + hex;
}

function u256ToHex(value, fieldName) {
  let v;
  try {
    v = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new Error(`${fieldName} is not a valid integer: ${value}`);
  }
  if (v < 0n) throw new Error(`${fieldName} cannot be negative: ${v}`);
  if (v > U256_MAX) throw new Error(`${fieldName} exceeds the uint256 limit (2^256-1): ${v}`);
  return v.toString(16).padStart(64, "0");
}

const U64_MAX = (1n << 64n) - 1n;

function toU64(value, fieldName) {
  let n;
  try {
    n = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new Error(`${fieldName} is not a valid integer: ${value}`);
  }
  if (n < 0n) throw new Error(`${fieldName} cannot be negative: ${n}`);
  if (n > U64_MAX) throw new Error(`${fieldName} exceeds the uint64 limit: ${n}`);
  return n;
}

class RpcError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function cleanNetwork(n) {
  if (!n || typeof n !== "object") return null;
  if (typeof n.id !== "string" || !n.id || n.id === DEFAULT_NETWORK.id) return null;
  if (typeof n.rpcUrl !== "string" || !n.rpcUrl) return null;
  let rpcUrl; // http(s) only, trailing "/" added: a stored legacy URL like https://host or https://host/rpc is fixed here
  try { rpcUrl = normalizeRpcUrl(n.rpcUrl); } catch { return null; }
  if (!Number.isInteger(n.chainId) || n.chainId < 0 || n.chainId > U32_MAX) return null;
  if (typeof n.symbol !== "string" || !SYMBOL_RE.test(n.symbol)) return null;
  return {
    id: n.id,
    name: typeof n.name === "string" && n.name.trim() ? n.name.trim().slice(0, NETWORK_NAME_MAX) : "Custom",
    type: NETWORK_TYPES.includes(n.type) ? n.type : "testnet",
    rpcUrl, chainId: n.chainId, symbol: n.symbol, builtin: false,
  };
}

function hostOf(url) { try { return new URL(url).host; } catch { return "Custom"; } }

async function loadNetworks() {
  const { networks, activeNetworkId, network, rpcUrl } = await storageGet(["networks", "activeNetworkId", "network", "rpcUrl"]);
  let custom = [];
  if (Array.isArray(networks)) {
    networks.forEach((n, i) => {
      const c = cleanNetwork(n);
      if (c) custom.push(c);
      else console.warn(`Stored network #${i + 1} is invalid and was ignored:`, n && n.name ? n.name : n);
    });
  }
  let activeId = typeof activeNetworkId === "string" ? activeNetworkId : DEFAULT_NETWORK.id;
  if (!Array.isArray(networks)) {
    const legacy = network && typeof network === "object"
      ? { rpcUrl: network.rpcUrl, chainId: network.chainId, symbol: network.symbol }
      : (typeof rpcUrl === "string" && rpcUrl ? { rpcUrl, chainId: DEFAULT_NETWORK.chainId, symbol: DEFAULT_NETWORK.symbol } : null);
    if (legacy) {
      const c = cleanNetwork({ id: "legacy", name: hostOf(legacy.rpcUrl).slice(0, NETWORK_NAME_MAX), type: "mainnet", ...legacy });
      const sameAsDefault = c && c.rpcUrl === DEFAULT_NETWORK.rpcUrl && c.chainId === DEFAULT_NETWORK.chainId && c.symbol === DEFAULT_NETWORK.symbol;
      if (c && !sameAsDefault) { custom = [c]; activeId = c.id; }
    }
  }
  const all = [{ ...DEFAULT_NETWORK }, ...custom];
  if (!all.some((n) => n.id === activeId)) activeId = DEFAULT_NETWORK.id;
  return { all, custom, activeId };
}

async function saveNetworks(custom, activeId) {
  await storageSet({ networks: custom, activeNetworkId: activeId });
  await getStorage().remove(["network", "rpcUrl"]); // old formats
}

async function getNetwork() {
  const { all, activeId } = await loadNetworks();
  return all.find((n) => n.id === activeId) || all[0];
}

async function getRpcUrl() { return (await getNetwork()).rpcUrl; }

function parseChainId(value, label) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "bigint") n = Number(value);
  else if (typeof value === "string" && /^\d{1,10}$/.test(value.trim())) n = Number(value.trim());
  else n = NaN;
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) {
    throw new Error(`${label || "Chain ID"} must be a whole number between 0 and ${U32_MAX}.`);
  }
  return n;
}

const JSON_SOURCE_SUPPORTED = (() => {
  try {
    let ok = false;
    JSON.parse("1", (k, v, ctx) => { ok = !!ctx && ctx.source === "1"; return v; });
    return ok;
  } catch { return false; }
})();

function parseJsonKeepU64(text) {
  return JSON.parse(text, (key, value, ctx) => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      ctx && typeof ctx.source === "string" &&
      /^-?\d+$/.test(ctx.source)
    ) {
      return BigInt(ctx.source);
    }
    return value;
  });
}

async function readLimitedText(res, maxBytes, base) {
  const tooLarge = () => new RpcError(`Node response is too large (limit ${maxBytes / 1024 / 1024} MB)`, res.status);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  try {
    if (!res.body || typeof res.body.getReader !== "function") {
      const t = await res.text();
      if (t.length > maxBytes) throw tooLarge();
      return t;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); throw tooLarge(); }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    return text + decoder.decode();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new RpcError(`Node did not respond within ${RPC_TIMEOUT_MS / 1000} seconds (${base})`, 0);
    }
    throw new RpcError(`Connection to the node was lost (${base}).`, 0);
  }
}

async function rpcJsonAt(base, path, options) {
  if (!JSON_SOURCE_SUPPORTED) {
    throw new RpcError("Browser too old: JSON.parse source text is required (Chrome 114+).", 0);
  }
  const root = base.endsWith("/") ? base : base + "/";
  let res;
  try {
    res = await fetch(root + path, {
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      ...options,
    });
  } catch (e) {
    if (e && e.name === "TimeoutError") {
      throw new RpcError(`Node did not respond within ${RPC_TIMEOUT_MS / 1000} seconds (${root})`, 0);
    }
    throw new RpcError(`Cannot connect to node (${root}). Check the URL, server, and access permission.`, 0);
  }
  let data = null;
  try { data = parseJsonKeepU64(await readLimitedText(res, MAX_RESPONSE_BYTES, root)); }
  catch (e) { if (e instanceof RpcError) throw e; /* body is not JSON */ }
  if (!res.ok) throw new RpcError((data && data.error) || `HTTP ${res.status} for ${path}`, res.status);
  if (data === null || typeof data !== "object") throw new RpcError("Node response is not JSON", res.status);
  return data;
}

async function rpcJson(path, options) {
  return rpcJsonAt(await getRpcUrl(), path, options);
}

const rpcCall = (base, path, options) => (base ? rpcJsonAt(base, path, options) : rpcJson(path, options));

function requireDec(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Node response: ${name} is not a decimal number`);
  return value;
}
function requireU64(value, name) {
  let n;
  if (typeof value === "bigint") {
    n = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Node response: ${name} is not an integer`);
    n = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    n = BigInt(value);
  } else {
    throw new Error(`Node response: ${name} is not a valid u64 number`);
  }
  if (n < 0n || n > U64_MAX) throw new Error(`Node response: ${name} is out of the u64 range`);
  return n.toString();
}

function optDec(value, name) { return value == null ? "-" : requireDec(value, name); }
function optU64(value, name) { return value == null ? "-" : requireU64(value, name); }
function optText(value) { return value == null ? "-" : String(value); }

function txStatusText(code) {
  switch (code) {
    case 0: return "pending";
    case 1: return "success";
    case 2: return "failed";
    default: return "unknown";
  }
}
function isFinalStatus(code) { return code === 1 || code === 2; }

async function getTraffic() {
  const d = await rpcJson("traffic", { method: "GET" });
  const raw = { low: requireDec(d.min, "min"), medium: requireDec(d.medium, "medium"), fast: requireDec(d.fast, "fast") };
  const out = {};
  let capped = false;
  for (const [k, v] of Object.entries(raw)) {
    if (BigInt(v) > MAX_TIP) { out[k] = MAX_TIP.toString(); capped = true; } else { out[k] = v; }
  }
  return { ...out, capped };
}

async function getAccount(address, base) {
  const addr = normalizeAddress(address);
  try {
    const d = await rpcCall(base, "account/" + addr, { method: "GET" });
    const [nonceName, nonceRaw] = d.pending_nonce != null ? ["pending_nonce", d.pending_nonce] : ["nonce", d.nonce];
    return {
      address: addr,
      balance: requireDec(d.balance, "balance"),
      nonce: requireU64(nonceRaw, nonceName),
    };
  } catch (e) {
    if (e instanceof RpcError && e.status === 404) return { address: addr, balance: "0", nonce: "0" };
    throw e;
  }
}

async function getPowerPrice(base) {
  const d = await rpcCall(base, "power_price", { method: "GET" });
  return BigInt(requireDec(d.power_price, "power_price"));
}

async function getFeeInfo() {
  const price = await getPowerPrice();
  return { power: TRANSFER_POWER.toString(), powerPrice: price.toString(), fee: (price * TRANSFER_POWER).toString() };
}

async function getTransactionDetail(txHash, base) {
  const hash = normalizeTxHash(txHash);
  const d = await rpcCall(base, "transaction/" + hash, { method: "GET" });

  return {
    version: d.version,
    hash: d.hash,
    txStatus: d.status,
    txStatusText: txStatusText(d.status),
    blockNumber: requireU64(d.blocknumber, "blocknumber"),
    position: d.position,
    timestamp: Number(requireU64(d.timestamp, "timestamp")),
    chainid: d.chainid,
    action: d.action,
    sender: d.sender,
    to: d.to,
    nonce: d.pending_nonce != null ? requireU64(d.pending_nonce, "pending_nonce") : requireU64(d.nonce, "nonce"),
    amount: requireDec(d.amount, "amount"),
    power: optU64(d.power, "power"),
    powerLimit: optU64(d.power_limit, "power_limit"),
    powerUsed: optU64(d.power_used, "power_used"),
    pricePerPower: optDec(d.price_per_power, "price_per_power"),
    fee: optDec(d.fee, "fee"),
    tip: optDec(d.tip, "tip"),
    packet: d.packet,
    event: d.event,
    signature: d.signature,
  };
}

const BLOCK_STATUS = ["processed", "confirmed", "finalized"];
const EXPLORER_MAX_BLOCKS_PER_CALL = 20;

function mapBlock(d) {
  const worker = d.worker && typeof d.worker === "object" ? d.worker : {};
  const txs = Array.isArray(d.transaction) ? d.transaction.map((h) => String(h)) : [];
  return {
    status: d.status,
    statusText: BLOCK_STATUS[d.status] || "unknown",
    version: d.version,
    chainid: d.chainid,
    number: requireU64(d.blocknumber, "blocknumber"),
    hash: d.blockhash,
    timestamp: requireU64(d.timestamp, "timestamp"),
    workerAddress: worker.address || "",
    workerPublicKey: worker.public_key || "",
    previousHash: d.previous_blockhash,
    stateRoot: optText(d.state_root),
    transactionRoot: optText(d.transaction_root),
    powerUsed: optU64(d.power_used, "power_used"),
    powerLimit: optU64(d.power_limit, "power_limit"),
    feesCollected: optDec(d.fees_collected, "fees_collected"),
    tipsCollected: optDec(d.tips_collected, "tips_collected"),
    txCount: d.transaction_count != null ? Number(requireU64(d.transaction_count, "transaction_count")) : txs.length,
    transactions: txs,
    signature: d.signature,
  };
}

async function getLatestBlockNumber() {
  const d = await rpcJson("block_number", { method: "GET" });
  return requireU64(d.block_number, "block_number");
}

async function getBlock(number) {
  const n = toU64(number, "Block number");
  return mapBlock(await rpcJson("block/" + n.toString(), { method: "GET" }));
}

async function getBlockSummaries(numbers) {
  if (!Array.isArray(numbers)) throw new Error("numbers must be an array");
  const list = numbers.slice(0, EXPLORER_MAX_BLOCKS_PER_CALL).map((n) => toU64(n, "Block number"));
  const settled = await Promise.allSettled(list.map((n) => getBlock(n)));
  const out = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const b = r.value;
    out.push({
      number: b.number, hash: b.hash, timestamp: b.timestamp, txCount: b.txCount,
      workerAddress: b.workerAddress, statusText: b.statusText, powerUsed: b.powerUsed, powerLimit: b.powerLimit,
    });
  }
  return out;
}

async function getAccountExplorer(address) {
  const addr = normalizeAddress(address);
  try {
    const d = await rpcJson("account/" + addr, { method: "GET" });
    const nonce = requireU64(d.nonce, "nonce");
    return {
      found: true,
      address: addr,
      balance: requireDec(d.balance, "balance"),
      nonce,
      pendingNonce: d.pending_nonce != null ? requireU64(d.pending_nonce, "pending_nonce") : nonce,
    };
  } catch (e) {
    if (e instanceof RpcError && e.status === 404) {
      return { found: false, address: addr, balance: "0", nonce: "0", pendingNonce: "0" };
    }
    throw e;
  }
}

function normalizeRpcUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error("Invalid URL. Example: https://alpha.lenarchain.xyz");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("URL must start with http:// or https://");
  if (u.username || u.password) throw new Error("URL must not contain a username/password");
  if (u.search || u.hash) throw new Error("URL must not contain a query (?...) or fragment (#...)");
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.href;
}

async function probeRpc(base, expectedChainId) {
  const t0 = Date.now();
  const c = await rpcJsonAt(base, "chainid", { method: "GET" });
  const nodeChainId = parseChainId(c.chainid, "Node chain ID");
  if (expectedChainId != null && nodeChainId !== expectedChainId) {
    throw new Error(`Node chain ID (${nodeChainId}) does not match the Chain ID you entered (${expectedChainId}).`);
  }
  const b = await rpcJsonAt(base, "block_number", { method: "GET" });
  return { url: base, chainid: nodeChainId, blockNumber: requireU64(b.block_number, "block_number"), latencyMs: Date.now() - t0 };
}

function networkView(n) {
  return { id: n.id, name: n.name, type: n.type, url: n.rpcUrl, chainId: n.chainId, symbol: n.symbol, builtin: !!n.builtin };
}

async function getNetworkConfig() {
  const { all, activeId } = await loadNetworks();
  const active = all.find((n) => n.id === activeId) || all[0];
  return { ...networkView(active), activeId: active.id, networks: all.map(networkView) };
}

async function testNetwork({ url, chainId } = {}) {
  const base = url ? normalizeRpcUrl(url) : await getRpcUrl();
  const expected = chainId == null || chainId === "" ? null : parseChainId(chainId);
  return probeRpc(base, expected);
}

function validateNetworkName(name) {
  const n = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  if (!n) throw new Error("Network name cannot be empty.");
  if (n.length > NETWORK_NAME_MAX) throw new Error(`Network name is too long (max ${NETWORK_NAME_MAX} characters).`);
  if (/[\u0000-\u001f\u007f<>]/.test(n)) throw new Error("Network name contains characters that are not allowed.");
  return n;
}

async function saveNetwork({ id, name, type, url, chainId, symbol }) {
  const cleanName = validateNetworkName(name);
  if (!NETWORK_TYPES.includes(type)) throw new Error("Network type must be Mainnet or Testnet.");
  const base = normalizeRpcUrl(url);
  const sym = String(symbol == null ? "" : symbol).trim();
  if (!SYMBOL_RE.test(sym)) throw new Error("Symbol must be 1-12 letters or digits (A-Z, 0-9).");
  const expected = chainId == null || chainId === "" ? null : parseChainId(chainId);

  const { all, custom, activeId } = await loadNetworks();
  if (id === DEFAULT_NETWORK.id) throw new Error("The built-in network cannot be edited.");
  if (id != null && !custom.some((n) => n.id === id)) throw new Error("Network not found.");
  if (id == null && custom.length >= MAX_NETWORKS) throw new Error(`You can add up to ${MAX_NETWORKS} networks.`);
  if (all.some((n) => n.id !== id && n.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error(`A network named "${cleanName}" already exists.`);
  }

  const info = await probeRpc(base, expected);
  if (all.some((n) => n.id !== id && n.rpcUrl === base && n.chainId === info.chainid)) {
    throw new Error("This RPC URL and Chain ID are already saved as another network.");
  }
  const entry = { id: id || crypto.randomUUID(), name: cleanName, type, rpcUrl: base, chainId: info.chainid, symbol: sym, builtin: false };
  const nextCustom = id ? custom.map((n) => (n.id === id ? entry : n)) : [...custom, entry];
  await saveNetworks(nextCustom, id ? activeId : entry.id);
  return { ...info, symbol: sym, network: networkView(entry), config: await getNetworkConfig() };
}

async function switchNetwork(id) {
  const { all, custom } = await loadNetworks();
  const target = all.find((n) => n.id === id);
  if (!target) throw new Error("Network not found.");
  await saveNetworks(custom, target.id);
  return getNetworkConfig();
}

async function deleteNetwork(id) {
  if (id === DEFAULT_NETWORK.id) throw new Error("The built-in network cannot be deleted.");
  const { custom, activeId } = await loadNetworks();
  if (!custom.some((n) => n.id === id)) throw new Error("Network not found.");
  const removed = custom.find((n) => n.id === id);
  const rest = custom.filter((n) => n.id !== id);
  await saveNetworks(rest, activeId === id ? DEFAULT_NETWORK.id : activeId);
  try {
    const origin = new URL(removed.rpcUrl).origin;
    const stillUsed = [DEFAULT_NETWORK, ...rest].some((n) => new URL(n.rpcUrl).origin === origin);
    if (!stillUsed && chrome.permissions && chrome.permissions.remove) await chrome.permissions.remove({ origins: [origin + "/*"] });
  } catch (e) { console.warn("Could not revoke host permission:", errMsg(e)); }
  return getNetworkConfig();
}

const PENDING_BROADCASTS_KEY = "pendingBroadcasts";
const PENDING_BROADCAST_TTL_MS = 24 * 60 * 60 * 1000; // an unverifiable record is dropped after a day
const PENDING_REFRESH_MS = 4000;

function parseUnits256(value, name) {
  let v;
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new Error(`${name} is not a valid integer.`);
  try { v = typeof value === "bigint" ? value : BigInt(value); } catch { throw new Error(`${name} is not a valid integer.`); }
  if (v < 0n) throw new Error(`${name} cannot be negative.`);
  if (v > U256_MAX) throw new Error(`${name} exceeds the uint256 limit.`);
  return v;
}

async function validateTxParams(p, ctx) {
  if (!p || typeof p !== "object") throw new Error("Invalid transaction.");
  rejectLegacyPrefix(p.to, "Destination address");
  if (!/^[0-9a-fA-F]{40}$/.test(stripPrefix(p.to))) throw new Error("Destination address must be 20 bytes of hex (40 characters).");
  const amount = parseUnits256(p.amount, "Amount");
  const tip = parseUnits256(p.tip, "Tip");
  if (amount <= 0n) throw new Error("Amount must be greater than 0.");

  const base = ctx.net.rpcUrl;
  const [price, account, chainRes] = await Promise.all([
    getPowerPrice(base), getAccount(ctx.address, base), rpcJsonAt(base, "chainid", { method: "GET" }),
  ]);
  const nodeChainId = parseChainId(chainRes.chainid, "Node chain ID");
  if (nodeChainId !== ctx.net.chainId) {
    throw new Error(`Node chain ID (${nodeChainId}) does not match the Chain ID of "${ctx.net.name}" (${ctx.net.chainId}). Check Settings > Network. Transaction cancelled.`);
  }
  const fee = price * TRANSFER_POWER;
  if (fee > MAX_FEE) {
    throw new Error("Fee from the node is too high (" + fee + "). The node may be untrustworthy; transaction cancelled.");
  }
  if (tip > MAX_TIP) {
    throw new Error("Tip is too high (" + tip + "); transaction cancelled.");
  }
  if (BigInt(account.balance) < amount + tip + fee) {
    throw new Error("Insufficient balance for amount + tip + fee.");
  }
  return { account, price, fee, amount, tip, chainId: ctx.net.chainId };
}

const pendingKey = (address, net) => `${net.chainId}@${hostOf(net.rpcUrl)}:${address}`;
const PENDING_KEY_VERSION = 2;
async function loadPendingBroadcasts() {
  const d = await storageGet([PENDING_BROADCASTS_KEY, "pendingKeyVersion"]);
  const raw = d[PENDING_BROADCASTS_KEY];
  const m = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (d.pendingKeyVersion !== PENDING_KEY_VERSION) {
    for (const [k, rec] of Object.entries(m)) {
      if (!rec || typeof rec !== "object" || k.includes("@")) continue;
      if (typeof rec.rpcUrl !== "string" || typeof rec.address !== "string" || !Number.isInteger(rec.chainId)) continue;
      const nk = pendingKey(rec.address, { chainId: rec.chainId, rpcUrl: rec.rpcUrl });
      rec.key = nk;
      if (!m[nk]) m[nk] = rec;
      delete m[k];
    }
    await storageSet({ [PENDING_BROADCASTS_KEY]: m, pendingKeyVersion: PENDING_KEY_VERSION });
  }
  return m;
}
async function setPendingBroadcast(rec) {
  const m = await loadPendingBroadcasts();
  m[rec.key] = rec;
  await storageSet({ [PENDING_BROADCASTS_KEY]: m });
}
async function clearPendingBroadcast(key) {
  const m = await loadPendingBroadcasts();
  if (Object.hasOwn(m, key)) { delete m[key]; await storageSet({ [PENDING_BROADCASTS_KEY]: m }); }
}

async function checkBroadcast(rec) {
  try {
    const detail = await getTransactionDetail(rec.hash, rec.rpcUrl);
    return { state: "landed", detail };
  } catch (e) {
    if (!(e instanceof RpcError && e.status === 404)) return { state: "unknown" };
  }
  try {
    const acc = await getAccount(rec.address, rec.rpcUrl);
    return BigInt(acc.nonce) > BigInt(rec.nonce) ? { state: "nonce-used" } : { state: "absent" };
  } catch {
    return { state: "unknown" };
  }
}

async function settlePreviousBroadcast(rec) {
  const st = await checkBroadcast(rec);
  if (st.state === "landed" || st.state === "nonce-used") {
    await clearPendingBroadcast(rec.key);
    if (st.state === "landed") {
      await safeHistoryUpdate(rec.address, recNet(rec), rec.hash, { status: st.detail.txStatusText });
    }
    const what = st.state === "landed"
      ? `was already included in a block (status: ${st.detail.txStatusText})`
      : "was accepted by the node";
    throw new WalletError(
      `Your previous transaction ${what}, so it was NOT sent again. Hash: ${rec.hash}. Check History; send again only if you really want a second transfer.`,
      "PREVIOUS_TX_ACCEPTED", { txHash: rec.hash });
  }
  if (st.state === "unknown") {
    if (Date.now() - rec.createdAt > PENDING_BROADCAST_TTL_MS) { await clearPendingBroadcast(rec.key); return; }
    throw new WalletError(
      `The status of your previous transaction could not be checked (node unreachable). Sending again now could pay twice. Wait a moment and retry. Hash: ${rec.hash}`,
      "BROADCAST_UNCERTAIN", { txHash: rec.hash });
  }
  await clearPendingBroadcast(rec.key);
  await safeHistoryUpdate(rec.address, recNet(rec), rec.hash, { status: "pending", unverifiedAt: Date.now() });
}
const recNet = (rec) => ({ chainId: rec.chainId, rpcUrl: rec.rpcUrl });

async function safeHistoryRecord(entry, address, net) {
  try { await recordHistoryEntry(entry, address, net); } catch (e) { console.warn("Failed to save local history:", errMsg(e)); }
}
async function safeHistoryUpdate(address, net, txHash, patch) {
  try { await updateHistoryEntry(address, net, txHash, patch); } catch (e) { console.warn("Failed to update local history:", errMsg(e)); }
}

async function assertNodePermission(base) {
  if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.contains) return;
  const origin = new URL(base).origin;
  if (!(await chrome.permissions.contains({ origins: [origin + "/*"] }))) {
    throw new WalletError(
      `Access to ${origin} was revoked, so the transaction was NOT sent. Open Settings > Network, select this network and press Save to grant access again.`,
      "NO_HOST_PERMISSION");
  }
}

let sendInFlight = false;

async function sendTransaction(txParams) {
  if (sendInFlight) throw new Error("Another transaction is being sent. Wait for it to finish.");
  sendInFlight = true;
  try {
    return await sendTransactionOnce(txParams);
  } finally {
    sendInFlight = false;
  }
}

async function sendTransactionOnce(txParams) {
  const ctx = await getSigningContext();
  const base = ctx.net.rpcUrl;
  await assertNodePermission(base);
  const { account, price, fee, amount, tip, chainId } = await validateTxParams(txParams, ctx);

  const key = pendingKey(ctx.address, ctx.net);
  const legacyKey = `${chainId}:${ctx.address}`;
  const pend = await loadPendingBroadcasts();
  const found = pend[key] ? [key, pend[key]] : pend[legacyKey] ? [legacyKey, pend[legacyKey]] : null;
  if (found) await settlePreviousBroadcast({ ...found[1], key: found[0] });

  const toHex = stripPrefix(txParams.to).toLowerCase();
  const signedBodyHex = await signTx({ ctx, chainId, to: toHex, nonce: account.nonce, amount, tip, pricePerPower: price });
  const bodyBytes = hexToBytes(signedBodyHex);
  if (!verify_transaction(signedBodyHex)) throw new Error("Signature self-check failed. Transaction cancelled.");
  const localHash = toRx(tx_hash_hex(signedBodyHex));

  const rec = {
    key, hash: localHash, nonce: account.nonce, address: ctx.address, chainId, rpcUrl: base,
    to: toHex, amount: amount.toString(), tip: tip.toString(), fee: fee.toString(), createdAt: Date.now(),
  };
  await assertNodePermission(base);
  await setPendingBroadcast(rec);
  const historyEntry = (status, feeText) => ({
    to: toHex, amount: amount.toString(), fee: feeText, tip: tip.toString(), status, txHash: localHash,
    timestamp: Math.floor(Date.now() / 1000),
  });

  let res;
  try {
    res = await rpcJsonAt(base, "send_transaction", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bodyBytes,
    });
  } catch (e) {
    if (e instanceof RpcError && e.status >= 400 && e.status < 500) {
      await clearPendingBroadcast(key);
      throw e;
    }
    await safeHistoryRecord(historyEntry("pending", fee.toString()), ctx.address, ctx.net);
    throw new WalletError(
      `The node did not confirm the transaction, so it may or may not have been sent. Do NOT send it again yet: open it in History to check its status. Hash: ${localHash}`,
      "BROADCAST_UNCERTAIN", { txHash: localHash });
  }
  const nodeHash = String(res.hash).toLowerCase();
  if (nodeHash !== localHash) {
    await safeHistoryRecord(historyEntry("pending", fee.toString()), ctx.address, ctx.net);
    throw new WalletError(
      `Hash from the node (${nodeHash}) differs from the local hash (${localHash}). The transaction may already have been sent, check manually.`,
      "BROADCAST_UNCERTAIN", { txHash: localHash });
  }
  await clearPendingBroadcast(key);
  await safeHistoryRecord(historyEntry("pending", fee.toString()), ctx.address, ctx.net);

  let detail = null;
  try {
    detail = await waitTxResult(localHash, base, 3);
  } catch (e) {
    console.warn("Tx polling not final yet:", errMsg(e));
  }
  const feeText = detail && /^\d+$/.test(detail.fee) ? detail.fee : fee.toString();
  if (detail) await safeHistoryUpdate(ctx.address, ctx.net, localHash, { status: detail.txStatusText, fee: feeText });

  let powerWarning = null;
  if (detail && /^\d+$/.test(detail.power) && detail.power !== TRANSFER_POWER.toString()) {
    powerWarning = `The node recorded power ${detail.power} for this transfer, but this wallet assumes ${TRANSFER_POWER}. Fees and balance checks may be wrong; update the wallet.`;
    console.warn(powerWarning);
  }
  return {
    txHash: localHash,
    status: detail ? detail.txStatusText : "pending",
    fee: feeText,
    detail,
    from: ctx.address,
    networkId: ctx.net.id,
    powerWarning,
  };
}

async function waitTxResult(txHash, base, maxTry = POLL_MAX_TRY) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    try {
      const detail = await getTransactionDetail(txHash, base);
      if (isFinalStatus(detail.txStatus)) return detail;
    } catch (e) {
      if (e instanceof RpcError && e.status === 400) throw e;
      lastErr = e;
    }
    if (attempt < maxTry - 1) await sleep(POLL_DELAY_MS); // no pointless sleep after the last try
  }
  throw new Error(
    "Transaction was not included in a block after " + (maxTry * POLL_DELAY_MS / 1000) + " seconds" +
    (lastErr ? " (last error: " + errMsg(lastErr) + ")" : "") +
    ". tx_hash: " + txHash
  );
}

const wasmReady = init().catch((e) => {
  console.error("Failed to init wasm:", e);
  throw e;
});
wasmReady.catch(() => {});

let DEFAULT_PATH = null;
async function ensureWasm() {
  await wasmReady;
  if (DEFAULT_PATH === null) DEFAULT_PATH = build_hardened_path(COIN_TYPE, 0);
}

const SESSION_KEY = "session";
const LOCK_ALARM = "zecowallet-autolock";

function getSessionStorage() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.session) {
    throw new Error("chrome.storage.session is not available (requires Chrome 102+ and the \"storage\" permission).");
  }
  return chrome.storage.session;
}

(async () => {
  try { await getSessionStorage().setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); }
  catch (e) { console.warn("Could not pin the session access level:", errMsg(e)); }
})();

function scheduleLockAlarm() {
  if (chrome.alarms) chrome.alarms.create(LOCK_ALARM, { when: Date.now() + AUTO_LOCK_MS });
}
function clearLockAlarm() {
  if (chrome.alarms) chrome.alarms.clear(LOCK_ALARM);
}

async function saveSession(mnemonics) {
  await getSessionStorage().set({ [SESSION_KEY]: { mnemonics, lockAt: Date.now() + AUTO_LOCK_MS } });
  scheduleLockAlarm();
}

async function readSession() {
  const data = await getSessionStorage().get([SESSION_KEY]);
  const s = data[SESSION_KEY];
  if (!s || !s.mnemonics) return null;
  if (Date.now() >= s.lockAt) { await lockWallet(); return null; }
  return s;
}

async function touchSession(s) {
  s.lockAt = Date.now() + AUTO_LOCK_MS;
  await getSessionStorage().set({ [SESSION_KEY]: s });
  scheduleLockAlarm();
}

async function lockWallet() {
  await getSessionStorage().remove(SESSION_KEY);
  clearLockAlarm();
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LOCK_ALARM) readSession().catch(() => {});
  });
}

async function getSessionStatus() {
  const s = await readSession();
  if (!s) return { unlocked: false };
  await touchSession(s);
  const { address, wallets, activeId } = await storageGet(["address", "wallets", "activeId"]);
  const active = (wallets || []).find((w) => w.id === activeId);
  return { unlocked: true, address, name: active ? active.name : WALLET_MAIN_NAME };
}

const WALLET_MAIN_NAME = "Main Wallet";
const LEGACY_WALLET_ID = "w1";
const MIN_PASSWORD_LEN = 10;
const PBKDF2_ITERATIONS = 600000;
const LEGACY_PBKDF2_ITERATIONS = 310000;
const VAULT_VERSION = 3;

async function deriveKeyFromPassword(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(text, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text)
  );
  return {
    iterations: PBKDF2_ITERATIONS,
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
}

async function decryptText({ salt, iv, ciphertext, iterations }, password) {
  const it = iterations == null ? LEGACY_PBKDF2_ITERATIONS : Number(iterations);
  if (!Number.isInteger(it) || it < 100000 || it > 2000000) throw new Error("Vault parameters are invalid.");
  const key = await deriveKeyFromPassword(password, new Uint8Array(salt), it);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ciphertext)
    );
  } catch {
    throw new Error("Incorrect password");
  }
  return new TextDecoder().decode(plain);
}

async function encryptVault(wallets, password) {
  const enc = await encryptText(JSON.stringify({ wallets }), password);
  return { version: VAULT_VERSION, ...enc };
}

async function decryptVault(vault, password) {
  if (!vault) throw new Error("No wallet yet");
  const plain = await decryptText(vault, password);
  if (vault.version >= 2) {
    const data = JSON.parse(plain);
    if (!data || !Array.isArray(data.wallets) || data.wallets.length === 0) throw new Error("Vault is corrupted");
    return data.wallets;
  }
  return [{ id: LEGACY_WALLET_ID, mnemonic: plain }]; // v1
}

async function previewNewWallet() {
  await ensureWasm();
  return generate_mnemonic(12);
}

async function validateMnemonicPhrase(mnemonic) {
  await ensureWasm();
  return typeof mnemonic === "string" && mnemonic.length > 0 && validate_mnemonic(mnemonic);
}

function newWalletId() { return crypto.randomUUID(); }

function mnemonicMap(list) {
  return Object.fromEntries(list.map((w) => [w.id, w.mnemonic]));
}

async function finalizeWallet(mnemonic, password) {
  await ensureWasm();
  if (!validate_mnemonic(mnemonic)) throw new Error("Recovery phrase is invalid");
  if (!password || password.length < MIN_PASSWORD_LEN) throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  if (await hasWallet()) throw new Error("A wallet already exists. Use Add Wallet.");
  const id = newWalletId();
  const address = derive_address(mnemonic, "", DEFAULT_PATH, ADDRESS_PREFIX);
  const vault = await encryptVault([{ id, mnemonic }], password);
  await storageSet({ vault, wallets: [{ id, name: WALLET_MAIN_NAME, address }], activeId: id, address });
  await saveSession({ [id]: mnemonic });
  return { address, name: WALLET_MAIN_NAME };
}

async function importWallet(mnemonic, password) {
  await ensureWasm();
  if (!validate_mnemonic(mnemonic)) throw new Error("Recovery phrase is invalid");
  return finalizeWallet(mnemonic, password);
}

async function hasWallet() {
  const { vault } = await storageGet(["vault"]);
  return !!vault;
}

async function getWallets() {
  const s = await readSession();
  if (!s) throw lockedError();
  await touchSession(s);
  const { wallets, activeId } = await storageGet(["wallets", "activeId"]);
  return { wallets: wallets || [], activeId };
}

async function addWallet(mnemonic, password) {
  await ensureWasm();
  const s = await readSession();
  if (!s) throw lockedError();
  if (!validate_mnemonic(mnemonic)) throw new Error("Recovery phrase is invalid");
  const { vault, wallets } = await storageGet(["vault", "wallets"]);
  const meta = wallets || [];
  const list = await decryptVault(vault, password); // wrong password -> throws
  const address = derive_address(mnemonic, "", DEFAULT_PATH, ADDRESS_PREFIX);
  if (meta.some((w) => w.address === address)) throw new Error("This wallet already exists");

  const id = newWalletId();
  const name = `Wallet ${meta.length + 1}`;
  const newVault = await encryptVault([...list, { id, mnemonic }], password);
  await storageSet({ vault: newVault, wallets: [...meta, { id, name, address }], activeId: id, address });
  await saveSession({ ...s.mnemonics, [id]: mnemonic });
  return { id, name, address };
}

async function switchWallet(id) {
  const s = await readSession();
  if (!s) throw lockedError();
  const { wallets } = await storageGet(["wallets"]);
  const w = (wallets || []).find((x) => x.id === id);
  if (!w) throw new Error("Wallet not found");
  if (!s.mnemonics[id]) throw new Error("Wallet is not unlocked yet, lock and unlock again");
  await storageSet({ activeId: id, address: w.address });
  await touchSession(s);
  return { id, name: w.name, address: w.address };
}

async function revealMnemonic(password) {
  await ensureWasm();
  const { vault, activeId } = await storageGet(["vault", "activeId"]);
  const list = await decryptVault(vault, password);
  const w = list.find((x) => x.id === activeId);
  if (!w) throw new Error("Active wallet not found. Lock and unlock the wallet, then try again.");
  return w.mnemonic;
}

async function exportPrivateKey(password) {
  await ensureWasm();
  const mnemonic = await revealMnemonic(password);
  return derive_ed25519_privkey_hex(mnemonic, "", DEFAULT_PATH);
}

async function unlockWallet(password) {
  await ensureWasm();
  const { vault, wallets, activeId } = await storageGet(["vault", "wallets", "activeId"]);
  const list = await decryptVault(vault, password);
  const names = new Map((wallets || []).map((w) => [w.id, w.name]));
  const meta = list.map((w, i) => ({
    id: w.id,
    name: names.get(w.id) || (i === 0 ? WALLET_MAIN_NAME : `Wallet ${i + 1}`),
    address: derive_address(w.mnemonic, "", DEFAULT_PATH, ADDRESS_PREFIX),
  }));
  const active = meta.find((w) => w.id === activeId) || meta[0];
  const patch = { wallets: meta, activeId: active.id, address: active.address };
  if (vault.version !== VAULT_VERSION) patch.vault = await encryptVault(list, password); // migrate to current version
  await storageSet(patch);

  await saveSession(mnemonicMap(list));
  return { address: active.address, name: active.name };
}

async function getSigningContext() {
  const s = await readSession();
  if (!s) throw lockedError();
  await touchSession(s);
  const { activeId, address } = await storageGet(["activeId", "address"]);
  const mnemonic = activeId ? s.mnemonics[activeId] : null;
  if (!mnemonic) throw new Error("Active wallet not found, lock and unlock again");
  if (!address) throw new Error("Wallet address not found.");
  const net = await getNetwork();
  return { mnemonic, activeId, address, net };
}

function assertSignerMatches(ctx) {
  if (derive_address(ctx.mnemonic, "", DEFAULT_PATH, ADDRESS_PREFIX) !== ctx.address) {
    throw new Error("The active wallet changed while the request was prepared. Nothing was signed.");
  }
}

async function signTx({ ctx, chainId, to, nonce, amount, tip, pricePerPower }) {
  await ensureWasm();
  assertSignerMatches(ctx);
  return sign_transaction(
    ctx.mnemonic, "", DEFAULT_PATH,
    chainId, 0, stripPrefix(to), toU64(nonce, "nonce"),
    u256ToHex(amount, "amount"), TRANSFER_POWER, TRANSFER_POWER,
    u256ToHex(pricePerPower, "price_per_power"), u256ToHex(tip, "tip")
  );
}

function checkMessage(message) {
  if (typeof message !== "string" || message.trim().length === 0) throw new Error("Message cannot be empty.");
  if (new TextEncoder().encode(message).length > MAX_SIGN_MSG_BYTES) {
    throw new Error(`Message is too long (max ${MAX_SIGN_MSG_BYTES} bytes).`);
  }
}

async function signMsg(message) {
  checkMessage(message);
  await ensureWasm();
  const ctx = await getSigningContext();
  assertSignerMatches(ctx);
  return sign_message(ctx.mnemonic, "", DEFAULT_PATH, message, ctx.net.chainId);
}

async function verifyMsg(message, proofHex) {
  checkMessage(message);
  if (typeof proofHex !== "string") throw new Error("Proof cannot be empty.");
  const proof = proofHex.replace(/\s+/g, "").replace(/^rx/i, "");
  if (!proof) throw new Error("Proof cannot be empty.");
  if (!/^[0-9a-fA-F]{208}$/.test(proof)) throw new Error("Proof must be 208 hex characters (104 bytes).");
  await wasmReady; // verify does not need DEFAULT_PATH
  const net = await getNetwork();
  const valid = verify_message(message, net.chainId, proof);
  if (!valid) return { valid: false, chainId: net.chainId, signer: null };
  const publicKey = proof.slice(0, 64).toLowerCase();
  return {
    valid: true,
    chainId: net.chainId,
    signer: {
      address: address_from_pubkey_hex(publicKey, ADDRESS_PREFIX),
      publicKey,
      timestamp: BigInt("0x" + proof.slice(192, 208)).toString(),
    },
  };
}

const HISTORY_KEY_VERSION = 2;
function historyKey(address, net) { return `${net.chainId}@${hostOf(net.rpcUrl)}:${address}`; }
function readHistoryList(map, address, net) {
  const list = map[historyKey(address, net)];
  return Array.isArray(list) ? list : [];
}

let historyLock = Promise.resolve();
function withHistoryLock(fn) {
  const run = historyLock.then(fn, fn);
  historyLock = run.then(() => {}, () => {});
  return run;
}

async function migrateHistoryKeys(map) {
  const { all } = await loadNetworks();
  let orphans = 0;
  for (const key of Object.keys(map)) {
    if (!Array.isArray(map[key]) || key.includes("@")) continue; // not a list, or already in the new format
    const i = key.indexOf(":");
    const netRef = i === -1 ? DEFAULT_NETWORK.id : key.slice(0, i);
    const addr = i === -1 ? key : key.slice(i + 1);
    const net = all.find((n) => n.id === netRef) || (netRef === String(DEFAULT_NETWORK.chainId) ? all[0] : null);
    if (!net || !/^rx[0-9a-f]{40}$/.test(addr)) { orphans++; continue; }
    const nk = historyKey(addr, net);
    if (!Array.isArray(map[nk])) map[nk] = map[key];
    delete map[key];
  }
  return orphans;
}

async function loadHistoryMap() {
  const { txHistoryByAddress, txHistory, address, historyKeyVersion } =
    await storageGet(["txHistoryByAddress", "txHistory", "address", "historyKeyVersion"]);
  const map = txHistoryByAddress && typeof txHistoryByAddress === "object" && !Array.isArray(txHistoryByAddress)
    ? txHistoryByAddress : {};
  return {
    map, address,
    legacyList: Array.isArray(txHistory) ? txHistory : null,
    needsMigration: historyKeyVersion !== HISTORY_KEY_VERSION,
  };
}

async function migrateHistoryIfNeeded() {
  return withHistoryLock(async () => {
    const { map, address, legacyList, needsMigration } = await loadHistoryMap();
    if (!legacyList && !needsMigration) return;
    if (legacyList && address) {
      if (!Array.isArray(map[address])) map[address] = legacyList;
      await getStorage().remove("txHistory");
    }
    const orphans = needsMigration ? await migrateHistoryKeys(map) : 0;
    await storageSet({
      txHistoryByAddress: map,
      ...(needsMigration && !orphans ? { historyKeyVersion: HISTORY_KEY_VERSION } : {}),
    });
  });
}

async function recordHistoryEntry(entry, address, net) {
  await migrateHistoryIfNeeded();
  return withHistoryLock(async () => {
    const { map, address: active } = await loadHistoryMap();
    const addr = address || active;
    const n = net || (await getNetwork());
    const list = readHistoryList(map, addr, n).filter((e) => !(e && entry.txHash && e.txHash === entry.txHash));
    list.unshift({ ...entry, chainId: n.chainId }); // newest first; the same hash is never listed twice
    map[historyKey(addr, n)] = list.slice(0, HISTORY_MAX_ENTRIES);
    await storageSet({ txHistoryByAddress: map });
  });
}

async function updateHistoryEntry(address, net, txHash, patch) {
  await migrateHistoryIfNeeded();
  return withHistoryLock(async () => {
    const { map } = await loadHistoryMap();
    const list = readHistoryList(map, address, net);
    const hash = String(txHash).toLowerCase();
    const entry = list.find((e) => e && typeof e.txHash === "string" && e.txHash.toLowerCase() === hash);
    if (!entry) return false;
    let changed = false;
    if (["pending", "success", "failed"].includes(patch.status) && entry.status !== patch.status) { entry.status = patch.status; changed = true; }
    if (typeof patch.fee === "string" && /^\d+$/.test(patch.fee) && entry.fee !== patch.fee) { entry.fee = patch.fee; changed = true; }
    if (Number.isFinite(patch.unverifiedAt) && entry.unverifiedAt !== patch.unverifiedAt) { entry.unverifiedAt = patch.unverifiedAt; changed = true; }
    if ((patch.status === "success" || patch.status === "failed") && entry.unverifiedAt) { delete entry.unverifiedAt; changed = true; }
    if (changed) await storageSet({ txHistoryByAddress: map });
    return changed;
  });
}

async function getTxDetailAndSync(txHash) {
  const detail = await getTransactionDetail(txHash);
  if (isFinalStatus(detail.txStatus)) {
    try {
      const { address } = await storageGet(["address"]);
      const net = await getNetwork();
      if (address) {
        await updateHistoryEntry(address, net, normalizeTxHash(txHash), {
          status: detail.txStatusText,
          fee: /^\d+$/.test(detail.fee) ? detail.fee : undefined,
        });
      }
    } catch (e) { console.warn("Failed to sync history status:", errMsg(e)); }
  }
  return detail;
}

async function refreshPendingEntries(list, address, net) {
  const pending = list.filter((e) => e && e.status === "pending" && typeof e.txHash === "string").slice(0, 5);
  if (!pending.length) return list;
  const results = await Promise.race([
    Promise.allSettled(pending.map((e) => getTransactionDetail(e.txHash, net.rpcUrl))),
    sleep(PENDING_REFRESH_MS).then(() => null),
  ]);
  if (!results) return list;
  const patches = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled" || !isFinalStatus(r.value.txStatus)) return;
    const fee = /^\d+$/.test(r.value.fee) ? r.value.fee : undefined;
    patches.push({ txHash: pending[i].txHash, status: r.value.txStatusText, fee });
    pending[i].status = r.value.txStatusText;
    if (fee) pending[i].fee = fee;
    delete pending[i].unverifiedAt;
  });
  for (const p of patches) await safeHistoryUpdate(address, net, p.txHash, { status: p.status, fee: p.fee });
  return list;
}

async function getHistory() {
  const net = await getNetwork();
  await migrateHistoryIfNeeded();
  const { map, address } = await loadHistoryMap();
  if (!address) return [];
  const list = await refreshPendingEntries(readHistoryList(map, address, net), address, net);
  return list.map((e) => ({ ...e, from: address }));
}
let vaultLock = Promise.resolve();
function withVaultLock(fn) {
  const run = vaultLock.then(fn, fn);
  vaultLock = run.then(() => {}, () => {});
  return run;
}

const HANDLERS = {
  GET_TRAFFIC: async () => ({ traffic: await getTraffic() }),
  GET_ACCOUNT: async (msg) => {
    let addr = msg.address;
    if (!addr) {
      const { address } = await storageGet(["address"]);
      if (!address) throw new Error("Wallet address not found.");
      addr = address;
    }
    return { account: await getAccount(addr) };
  },
  GET_NETWORK: () => getNetworkConfig(),
  TEST_NETWORK: (msg) => testNetwork({ url: msg.url, chainId: msg.chainId }),
  SAVE_NETWORK: (msg) => saveNetwork({ id: msg.id, name: msg.name, type: msg.netType, url: msg.url, chainId: msg.chainId, symbol: msg.symbol }),
  SWITCH_NETWORK: (msg) => switchNetwork(msg.id),
  DELETE_NETWORK: (msg) => deleteNetwork(msg.id),
  EXPLORER_HEAD: async () => ({ blockNumber: await getLatestBlockNumber() }),
  EXPLORER_BLOCKS: async (msg) => ({ blocks: await getBlockSummaries(msg.numbers) }),
  EXPLORER_BLOCK: async (msg) => ({ block: await getBlock(msg.number) }),
  EXPLORER_ACCOUNT: async (msg) => ({ account: await getAccountExplorer(msg.address) }),
  GET_FEE_INFO: async () => ({ info: await getFeeInfo() }),
  GET_TX_DETAIL: async (msg) => ({ detail: await getTxDetailAndSync(msg.txHash) }),
  SEND_TX: (msg) => sendTransaction(msg.tx),
  GET_HISTORY: async () => ({ history: await getHistory() }),
  HAS_WALLET: async () => ({ exists: await hasWallet() }),
  PREVIEW_NEW_WALLET: async () => ({ mnemonic: await previewNewWallet() }),
  VALIDATE_MNEMONIC: async (msg) => ({ valid: await validateMnemonicPhrase(msg.mnemonic) }),
  FINALIZE_WALLET: (msg) => withVaultLock(() => finalizeWallet(msg.mnemonic, msg.password)),
  IMPORT_WALLET: (msg) => withVaultLock(() => importWallet(msg.mnemonic, msg.password)),
  UNLOCK: (msg) => withVaultLock(() => unlockWallet(msg.password)),
  GET_WALLETS: () => getWallets(),
  ADD_WALLET: (msg) => withVaultLock(() => addWallet(msg.mnemonic, msg.password)),
  SWITCH_WALLET: (msg) => switchWallet(msg.id),
  GET_SESSION: () => getSessionStatus(),
  LOCK: async () => { await lockWallet(); return { ok: true }; },
  REVEAL_MNEMONIC: async (msg) => ({ mnemonic: await revealMnemonic(msg.password) }),
  EXPORT_PRIVATE_KEY: async (msg) => ({ privateKey: await exportPrivateKey(msg.password) }),
  SIGN_MESSAGE: async (msg) => ({ proof: await signMsg(msg.message) }),
  VERIFY_MESSAGE: (msg) => verifyMsg(msg.message, msg.proof),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: "Sender not allowed" });
    return false;
  }
  if (!msg || typeof msg.type !== "string") {
    sendResponse({ error: "Invalid message" });
    return false;
  }
  if (!Object.hasOwn(HANDLERS, msg.type)) {
    sendResponse({ error: `Unknown message type: ${msg.type}` });
    return false;
  }
  const reply = (payload) => {
    try { sendResponse(payload); } catch (e) { console.warn("Could not deliver the response (popup closed?):", errMsg(e)); }
  };
  Promise.resolve()
    .then(() => HANDLERS[msg.type](msg))
    .then((payload) => reply(toPlain(payload == null ? {} : payload)))
    .catch((e) => reply(errorResponse(e)));
  return true;
});
