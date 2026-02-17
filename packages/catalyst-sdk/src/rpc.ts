import type { CatalystNetworkConfig } from "./network.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown[];
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

export type CatalystSyncInfo = {
  chain_id: string;
  network_id: string;
  genesis_hash: string;
};

export type RpcTransactionRequest = {
  from: string;
  to: string;
  value: string;
  data: string | null;
  gas_limit: string | null;
  gas_price: string | null;
};

export type RpcTxReceipt = {
  status: "pending" | "selected" | "applied" | "dropped" | string;
  selected_cycle?: number | null;
  applied_cycle?: number | null;
  applied_success?: boolean | null;
  applied_error?: string | null;
};

export type RpcTransactionSummary = {
  hash: `0x${string}`;
  from: `0x${string}` | string;
  to: (`0x${string}` | string) | null;
  value: string;
};

export class CatalystRpcClient {
  private nextId = 1;

  constructor(public readonly rpcUrl: string) {}

  async call<T>(method: string, params?: unknown[]): Promise<T> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as JsonRpcResponse<T>;
    if ("error" in json) throw new Error(`RPC ${json.error.code}: ${json.error.message}`);
    return json.result;
  }

  async getSyncInfo(): Promise<CatalystSyncInfo> {
    return await this.call<CatalystSyncInfo>("catalyst_getSyncInfo");
  }

  async chainId(): Promise<string> {
    return await this.call<string>("catalyst_chainId");
  }
  async networkId(): Promise<string> {
    return await this.call<string>("catalyst_networkId");
  }
  async genesisHash(): Promise<string> {
    return await this.call<string>("catalyst_genesisHash");
  }

  async getBalance(addressHex32: string): Promise<bigint> {
    const s = await this.call<string>("catalyst_getBalance", [addressHex32]);
    return BigInt(s);
  }

  async getNonce(addressHex32: string): Promise<bigint> {
    const n = await this.call<number>("catalyst_getNonce", [addressHex32]);
    return BigInt(n);
  }

  async estimateFee(req: RpcTransactionRequest): Promise<bigint> {
    const s = await this.call<string>("catalyst_estimateFee", [req]);
    return BigInt(s);
  }

  async sendRawTransaction(wireHex: string): Promise<`0x${string}`> {
    const txid = await this.call<string>("catalyst_sendRawTransaction", [wireHex]);
    return txid as `0x${string}`;
  }

  async getTransactionReceipt(txid: string): Promise<null | RpcTxReceipt> {
    return await this.call<null | RpcTxReceipt>("catalyst_getTransactionReceipt", [txid]);
  }

  async getTransactionsByAddress(args: {
    addressHex32: string;
    fromCycle?: number | null;
    limit: number;
  }): Promise<RpcTransactionSummary[]> {
    const fromCycle = args.fromCycle ?? null;
    return await this.call<RpcTransactionSummary[]>("catalyst_getTransactionsByAddress", [
      args.addressHex32,
      fromCycle,
      args.limit,
    ]);
  }
}

export async function assertChainIdentity(
  rpc: CatalystRpcClient,
  cfg: CatalystNetworkConfig,
): Promise<void> {
  // Prefer sync info (single round-trip), fall back if needed.
  let chainId: string | null = null;
  let networkId: string | null = null;
  let genesisHash: string | null = null;
  try {
    const si = await rpc.getSyncInfo();
    chainId = si.chain_id;
    networkId = si.network_id;
    genesisHash = si.genesis_hash;
  } catch {
    chainId = await rpc.chainId();
    networkId = await rpc.networkId();
    genesisHash = await rpc.genesisHash();
  }

  const normalize = (s: string) => s.toLowerCase();
  const chainHex = normalize(chainId);
  const chainNum = chainHex.startsWith("0x") ? BigInt(chainHex) : BigInt(chainHex);

  if (chainNum !== cfg.chainId) {
    throw new Error(`Chain ID mismatch: RPC=${chainId} expected=${cfg.chainId.toString()}`);
  }
  if (normalize(networkId) !== normalize(cfg.networkId)) {
    throw new Error(`Network ID mismatch: RPC=${networkId} expected=${cfg.networkId}`);
  }
  if (normalize(genesisHash) !== normalize(cfg.genesisHashHex)) {
    throw new Error(`Genesis hash mismatch: RPC=${genesisHash} expected=${cfg.genesisHashHex}`);
  }
}

