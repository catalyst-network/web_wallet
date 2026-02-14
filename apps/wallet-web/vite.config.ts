import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin RPC proxy to bypass CORS in dev.
      // Use `VITE_RPC_TARGET=http://127.0.0.1:8545 npm run dev` to point at an SSH tunnel.
      "/rpc": {
        target: process.env.VITE_RPC_TARGET ?? "http://45.32.177.248:8545",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/rpc/, "/"),
      },
    },
  },
});

