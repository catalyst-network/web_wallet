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
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  permissions: ["storage"],
  host_permissions: [
    "http://45.32.177.248:8545/*",
    "http://127.0.0.1:8545/*",
    "http://localhost:8545/*",
    "http://[::1]:8545/*",
  ],
} satisfies ManifestV3Export;

