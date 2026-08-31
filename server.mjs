import "dotenv/config";
import express from "express";
import multer from "multer";
import MiniSearch from "minisearch";
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const OWNER_NAME = String(process.env.OWNER_NAME || "Me").trim();
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MY_NAMES = String(process.env.MY_NAMES || OWNER_NAME)
  .split(",")
  .map((x) => normalizeSender(x))
  .filter(Boolean);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "missing" });
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const memoryDir = path.join(__dirname, "memory");
fs.mkdirSync(memoryDir, { recursive: true });

const ALLOWED_EXT = new Set([".txt", ".md", ".json", ".csv"]);
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, memoryDir),
  filename: (_, file, cb) => {
    const safe = path.basename(file.originalname).replace(/[^\p{L}\p{N}_. -]/gu, "_");
    cb(null, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { files: 100, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error("Supported files: .txt, .md, .json, .csv"), ok);
  },
});

const JUNK = [
  "messages and calls are end-to-end encrypted",
  "this business is now using a secure service from meta",
  "ai from meta receives messages",
  "pinned a message",
  "you deleted this message",
  "message omitted",
];
const MEDIA = [
  "image omitted",
  "document omitted",
  "video omitted",
  "audio omitted",
  "sticker omitted",
  "gif omitted",
];

const SECRET_PATTERNS = [
  [/\b(?:gsk|sk)-?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:eyJ[a-zA-Z0-9_-]+\.){2}[a-zA-Z0-9_-]+\b/g, "[REDACTED_TOKEN]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[REDACTED_IBAN]"],
  [/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, "[REDACTED_NUMBER]"],
];

function normalizeSender(value = "") {
  return String(value)
    .replace(/[\u200e\u200f\ufeff]/g, "")
    .trim()
    .toLocaleLowerCase();
}

function isMe(sender = "") {
  const n = normalizeSender(sender);
  return MY_NAMES.some((name) => n === name || (name.length >= 3 && n.includes(name)));
}

function cleanText(text = "") {
  let out = String(text)
    .replace(/[\u200e\u200f\ufeff]/g, "")
    .replace(/\s*<This message was edited>\s*/gi, "")
    .replace(/\r/g, "")
    .trim();

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      return !JUNK.some((junk) => lower.includes(junk));
    })
    .map((line) => {
      let next = line;
      for (const media of MEDIA) next = next.replace(new RegExp(media, "ig"), "");
      return next.trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function redactSecrets(text = "") {
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function parseWhatsApp(text) {
  const lines = String(text).split(/\r?\n/);
  const messages = [];
  let current = null;

  const bracket = /^[\u200e\u200f\ufeff]*\[[^\]]+\]\s*([^:]{1,120}):\s?(.*)$/;
  const dash = /^[\u200e\u200f\ufeff]*\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4},?\s+.+?\s+-\s+([^:]{1,120}):\s?(.*)$/;

  for (const line of lines) {
    const match = line.match(bracket) || line.match(dash);
    if (match) {
      if (current) messages.push(current);
      current = { sender: match[1].trim(), text: match[2] || "" };
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  if (current) messages.push(current);
  return mergeTurns(messages);
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : item && typeof item.text === "string" ? item.text : ""))
      .join("");
  }
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return "";
}

function parseJsonChat(data) {
  const messages = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const sender = node.from ?? node.sender ?? node.author ?? node.name ?? node.from_name;
    const rawText = node.text ?? node.message ?? node.content ?? node.body;
    const text = textValue(rawText);
    if (typeof sender === "string" && text.trim()) messages.push({ sender, text });

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  }

  walk(data);
  return mergeTurns(messages);
}

function mergeTurns(messages) {
  const turns = [];
  for (const message of messages) {
    const sender = String(message.sender || "").trim();
    const text = cleanText(message.text || "");
    if (!sender || !text) continue;
    const last = turns.at(-1);
    if (last && normalizeSender(last.sender) === normalizeSender(sender)) last.text += `\n${text}`;
    else turns.push({ sender, text });
  }
  return turns;
}

function makeChatRecords(turns, source) {
  const records = [];
  let ownTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const current = turns[i];
    if (!isMe(current.sender)) continue;
    ownTurns += 1;

    const reply = cleanText(current.text);
    if (reply.length >= 2) {
      records.push({
        id: crypto.randomUUID(),
        kind: "voice",
        context: "",
        reply: "",
        sample: reply.slice(0, 1800),
        search: reply.slice(0, 1800),
        source,
      });
    }

    const previous = turns[i - 1];
    if (!previous || isMe(previous.sender)) continue;
    const context = cleanText(previous.text);
    if (!context || !reply) continue;

    records.push({
      id: crypto.randomUUID(),
      kind: "reply",
      context: context.slice(0, 1800),
      reply: reply.slice(0, 1800),
      sample: `${context}\n${reply}`.slice(0, 3000),
      search: context.slice(0, 1800),
      source,
    });
  }

  return { records, ownTurns };
}

