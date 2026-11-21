use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::Sha512;
use tiny_keccak::{Hasher, Keccak};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};
type HmacSha512 = Hmac<Sha512>;

const TX_DOMAIN: [u8; 1] = [1];
const MESSAGE_DOMAIN: &[u8] = b"\x00I signing this message";
const TX_VERSION: u8 = 1;
const TX_UNSIGNED_LEN: usize = 179;
const TX_BODY_LEN: usize = 243;
const MSG_PROOF_LEN: usize = 104;
const HARDENED_OFFSET: u32 = 0x8000_0000;
const MAX_PATH_DEPTH: usize = 10;

const _: () = assert!(1 + 4 + 1 + 32 + 20 + 8 + 32 + 8 + 8 + 32 + 1 + 32 == TX_UNSIGNED_LEN);
const _: () = assert!(TX_UNSIGNED_LEN + 64 == TX_BODY_LEN);

fn js_err(msg: String) -> JsValue {
	js_sys::Error::new(&msg).into()
}

#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
	console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn generate_mnemonic(word_count: u32) -> Result<String, JsValue> {
	let wc = match word_count {
		12 | 15 | 18 | 21 | 24 => word_count as usize,
		_ => return Err(js_err(format!("word_count must be 12, 15, 18, 21 or 24, got {word_count}"))),
	};
	Mnemonic::generate_in(Language::English, wc)
		.map(|m| m.to_string())
		.map_err(|e| js_err(format!("cannot generate mnemonic: {e}")))
}

#[wasm_bindgen]
pub fn validate_mnemonic(phrase: &str) -> bool {
	Mnemonic::parse_in_normalized(Language::English, phrase).is_ok()
}

fn parse_hardened_path(path: &str) -> Result<Vec<u32>, String> {
	let mut segments = path.split('/');
	if segments.next() != Some("m") {
		return Err("path must start with 'm/'".into());
	}
	let mut out = Vec::new();
	for seg in segments {
		let Some(num_str) = seg.strip_suffix('\'') else {
			return Err(format!(
				"level '{seg}' is not hardened: Ed25519 (SLIP-0010) requires all levels to be hardened"
			));
		};
		if num_str.is_empty() || !num_str.bytes().all(|b| b.is_ascii_digit()) {
			return Err(format!("invalid index: {seg}"));
		}
		let num: u32 = num_str.parse().map_err(|_| format!("invalid index: {seg}"))?;
		if num >= HARDENED_OFFSET {
			return Err(format!("index too large: {seg}"));
		}
		if out.len() >= MAX_PATH_DEPTH {
			return Err(format!("path is too deep (max {MAX_PATH_DEPTH} levels)"));
		}
		out.push(num + HARDENED_OFFSET);
	}
	if out.is_empty() {
		return Err("path needs at least one level, e.g. m/44'/15000'/0'/0'/0'".into());
	}
	Ok(out)
}

fn slip10_finish(mac: HmacSha512) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
	let mut result = mac.finalize().into_bytes();
	let mut il = Zeroizing::new([0u8; 32]);
	let mut ir = Zeroizing::new([0u8; 32]);
	il.copy_from_slice(&result[..32]);
	ir.copy_from_slice(&result[32..]);
	result.as_mut_slice().zeroize();
	(il, ir)
}

fn slip10_master(seed: &[u8]) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
	let mut mac = HmacSha512::new_from_slice(b"ed25519 seed").expect("hmac key ok");
	mac.update(seed);
	slip10_finish(mac)
}

fn slip10_child(private_key: &[u8; 32], chain_code: &[u8; 32], index_hardened: u32) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
	let mut mac = HmacSha512::new_from_slice(chain_code).expect("hmac key ok");
	mac.update(&[0x00u8]);
	mac.update(private_key);
	mac.update(&index_hardened.to_be_bytes());
	slip10_finish(mac)
}

