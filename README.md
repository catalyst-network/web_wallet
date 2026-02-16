# Catalyst Wallet (WebWallet)

Greenfield wallet implementation for **Catalyst testnet** (`catalyst-testnet`) following Wallet TX **v1** rules.

## What’s in here

- `packages/catalyst-sdk`: Catalyst v1 encoding + signing + JSON-RPC client (TypeScript)
- `packages/wallet-core`: encrypted vault + account model + tx tracking (TypeScript)
- `apps/wallet-web`: web UI (Vite + React)

## Network defaults

- `network_id`: `catalyst-testnet`
- `chain_id`: `200820092` (`0xbf8457c`)
- `genesis_hash`: `0xeea16848e6b1d39d6b7a5e094ad9189d5382a6a4b19fb95342ef9846258fee5a`
- `RPC_URL`: `http://45.32.177.248:8545`

Wallet verifies chain identity at startup and refuses to sign if mismatched.

## Faucet (dev-only)

In dev builds, the web wallet includes a **“Get testnet funds”** button that uses the deterministic testnet faucet key (`fa…fa`) to submit a normal transfer from the faucet account.

**Do not ship this in production** (use a hosted faucet service instead).

## Dev quickstart

```bash
npm install
npm run dev
```

### If the remote RPC blocks browsers (CORS/IP allowlist)

Use the SSH tunnel described in the handoff doc:

```bash
ssh -N -L 8545:127.0.0.1:8545 root@45.32.177.248
```

Then set the wallet’s RPC URL to `http://127.0.0.1:8545`.

## Tests

```bash
npm test
```

