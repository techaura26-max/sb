import "dotenv/config";
import express from "express";
import http from "http";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_PORT = Number(process.env.PORT || 3000);
const ENGINE_PORT = Number(process.env.ENGINE_PORT || (PUBLIC_PORT + 1));
const app = express();

let engineProcess = null;
let engineExit = null;

app.use(express.static(path.join(__dirname, "public")));

function loadingStatus() {
  return {
    ok: true,
    indexing: true,
    engineReady: false,
    engineExit,
    apiKeyConfigured: Boolean(process.env.GROQ_API_KEY),
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    ownerName: process.env.OWNER_NAME || "Fares",
    myNames: String(process.env.MY_NAMES || "Faresyared,Fares Yared,Fares")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    memoryFiles: 0,
    instagramChats: 0,
    instagramMessages: 0,
    replyPairs: 0,
    voiceSamples: 0,
    memoryChunks: 0,
    style: { averageChars: 0, arabicPercent: 0, samples: 0 },
    message: engineExit
      ? `Indexing engine stopped (${engineExit}). Check the terminal.`
      : "Indexing your imported chats in the background...",
  };
}

function unavailable(req, res) {
  if (req.method === "GET" && req.originalUrl.startsWith("/api/status")) {
    return res.status(200).json(loadingStatus());
  }
  if (req.method === "GET" && req.originalUrl.startsWith("/api/chats")) {
    return res.status(200).json({ ok: true, indexing: true, chats: [] });
  }
  return res.status(503).json({
    error: engineExit
      ? `Indexing engine stopped (${engineExit}). Check the terminal.`
      : "Chats are still being indexed. Wait a little and try again.",
    indexing: true,
  });
}

app.use("/api", (req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${ENGINE_PORT}` };
  const proxy = http.request(
    {
      hostname: "127.0.0.1",
      port: ENGINE_PORT,
      method: req.method,
      path: req.originalUrl,
      headers,
    },
    (upstream) => {
      res.status(upstream.statusCode || 502);
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && name.toLowerCase() !== "transfer-encoding") res.setHeader(name, value);
      }
      upstream.pipe(res);
    },
  );

  let failed = false;
  proxy.on("error", () => {
    if (failed || res.headersSent) return;
    failed = true;
    unavailable(req, res);
  });
  req.pipe(proxy);
});

const publicServer = app.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`⚡ MIRROR UI: http://localhost:${PUBLIC_PORT}`);
  console.log(`⏳ Starting chat indexer on internal port ${ENGINE_PORT}...`);

  engineProcess = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(ENGINE_PORT) },
    stdio: "inherit",
  });

  engineProcess.on("exit", (code, signal) => {
    engineExit = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`❌ Chat indexing engine exited: ${engineExit}`);
  });
});

function shutdown(signal) {
  if (engineProcess && !engineProcess.killed) engineProcess.kill(signal);
  publicServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