fn derive_priv_seed(phrase: &str, passphrase: &str, path: &str) -> Result<Zeroizing<[u8; 32]>, String> {
	let mnemonic = Mnemonic::parse_in_normalized(Language::English, phrase)
		.map_err(|e| format!("invalid mnemonic: {e}"))?;
	let indices = parse_hardened_path(path)?;
	let seed = Zeroizing::new(mnemonic.to_seed(passphrase));
	let (mut key, mut chain) = slip10_master(&seed[..]);
	for idx in indices {
		let (k, c) = slip10_child(&key, &chain, idx);
		key = k; // the previous key / chain code are wiped when they are dropped here
		chain = c;
	}
	Ok(key)
}

#[wasm_bindgen]
pub fn derive_ed25519_privkey_hex(phrase: &str, passphrase: &str, path: &str) -> Result<String, JsValue> {
	let seed = derive_priv_seed(phrase, passphrase, path).map_err(js_err)?;
	let mut buf = Zeroizing::new([0u8; 64]);
	hex::encode_to_slice(&*seed, &mut buf[..]).map_err(|e| js_err(format!("hex encode failed: {e}")))?;
	let mut out = String::with_capacity(66);
	out.push_str("rx");
	out.push_str(std::str::from_utf8(&buf[..]).expect("hex output is ASCII"));
	Ok(out)
}

fn address_from_pubkey_bytes(pubkey: &[u8; 32], prefix: &str) -> String {
	let hash = keccak256(pubkey);
	format!("{prefix}{}", hex::encode(&hash[12..]))
}

#[wasm_bindgen]
pub fn derive_address(phrase: &str, passphrase: &str, path: &str, prefix: &str) -> Result<String, JsValue> {
	let seed = derive_priv_seed(phrase, passphrase, path).map_err(js_err)?;
	let signing_key = SigningKey::from_bytes(&seed);
	Ok(address_from_pubkey_bytes(&signing_key.verifying_key().to_bytes(), prefix))
}

#[wasm_bindgen]
pub fn address_from_pubkey_hex(pubkey_hex: &str, prefix: &str) -> Result<String, JsValue> {
	let pk: [u8; 32] = decode_hex_fixed(pubkey_hex, "public key").map_err(js_err)?;
	Ok(address_from_pubkey_bytes(&pk, prefix))
}

#[wasm_bindgen]
pub fn build_hardened_path(coin_type: u32, account_index: u32) -> Result<String, JsValue> {
	if coin_type >= HARDENED_OFFSET {
		return Err(js_err(format!("coin_type must be < 2^31, got {coin_type}")));
	}
	if account_index >= HARDENED_OFFSET {
		return Err(js_err(format!("account_index must be < 2^31, got {account_index}")));
	}
	Ok(format!("m/44'/{coin_type}'/0'/0'/{account_index}'"))
}

fn keccak256(data: &[u8]) -> [u8; 32] {
	let mut hasher = Keccak::v256();
	hasher.update(data);
	let mut output = [0u8; 32];
	hasher.finalize(&mut output);
	output
}

fn timestamp_now() -> u64 {
	(js_sys::Date::now() / 1000.0) as u64
}


fn verify_raw_hash(message_hash: &[u8; 32], raw_public_key: &[u8; 32], raw_signature: &[u8; 64]) -> bool {
	let Ok(verifier) = VerifyingKey::from_bytes(raw_public_key) else {
		return false;
	};
	let signature = Signature::from_bytes(raw_signature);
	verifier.verify_strict(message_hash, &signature).is_ok()
}

fn decode_hex_flexible(s: &str) -> Result<Vec<u8>, String> {
	let s = s.strip_prefix("rx").unwrap_or(s);
	if s.is_empty() {return Ok(Vec::new());}
	hex::decode(s).map_err(|e| format!("invalid hex: {e}"))
}