function chunks(text, max = 900) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];
  const parts = cleaned.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  let buffer = "";

  for (const part of parts) {
    if ((buffer + "\n\n" + part).length <= max) {
      buffer = buffer ? `${buffer}\n\n${part}` : part;
      continue;
    }
    if (buffer) out.push(buffer);
    if (part.length <= max) buffer = part;
    else {
      for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
      buffer = "";
    }
    if (out.length >= 120) break;
  }
  if (buffer && out.length < 120) out.push(buffer);
  return out.slice(0, 120);
}

function genericMemoryRecords(text, source) {
  return chunks(text).map((sample) => ({
    id: crypto.randomUUID(),
    kind: "memory",
    context: "",
    reply: "",
    sample,
    search: sample,
    source,
  }));
}

function parseFile(filePath) {
  const source = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, "utf8");
  let turns = [];

  try {
    if (ext === ".json") turns = parseJsonChat(JSON.parse(raw));
    else turns = parseWhatsApp(raw);
  } catch (error) {
    console.warn(`Could not parse structured chat in ${source}: ${error.message}`);
  }

  if (turns.length) {
    const chat = makeChatRecords(turns, source);
    if (chat.ownTurns > 0) return { records: chat.records, ownTurns: chat.ownTurns, structured: true };
  }

  return { records: genericMemoryRecords(raw, source), ownTurns: 0, structured: false };
}

let records = [];
let index = null;
let ingest = { files: 0, ownTurns: 0, unrecognizedChats: 0 };

function rebuild() {
  const files = fs
    .readdirSync(memoryDir)
    .filter((name) => ALLOWED_EXT.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(memoryDir, name));

  records = [];
  ingest = { files: files.length, ownTurns: 0, unrecognizedChats: 0 };

  for (const file of files) {
    try {
      const parsed = parseFile(file);
      records.push(...parsed.records);
      ingest.ownTurns += parsed.ownTurns;
      if (!parsed.structured && parsed.records.length) ingest.unrecognizedChats += 1;
    } catch (error) {
      console.warn("Parse error", file, error.message);
    }
  }

  index = new MiniSearch({
    fields: ["search", "sample", "context", "reply"],
    storeFields: ["kind", "context", "reply", "sample", "source"],
    searchOptions: { boost: { search: 4, context: 3, reply: 1, sample: 1 }, fuzzy: 0.2, prefix: true, combineWith: "OR" },
  });
  if (records.length) index.addAll(records);

  const counts = countKinds();
  console.log(`🪞 ${records.length} memory records from ${files.length} files (${counts.reply} reply pairs, ${counts.voice} voice samples)`);
}

function countKinds() {
  return records.reduce(
    (acc, item) => {
      acc[item.kind] = (acc[item.kind] || 0) + 1;
      return acc;
    },
    { reply: 0, voice: 0, memory: 0 },
  );
}

