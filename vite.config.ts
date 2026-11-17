import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "TRANSFLOW_");
  const backendTarget = env.TRANSFLOW_BACKEND_URL || "http://127.0.0.1:8787";
  const proxy = {
    "/api/web": { target: env.TRANSFLOW_WEB_BACKEND_URL || "http://127.0.0.1:8788", changeOrigin: true },
    "/api": { target: backendTarget, changeOrigin: true },
  };
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy,
    },
    preview: { proxy },
  };
});
