use anyhow::{Context, Result};
use catalyst_core::protocol::{
    encode_wire_tx_v1, transaction_signing_payload_v1, tx_id_v1, AggregatedSignature, EntryAmount,
    Transaction, TransactionCore, TransactionEntry, TransactionType,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Vectors {
    chain_id_hex: String,
    genesis_hash_hex: String,
    tx: TxVector,
}

#[derive(Debug, Deserialize)]
struct TxVector {
    tx_type: String,
    nonce: u64,
    lock_time: u32,
    fees: u64,
    entries: Vec<EntryVector>,
    data_hex: String,
    timestamp: u64,
    signature_hex: String,
}

#[derive(Debug, Deserialize)]
struct EntryVector {
    public_key_hex: String,
    amount: i64,
}

fn strip0x(s: &str) -> &str {
    s.strip_prefix("0x").unwrap_or(s)
}

fn decode_hex<const N: usize>(hex_str: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(strip0x(hex_str)).with_context(|| format!("decode hex: {hex_str}"))?;
    if bytes.len() != N {
        anyhow::bail!("expected {N} bytes, got {}", bytes.len());
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: cargo run -- <path/to/v1_vectors.json>")?;

    let raw = std::fs::read_to_string(&path).with_context(|| format!("read {path}"))?;
    let v: Vectors = serde_json::from_str(&raw).context("parse json vectors")?;

    let chain_id = u64::from_str_radix(strip0x(&v.chain_id_hex), 16)
        .with_context(|| format!("parse chain_id_hex {}", v.chain_id_hex))?;
    let genesis_hash = decode_hex::<32>(&v.genesis_hash_hex)?;

    let tx_type = match v.tx.tx_type.as_str() {
        "NonConfidentialTransfer" => TransactionType::NonConfidentialTransfer,
        other => anyhow::bail!("unsupported tx_type: {other}"),
    };

    let data = hex::decode(strip0x(&v.tx.data_hex)).context("decode data_hex")?;
    let sig = hex::decode(strip0x(&v.tx.signature_hex)).context("decode signature_hex")?;

    let entries = v
        .tx
        .entries
        .iter()
        .map(|e| {
            Ok(TransactionEntry {
                public_key: decode_hex::<32>(&e.public_key_hex)?,
                amount: EntryAmount::NonConfidential(e.amount),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let core = TransactionCore {
        tx_type,
        entries,
        nonce: v.tx.nonce,
        lock_time: v.tx.lock_time,
        fees: v.tx.fees,
        data,
    };

    let tx = Transaction {
        core: core.clone(),
        signature: AggregatedSignature(sig),
        timestamp: v.tx.timestamp,
    };

    let signing_payload = transaction_signing_payload_v1(&core, tx.timestamp, chain_id, genesis_hash)
        .map_err(|e| anyhow::anyhow!("signing_payload_v1: {e}"))?;
    let wire = encode_wire_tx_v1(&tx).map_err(|e| anyhow::anyhow!("encode_wire_tx_v1: {e}"))?;
    let txid = tx_id_v1(&tx).map_err(|e| anyhow::anyhow!("tx_id_v1: {e}"))?;

    let out = serde_json::json!({
        "chain_id_u64": chain_id,
        "genesis_hash_hex": format!("0x{}", hex::encode(genesis_hash)),
        "signing_payload_v1_hex": format!("0x{}", hex::encode(signing_payload)),
        "wire_tx_v1_hex": format!("0x{}", hex::encode(wire)),
        "tx_id_v1_hex": format!("0x{}", hex::encode(txid)),
    });

    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

