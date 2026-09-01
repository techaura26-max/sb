import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  },
}));

app.get("/health", (_req, res) => res.json({ ok: true, mode: "instagram-chat-viewer" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`📨 Instagram Chat Viewer: http://localhost:${PORT}`);
  console.log("🔒 Files are parsed in the browser and are not uploaded to this server.");
});
