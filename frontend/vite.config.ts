import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from 'fs'
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const keyPath = path.resolve(__dirname, '../localhost+1-key.pem');
  const certPath = path.resolve(__dirname, '../localhost+1.pem');
  let httpsOption: { key: Buffer; cert: Buffer } | undefined = undefined;
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      httpsOption = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    }
  } catch {}

  return {
    server: {
      host: "::",
      port: Number(env.FRONTEND_PORT) || 8080,
      ...(httpsOption ? { https: httpsOption } : {}),
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