fn decode_hex_fixed<const N: usize>(s: &str, field: &str) -> Result<[u8; N], String> {
	let bytes = decode_hex_flexible(s)?;
	let len = bytes.len();
	bytes
		.try_into()
		.map_err(|_| format!("{field} must be {N} bytes, got {len} bytes"))
}

fn encode_transaction_unsigned(
	chainid: u32,
	action: u8,
	sender: &[u8; 32],
	to: &[u8; 20],
	nonce: u64,
	amount: &[u8; 32],
	power: u64,
	power_limit: u64,
	price_per_power: &[u8; 32],
	packet: u8,
	tip: &[u8; 32],
) -> [u8; TX_UNSIGNED_LEN] {
	let mut out = [0u8; TX_UNSIGNED_LEN];
	let mut pos = 0usize;
	let mut put = |data: &[u8]| {
		out[pos..pos + data.len()].copy_from_slice(data);
		pos += data.len();
	};
	put(&[TX_VERSION]); // u8
	put(&chainid.to_be_bytes()); // u32 byte
	put(&[action]); // u8
	put(sender); // bytes32 or [u8; 32]
	put(to); // address or [u8; 20]
	put(&nonce.to_be_bytes()); // u64 byte
	put(amount); // u256 byte 
	put(&power.to_be_bytes()); // u64 byte
	put(&power_limit.to_be_bytes()); // u64 byte 
	put(price_per_power); // u256 byte
	put(&[packet]); // dynamic bytes data, transfer action is b"\x00" or u8 0
	put(tip); // u256 byte
	// Real assert (also in release builds): a short/long layout must never produce a signature.
	assert_eq!(pos, TX_UNSIGNED_LEN);
	out
}

fn tx_signing_message(unsigned: &[u8; TX_UNSIGNED_LEN]) -> Vec<u8> {
	let mut m = Vec::with_capacity(TX_DOMAIN.len() + TX_UNSIGNED_LEN);
	m.extend_from_slice(&TX_DOMAIN);
	m.extend_from_slice(unsigned);
	m
}

#[allow(clippy::too_many_arguments)]
fn build_signed_tx(seed: &[u8; 32], chainid: u32, action: u8, to: &[u8; 20], nonce: u64, amount: &[u8; 32], power: u64, power_limit: u64, price_per_power: &[u8; 32], tip: &[u8; 32]) -> Result<[u8; TX_BODY_LEN], String> {
	if action != 0 {return Err("only action 0 (transfer) is supported".into());}
	if power_limit < power {return Err("power_limit must be >= power".into());}
	let signing_key = SigningKey::from_bytes(seed);
	let sender = signing_key.verifying_key().to_bytes();
	let unsigned = encode_transaction_unsigned(
		chainid, action, &sender, to, nonce, amount, power, power_limit, price_per_power, 0, tip,
	);
	let to_sign = keccak256(&tx_signing_message(&unsigned));
	let signature = signing_key.sign(&to_sign).to_bytes();
	let mut body = [0u8; TX_BODY_LEN];
	body[..TX_UNSIGNED_LEN].copy_from_slice(&unsigned);
	body[TX_UNSIGNED_LEN..].copy_from_slice(&signature);
	Ok(body)
}

fn verify_tx_body(wire: &[u8]) -> Result<bool, String> {
	if wire.len() != TX_BODY_LEN {return Err(format!("tx body must be {TX_BODY_LEN} bytes, got {} bytes", wire.len()));}
	let unsigned: [u8; TX_UNSIGNED_LEN] = wire[..TX_UNSIGNED_LEN].try_into().unwrap();
	let sig_bytes: [u8; 64] = wire[TX_UNSIGNED_LEN..].try_into().unwrap();
	let sender: [u8; 32] = wire[6..38].try_into().unwrap(); // offset: version(1)+chainid(4)+action(1)
	let Ok(verifier) = VerifyingKey::from_bytes(&sender) else {return Ok(false);};
	let signature = Signature::from_bytes(&sig_bytes);
	let to_sign = keccak256(&tx_signing_message(&unsigned));
	Ok(verifier.verify_strict(&to_sign, &signature).is_ok())
}

