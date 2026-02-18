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
- `RPC_URL` (default EU + failover):
  - `https://testnet-eu-rpc.catalystnet.org`
  - `https://testnet-us-rpc.catalystnet.org`
  - `https://testnet-asia-rpc.catalystnet.org`

Wallet verifies chain identity at startup and refuses to sign if mismatched.

## Faucet (dev-only)

In dev builds, you can enable a **“Get testnet funds”** button that uses the deterministic testnet faucet key (`fa…fa`) to submit a normal transfer from the faucet account.

**Do not ship this in production** (use a hosted faucet service instead).

Enable it explicitly:

```bash
VITE_ENABLE_DEV_FAUCET=true npm run dev
```

## Dev quickstart

```bash
npm install
npm run dev
```

### If the remote RPC blocks browsers (CORS/IP allowlist)

Use the dev server’s same-origin RPC proxy:

```bash
VITE_RPC_TARGET=https://testnet-eu-rpc.catalystnet.org npm run dev
```

Then set the wallet’s RPC URL to `"/rpc"` in the UI.

## Tests

```bash
npm test
```

