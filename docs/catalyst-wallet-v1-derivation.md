# Catalyst Wallet v1: mnemonic + key derivation (draft)

This document defines the **Catalyst Wallet v1** deterministic derivation scheme for:

- generating a BIP39 mnemonic (12/24 words)
- deriving a stable wallet seed from mnemonic (+ optional passphrase)
- deriving one or more Catalyst private keys and addresses from the seed

This is **not Ethereum-compatible** at the transaction layer: Catalyst uses **Ristretto Schnorr** and addresses are **32-byte compressed Ristretto public keys**.
However, it is compatible with standard tooling at the **mnemonic/seed** layer via **BIP39**.

## Terminology / constants

- `mnemonic`: BIP39 English mnemonic words
- `passphrase`: optional BIP39 passphrase (advanced; default empty string)
- `seed`: 64 bytes produced by BIP39
- `blake2b512(x)`: BLAKE2b-512 hash of bytes `x`, 64-byte output
- `H512(x)`: alias for `blake2b512(x)`
- `u32le(i)`: 4-byte little-endian encoding of unsigned 32-bit integer `i`

Domain separation (ASCII bytes):

- `DST_MASTER = "CATALYST_WALLET_V1_MASTER"`
- `DST_ACCOUNT = "CATALYST_WALLET_V1_ACCOUNT"`

## 1) Seed from mnemonic (BIP39)

Given:
- `mnemonic` (12 or 24 words)
- `passphrase` (string, optional, default = `""`)

Compute:
- `seed = BIP39(mnemonic, passphrase)` which yields **64 bytes**

Notes:
- BIP39 seed is PBKDF2-HMAC-SHA512 per the BIP39 standard.

## 2) Master key material

Compute:

- `master = H512(DST_MASTER || seed)` (64 bytes)

This `master` is not itself a Catalyst private key. It is key material used to derive account keys.

## 3) Account private key bytes

For `account_index` (u32) starting at `0`, compute:

- `ikm = H512(DST_ACCOUNT || master || u32le(account_index))` (64 bytes)
- `privkey_bytes = ikm[0..32]` (first 32 bytes)

## 4) Catalyst private key scalar

Catalyst uses a 32-byte private key and interprets it as a Ristretto scalar via:

- `scalar = Scalar::from_bytes_mod_order(privkey_bytes)`

Implementation note:
- In TS implementations, interpret `privkey_bytes` as **little-endian** and reduce modulo the Ristretto group order.

## 5) Catalyst public key / address

Compute:

- `P = scalar * G` where `G` is the Ristretto basepoint
- `address_bytes = compress(P)` (32-byte compressed Ristretto encoding)
- `address_hex = "0x" + hex_lower(address_bytes)`

This `address_hex` is the Catalyst wallet “address”.

## 6) Multi-account wallet behavior

A single mnemonic should be able to derive multiple accounts:

- account 0, 1, 2, ... using the scheme above

Wallet UX recommendation:
- show account 0 by default
- allow adding account 1, 2, ...
- provide restore-from-mnemonic that deterministically recreates the same account set

## Security notes

- The wallet must never store mnemonic or private keys unencrypted on disk.
- Always bind transaction signatures to `chain_id` and `genesis_hash` (see Wallet TX v1 rules).