fn message_hash(message: &str, chainid: u32, timestamp_be: &[u8; 8]) -> [u8; 32] {
	let mut kec = Keccak::v256();
	kec.update(MESSAGE_DOMAIN);
	kec.update(&chainid.to_be_bytes());
	kec.update(message.as_bytes());
	kec.update(timestamp_be);
	let mut hash = [0u8; 32];
	kec.finalize(&mut hash);
	hash
}

#[wasm_bindgen]
pub fn sign_transaction(
	phrase: &str,
	passphrase: &str,
	path: &str,
	chainid: u32,
	action: u8,
	to_hex: &str,
	nonce: u64,
	amount_hex: &str,
	power: u64,
	power_limit: u64,
	price_per_power_hex: &str,
	tip_hex: &str,
) -> Result<String, JsValue> {
	let seed = derive_priv_seed(phrase, passphrase, path).map_err(js_err)?;
	let to_bytes: [u8; 20] = decode_hex_fixed(to_hex, "to").map_err(js_err)?;
	let amount_bytes: [u8; 32] = decode_hex_fixed(amount_hex, "amount").map_err(js_err)?;
	let price_bytes: [u8; 32] = decode_hex_fixed(price_per_power_hex, "price_per_power").map_err(js_err)?;
	let tip_bytes: [u8; 32] = decode_hex_fixed(tip_hex, "tip").map_err(js_err)?;
	let body = build_signed_tx(
		&seed, chainid, action, &to_bytes, nonce, &amount_bytes, power, power_limit, &price_bytes, &tip_bytes,
	)
	.map_err(js_err)?;
	Ok(hex::encode(body))
}

#[wasm_bindgen]
pub fn verify_transaction(signed_tx_hex: &str) -> Result<bool, JsValue> {
	let wire = decode_hex_flexible(signed_tx_hex).map_err(js_err)?;
	verify_tx_body(&wire).map_err(js_err)
}


#[wasm_bindgen]
pub fn tx_hash_hex(signed_tx_hex: &str) -> Result<String, JsValue> {
	let wire = decode_hex_flexible(signed_tx_hex).map_err(js_err)?;
	if wire.len() != TX_BODY_LEN {return Err(js_err(format!("tx body must be {TX_BODY_LEN} bytes, got {} bytes", wire.len())));}
	Ok(hex::encode(keccak256(&wire)))
}

#[wasm_bindgen]
pub fn sign_message(phrase: &str, passphrase: &str, path: &str, message: &str, chainid: u32) -> Result<String, JsValue> {
	let seed = derive_priv_seed(phrase, passphrase, path).map_err(js_err)?;
	let signer = SigningKey::from_bytes(&seed);
	let public_key = signer.verifying_key().to_bytes();
	let timestamp = timestamp_now();
	let hash = message_hash(message, chainid, &timestamp.to_be_bytes());
	let signature = signer.sign(&hash).to_bytes();
	let mut proof = [0u8; MSG_PROOF_LEN];
	proof[0..32].copy_from_slice(&public_key);
	proof[32..96].copy_from_slice(&signature);
	proof[96..104].copy_from_slice(&timestamp.to_be_bytes());
	Ok(hex::encode(proof))
}

#[wasm_bindgen]
pub fn verify_message(message: &str, chainid: u32, proof_hex: &str) -> Result<bool, JsValue> {
	let proof: [u8; MSG_PROOF_LEN] = decode_hex_fixed(proof_hex, "proof").map_err(js_err)?;
	let pubkey: [u8; 32] = proof[0..32].try_into().unwrap();
	let signature: [u8; 64] = proof[32..96].try_into().unwrap();
	let timestamp: [u8; 8] = proof[96..104].try_into().unwrap();
	let hash = message_hash(message, chainid, &timestamp);
	Ok(verify_raw_hash(&hash, &pubkey, &signature))
}

