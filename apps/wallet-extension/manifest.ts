import type { ManifestV3Export } from "@crxjs/vite-plugin";

export default {
  manifest_version: 3,
  name: "Catalyst Wallet",
  description: "Catalyst wallet extension (testnet/dev).",
  version: "0.0.0",
  action: {
    default_title: "Catalyst Wallet",
    default_popup: "index.html",
  },
  options_ui: {
    page: "full.html",
    open_in_tab: true,
  },
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  permissions: ["storage"],
  host_permissions: [
    "https://testnet-eu-rpc.catalystnet.org/*",
    "https://testnet-us-rpc.catalystnet.org/*",
    "https://testnet-asia-rpc.catalystnet.org/*",

    // Local tunnel / dev RPC (optional)
    "http://127.0.0.1:8545/*",
    "http://localhost:8545/*",
    "http://[::1]:8545/*",
  ],
} satisfies ManifestV3Export;

