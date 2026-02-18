import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin RPC proxy to bypass CORS in dev.
      // Use `VITE_RPC_TARGET=https://testnet-eu-rpc.catalystnet.org npm run dev` to override.
      "/rpc": {
        target: process.env.VITE_RPC_TARGET ?? "https://testnet-eu-rpc.catalystnet.org",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/rpc/, "/"),
      },
    },
  },
});