function retrieve(query, kind, limit) {
  if (!index || !records.length) return [];
  const results = index.search(query || "", { fuzzy: 0.25, prefix: true });
  const out = [];
  const seen = new Set();

  for (const item of results) {
    if (kind && item.kind !== kind) continue;
    const key = `${item.kind}|${item.context}|${item.reply}|${item.sample}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: item.kind,
      context: redactSecrets(item.context || ""),
      reply: redactSecrets(item.reply || ""),
      sample: redactSecrets(item.sample || ""),
      source: item.source,
      score: Number((item.score || 0).toFixed(2)),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function voiceFallback(limit = 8) {
  return records
    .filter((item) => item.kind === "voice")
    .slice(-limit)
    .map((item) => ({ kind: "voice", sample: redactSecrets(item.sample), source: item.source, score: 0 }));
}

function styleSnapshot() {
  const samples = records.filter((item) => item.kind === "voice").map((item) => item.sample);
  if (!samples.length) return { averageChars: 0, arabicPercent: 0, samples: 0 };
  const totalChars = samples.reduce((sum, text) => sum + text.length, 0);
  const arabic = samples.filter((text) => /[\u0600-\u06FF]/.test(text)).length;
  return {
    averageChars: Math.round(totalChars / samples.length),
    arabicPercent: Math.round((arabic / samples.length) * 100),
    samples: samples.length,
  };
}

rebuild();

const SYSTEM = `You are a personal reply ghostwriter. Your job is to write AS the owner, not to sound like an AI assistant.

Use the uploaded examples as a style mirror and personal memory.
Rules:
- Match the live message language naturally. If the owner historically mixes Arabic/English, mirror that only when the examples support it.
- Copy the owner's real texting habits: dialect, spelling, punctuation, emoji use, message length, warmth, humor, directness, and slang.
- Reply pairs are the strongest evidence for how the owner answers similar messages.
- Voice samples teach tone only. Memory snippets may contain useful personal facts/preferences, but use them only when relevant.
- Never invent personal facts, events, promises, relationships, opinions, or plans that are not supported by the live context or memory.
- Never expose secrets, credentials, payment details, IDs, phone numbers, addresses, or unrelated private information from another uploaded conversation.
- Do not mention the training files, retrieval, RAG, examples, or that you are an AI.
- Do not become formal or polished unless the owner's examples are formal.
- If evidence is weak, imitate the tone but keep factual claims minimal.

Return JSON only:
{"reply":"the message the owner can send","confidence":"low|medium|high","note":"very short reason about style match, not private content"}`;

app.get("/api/status", (_, res) => {
  const counts = countKinds();
  res.json({
    ok: true,
    model: MODEL,
    ownerName: OWNER_NAME,
    myNames: MY_NAMES,
    memoryFiles: ingest.files,
    replyPairs: counts.reply,
    voiceSamples: counts.voice,
    memoryChunks: counts.memory,
    ownTurns: ingest.ownTurns,
    genericFiles: ingest.unrecognizedChats,
    style: styleSnapshot(),
    apiKeyConfigured: Boolean(process.env.GROQ_API_KEY),
  });
});

app.post("/api/upload", upload.array("files", 100), (req, res) => {
  rebuild();
  const counts = countKinds();
  res.json({ ok: true, uploaded: req.files?.length || 0, ...counts, style: styleSnapshot() });
});

app.delete("/api/memory", (_, res) => {
  for (const name of fs.readdirSync(memoryDir)) {
    const full = path.join(memoryDir, name);
    if (ALLOWED_EXT.has(path.extname(name).toLowerCase()) && fs.statSync(full).isFile()) fs.unlinkSync(full);
  }
  rebuild();
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: "GROQ_API_KEY missing in .env" });
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "Message required" });

    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
    const replyExamples = retrieve(message, "reply", 8);
    const voiceExamples = retrieve(message, "voice", 6);
    const memoryExamples = retrieve(message, "memory", 5);
    const voices = voiceExamples.length ? voiceExamples : voiceFallback(6);

    const repliesText = replyExamples.length
      ? replyExamples.map((x, i) => `PAIR ${i + 1}\nTHEY SAID: ${x.context}\nOWNER REPLIED: ${x.reply}`).join("\n\n---\n\n")
      : "No similar reply pairs found.";

    const voiceText = voices.length
      ? voices.map((x, i) => `VOICE ${i + 1}: ${x.sample}`).join("\n")
      : "No voice samples loaded.";

    const memoryText = memoryExamples.length
      ? memoryExamples.map((x, i) => `MEMORY ${i + 1}: ${x.sample}`).join("\n\n")
      : "No relevant memory snippets.";

    const liveHistory = history.length
      ? history
          .map((item) => `${item.role === "user" ? "THEM" : "OWNER"}: ${redactSecrets(String(item.content || ""))}`)
          .join("\n")
      : "No live conversation history.";

    const completion = await groq.chat.completions.create({
      model: MODEL,
      reasoning_effort: "low",
      temperature: 0.55,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `OWNER LABEL: ${OWNER_NAME}\n\nSIMILAR REPLY PAIRS:\n${repliesText}\n\nVOICE SAMPLES:\n${voiceText}\n\nRELEVANT PERSONAL MEMORY:\n${memoryText}\n\nLIVE CONVERSATION:\n${liveHistory}\n\nNEW MESSAGE TO REPLY TO:\n${redactSecrets(message)}\n\nReturn JSON only.`,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { reply: raw, confidence: "low", note: "model returned non-JSON" };
    }

    res.json({
      ok: true,
      reply: String(parsed.reply || "").trim(),
      confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium",
      note: String(parsed.note || "").trim(),
      matched: { replyPairs: replyExamples.length, voiceSamples: voices.length, memoryChunks: memoryExamples.length },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Groq request failed" });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message || "Upload failed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🪞 Personal AI: http://localhost:${PORT}`);
  console.log(`🧠 ${MODEL}`);
  console.log(`👤 Recognized names: ${MY_NAMES.join(", ") || "none"}`);
});
