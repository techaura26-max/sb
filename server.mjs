import "dotenv/config";
import express from "express";
import multer from "multer";
import MiniSearch from "minisearch";
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const OWNER_NAME = String(process.env.OWNER_NAME || "Fares").trim();
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 1024));
const MAX_ARCHIVE_TEXT_MB = Math.max(10, Number(process.env.MAX_ARCHIVE_TEXT_MB || 512));
const MAX_JSON_ENTRY_MB = Math.max(5, Number(process.env.MAX_JSON_ENTRY_MB || 64));

const MY_NAMES = String(process.env.MY_NAMES || "Faresyared,Fares Yared,Fares")
  .split(",")
  .map((x) => normalizeSender(x))
  .filter(Boolean);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "missing" });
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const memoryDir = path.join(__dirname, "memory");
fs.mkdirSync(memoryDir, { recursive: true });

const ALLOWED_EXT = new Set([".txt", ".md", ".json", ".csv", ".zip"]);
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, memoryDir),
  filename: (_, file, cb) => {
    const safe = path.basename(file.originalname).replace(/[^\p{L}\p{N}_. -]/gu, "_");
    cb(null, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { files: 100, fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error("Supported files: .zip, .json, .txt, .md, .csv"), ok);
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

function mojibakeScore(value = "") {
  const s = String(value);
  const suspicious = s.match(/[\u0080-\u009fÃÂØÙðâ]/g)?.length || 0;
  const replacement = s.match(/�/g)?.length || 0;
  return suspicious + replacement * 8;
}

function fixMetaEncoding(value = "") {
  const original = String(value);
  if (!original || !/[\u0080-\u009fÃÂØÙðâ]/.test(original)) return original;
  try {
    const candidate = Buffer.from(original, "latin1").toString("utf8");
    if (!candidate || candidate.includes("�")) return original;
    const gainedUsefulScript = /[\u0600-\u06ff]|[\u{1F300}-\u{1FAFF}]|[\u{1D400}-\u{1D7FF}]/u.test(candidate);
    if (mojibakeScore(candidate) < mojibakeScore(original) || gainedUsefulScript) return candidate;
  } catch {}
  return original;
}

function cleanText(text = "") {
  const out = String(text)
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
  let order = 0;

  const bracket = /^[\u200e\u200f\ufeff]*\[([^\]]+)\]\s*([^:]{1,120}):\s?(.*)$/;
  const dash = /^[\u200e\u200f\ufeff]*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4},?\s+.+?)\s+-\s+([^:]{1,120}):\s?(.*)$/;

  for (const line of lines) {
    const b = line.match(bracket);
    const d = !b ? line.match(dash) : null;
    if (b || d) {
      if (current) messages.push(current);
      current = b
        ? { sender: b[2].trim(), text: b[3] || "", timestamp: null, order: order++ }
        : { sender: d[2].trim(), text: d[3] || "", timestamp: null, order: order++ };
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
  let order = 0;

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const sender = node.from ?? node.sender ?? node.author ?? node.from_name;
    const rawText = node.text ?? node.message ?? node.content ?? node.body;
    const text = textValue(rawText);
    if (typeof sender === "string" && text.trim()) {
      messages.push({ sender: fixMetaEncoding(sender), text: fixMetaEncoding(text), timestamp: null, order: order++ });
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  }

  walk(data);
  return mergeTurns(messages);
}

function isInstagramChat(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      Array.isArray(data.messages) &&
      (Array.isArray(data.participants) || data.messages.some((m) => m && typeof m.sender_name === "string")),
  );
}

function parseInstagramChat(data, source, threadHint = "") {
  const participants = Array.isArray(data.participants)
    ? data.participants
        .map((p) => fixMetaEncoding(p?.name || ""))
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  const messages = [];
  let order = 0;
  for (const raw of data.messages || []) {
    const sender = fixMetaEncoding(raw?.sender_name || "").trim();
    const content = typeof raw?.content === "string" ? cleanText(fixMetaEncoding(raw.content)) : "";
    if (!sender || !content) continue;
    const timestamp = Number.isFinite(Number(raw.timestamp_ms)) ? Number(raw.timestamp_ms) : null;
    messages.push({ sender, text: content, timestamp, order: order++ });
  }

  messages.sort((a, b) => {
    if (a.timestamp != null && b.timestamp != null && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.order - b.order;
  });

  const unique = [];
  const seen = new Set();
  for (const message of messages) {
    const key = `${message.timestamp ?? ""}|${normalizeSender(message.sender)}|${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }

  const allParticipants = participants.length
    ? participants
    : [...new Set(unique.map((m) => m.sender).filter(Boolean))];
  const others = allParticipants.filter((name) => !isMe(name));
  const title = others.length ? others.join(", ") : allParticipants.join(", ") || path.basename(threadHint || source);
  const identity = allParticipants.map(normalizeSender).sort().join("|") || normalizeSender(threadHint || source);
  const id = crypto.createHash("sha1").update(identity).digest("hex").slice(0, 16);

  return {
    id,
    identity,
    title,
    participants: allParticipants,
    messages: unique,
    sources: [source],
    threadHint,
  };
}

function mergeTurns(messages) {
  const turns = [];
  for (const message of messages) {
    const sender = String(message.sender || "").trim();
    const text = cleanText(message.text || "");
    if (!sender || !text) continue;
    const last = turns.at(-1);
    if (last && normalizeSender(last.sender) === normalizeSender(sender)) {
      last.text += `\n${text}`;
      if (message.timestamp != null) last.timestamp = message.timestamp;
    } else {
      turns.push({ sender, text, timestamp: message.timestamp ?? null });
    }
  }
  return turns;
}

function makeChatRecords(turns, source) {
  const out = [];
  let ownTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const current = turns[i];
    if (!isMe(current.sender)) continue;
    ownTurns += 1;

    const reply = cleanText(current.text);
    if (reply.length >= 2) {
      out.push({
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
    out.push({
      id: crypto.randomUUID(),
      kind: "reply",
      context: context.slice(0, 1800),
      reply: reply.slice(0, 1800),
      sample: `${context}\n${reply}`.slice(0, 3000),
      search: context.slice(0, 1800),
      source,
    });
  }

  return { records: out, ownTurns };
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

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, position + total);
    if (!read) break;
    total += read;
  }
  if (total !== length) throw new Error("Unexpected end of ZIP file");
  return buffer;
}

function bigIntToNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is too large`);
  return Number(value);
}

function parseZip64Extra(extra, need) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const body = extra.subarray(cursor + 4, cursor + 4 + size);
    cursor += 4 + size;
    if (id !== 0x0001) continue;
    let p = 0;
    const result = {};
    if (need.uncompressed && p + 8 <= body.length) {
      result.uncompressedSize = bigIntToNumber(body.readBigUInt64LE(p), "ZIP entry");
      p += 8;
    }
    if (need.compressed && p + 8 <= body.length) {
      result.compressedSize = bigIntToNumber(body.readBigUInt64LE(p), "ZIP entry");
      p += 8;
    }
    if (need.offset && p + 8 <= body.length) {
      result.localHeaderOffset = bigIntToNumber(body.readBigUInt64LE(p), "ZIP entry offset");
      p += 8;
    }
    return result;
  }
  return {};
}

function listZipEntries(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const tailSize = Math.min(fileSize, 66 * 1024);
    const tailStart = fileSize - tailSize;
    const tail = readAt(fd, tailSize, tailStart);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Invalid ZIP: end record not found");

    let totalEntries = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralOffset = tail.readUInt32LE(eocd + 16);

    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      let locator = -1;
      for (let i = eocd - 20; i >= Math.max(0, eocd - 128); i--) {
        if (tail.readUInt32LE(i) === 0x07064b50) {
          locator = i;
          break;
        }
      }
      if (locator < 0) throw new Error("ZIP64 locator not found");
      const zip64Offset = bigIntToNumber(tail.readBigUInt64LE(locator + 8), "ZIP64 offset");
      const zip64 = readAt(fd, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== 0x06064b50) throw new Error("Invalid ZIP64 record");
      totalEntries = bigIntToNumber(zip64.readBigUInt64LE(32), "ZIP entries");
      centralSize = bigIntToNumber(zip64.readBigUInt64LE(40), "ZIP directory");
      centralOffset = bigIntToNumber(zip64.readBigUInt64LE(48), "ZIP directory offset");
    }

    if (centralSize > 256 * 1024 * 1024) throw new Error("ZIP directory is too large");
    const central = readAt(fd, centralSize, centralOffset);
    const entries = [];
    let cursor = 0;

    for (let n = 0; n < totalEntries && cursor + 46 <= central.length; n++) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) break;
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      let compressedSize = central.readUInt32LE(cursor + 20);
      let uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLen = central.readUInt16LE(cursor + 28);
      const extraLen = central.readUInt16LE(cursor + 30);
      const commentLen = central.readUInt16LE(cursor + 32);
      let localHeaderOffset = central.readUInt32LE(cursor + 42);
      const nameBuf = central.subarray(cursor + 46, cursor + 46 + nameLen);
      const extra = central.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
      const name = nameBuf.toString("utf8").replace(/\\/g, "/");

      const need = {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      };
      if (need.uncompressed || need.compressed || need.offset) {
        const zip64 = parseZip64Extra(extra, need);
        if (need.uncompressed) uncompressedSize = zip64.uncompressedSize;
        if (need.compressed) compressedSize = zip64.compressedSize;
        if (need.offset) localHeaderOffset = zip64.localHeaderOffset;
      }

      entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function readZipEntry(filePath, entry) {
  if (entry.flags & 0x1) throw new Error(`Encrypted ZIP entry skipped: ${entry.name}`);
  if (![0, 8].includes(entry.method)) throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  if (!Number.isFinite(entry.compressedSize) || !Number.isFinite(entry.localHeaderOffset)) throw new Error("Invalid ZIP entry size");
  if (entry.uncompressedSize > MAX_JSON_ENTRY_MB * 1024 * 1024) throw new Error(`Message JSON is larger than ${MAX_JSON_ENTRY_MB} MB`);

  const fd = fs.openSync(filePath, "r");
  try {
    const local = readAt(fd, 30, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP local header");
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const compressed = readAt(fd, entry.compressedSize, dataStart);
    return entry.method === 0 ? compressed : zlib.inflateRawSync(compressed);
  } finally {
    fs.closeSync(fd);
  }
}

function isInstagramMessageEntry(name) {
  const normalized = String(name).replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() || "";
  return /^message_\d+\.json$/.test(base) && /(^|\/)messages\//.test(normalized);
}

function messageJsonFallback(name) {
  const normalized = String(name).replace(/\\/g, "/").toLowerCase();
  return /^message_\d+\.json$/.test(normalized.split("/").pop() || "");
}

function chatIdentity(chat) {
  return chat.identity || chat.participants.map(normalizeSender).sort().join("|") || chat.id;
}

function addInstagramChat(chatMap, chat) {
  const key = chatIdentity(chat);
  const existing = chatMap.get(key);
  if (!existing) {
    chatMap.set(key, { ...chat, sources: new Set(chat.sources || []), messages: [...chat.messages] });
    return;
  }
  for (const source of chat.sources || []) existing.sources.add(source);
  const seen = new Set(existing.messages.map((m) => `${m.timestamp ?? ""}|${normalizeSender(m.sender)}|${m.text}`));
  for (const message of chat.messages) {
    const mk = `${message.timestamp ?? ""}|${normalizeSender(message.sender)}|${message.text}`;
    if (!seen.has(mk)) {
      seen.add(mk);
      existing.messages.push(message);
    }
  }
}

function parseZipFile(filePath, source, chatMap, stats) {
  const entries = listZipEntries(filePath);
  const preferred = entries.filter((entry) => isInstagramMessageEntry(entry.name));
  const candidates = preferred.length ? preferred : entries.filter((entry) => messageJsonFallback(entry.name));
  stats.archiveEntries += entries.length;
  stats.archiveMessageFiles += candidates.length;
  stats.ignoredArchiveEntries += Math.max(0, entries.length - candidates.length);

  let decodedBytes = 0;
  for (const entry of candidates) {
    try {
      const dataBuffer = readZipEntry(filePath, entry);
      decodedBytes += dataBuffer.length;
      if (decodedBytes > MAX_ARCHIVE_TEXT_MB * 1024 * 1024) throw new Error(`Archive message JSON exceeds ${MAX_ARCHIVE_TEXT_MB} MB`);
      const data = JSON.parse(dataBuffer.toString("utf8"));
      if (!isInstagramChat(data)) continue;
      const threadHint = path.posix.dirname(entry.name);
      addInstagramChat(chatMap, parseInstagramChat(data, `${source}:${entry.name}`, threadHint));
      stats.instagramFiles += 1;
    } catch (error) {
      stats.parseWarnings.push(`${entry.name}: ${error.message}`);
    }
  }
}

function parseStoredFile(filePath, chatMap, stats) {
  const source = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".zip") {
    parseZipFile(filePath, source, chatMap, stats);
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (ext === ".json") {
    try {
      const data = JSON.parse(raw);
      if (isInstagramChat(data)) {
        addInstagramChat(chatMap, parseInstagramChat(data, source));
        stats.instagramFiles += 1;
        return [];
      }
      const turns = parseJsonChat(data);
      if (turns.length) {
        const chat = makeChatRecords(turns, source);
        if (chat.ownTurns > 0) {
          stats.ownTurns += chat.ownTurns;
          return chat.records;
        }
      }
    } catch (error) {
      stats.parseWarnings.push(`${source}: ${error.message}`);
    }
    stats.genericFiles += 1;
    return genericMemoryRecords(raw, source);
  }

  const turns = parseWhatsApp(raw);
  if (turns.length) {
    const chat = makeChatRecords(turns, source);
    if (chat.ownTurns > 0) {
      stats.ownTurns += chat.ownTurns;
      return chat.records;
    }
  }
  stats.genericFiles += 1;
  return genericMemoryRecords(raw, source);
}

let records = [];
let index = null;
let chats = [];
let ingest = {};

function finalizeChatMap(chatMap, stats) {
  const finalized = [];
  for (const raw of chatMap.values()) {
    raw.messages.sort((a, b) => {
      if (a.timestamp != null && b.timestamp != null && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return (a.order || 0) - (b.order || 0);
    });
    const turns = mergeTurns(raw.messages);
    const sourceLabel = raw.title || [...raw.sources][0] || "Instagram";
    const made = makeChatRecords(turns, sourceLabel);
    records.push(...made.records);
    stats.ownTurns += made.ownTurns;
    if (!made.ownTurns) stats.unrecognizedChats += 1;

    const ownMessages = raw.messages.filter((m) => isMe(m.sender)).length;
    const last = raw.messages.at(-1);
    finalized.push({
      id: raw.id,
      title: raw.title,
      participants: raw.participants,
      sources: [...raw.sources],
      messages: raw.messages,
      messageCount: raw.messages.length,
      ownMessages,
      otherMessages: raw.messages.length - ownMessages,
      lastTimestamp: last?.timestamp ?? null,
      lastMessage: last?.text || "",
    });
  }
  finalized.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  return finalized;
}

function rebuild() {
  const files = fs
    .readdirSync(memoryDir)
    .filter((name) => ALLOWED_EXT.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(memoryDir, name));

  records = [];
  const chatMap = new Map();
  const stats = {
    files: files.length,
    ownTurns: 0,
    genericFiles: 0,
    unrecognizedChats: 0,
    instagramFiles: 0,
    archiveEntries: 0,
    archiveMessageFiles: 0,
    ignoredArchiveEntries: 0,
    parseWarnings: [],
  };

  for (const file of files) {
    try {
      records.push(...parseStoredFile(file, chatMap, stats));
    } catch (error) {
      stats.parseWarnings.push(`${path.basename(file)}: ${error.message}`);
    }
  }

  chats = finalizeChatMap(chatMap, stats);
  ingest = { ...stats, chats: chats.length, messages: chats.reduce((sum, chat) => sum + chat.messageCount, 0) };

  index = new MiniSearch({
    fields: ["search", "sample", "context", "reply"],
    storeFields: ["kind", "context", "reply", "sample", "source"],
    searchOptions: { boost: { search: 4, context: 3, reply: 1, sample: 1 }, fuzzy: 0.2, prefix: true, combineWith: "OR" },
  });
  if (records.length) index.addAll(records);

  const counts = countKinds();
  console.log(
    `🪞 ${records.length} memory records • ${chats.length} Instagram chats • ${ingest.messages} visible messages • ${counts.reply} reply pairs`,
  );
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
  const arabic = samples.filter((text) => /[\u0600-\u06ff]/.test(text)).length;
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
    genericFiles: ingest.genericFiles,
    instagramChats: ingest.chats,
    instagramFiles: ingest.instagramFiles,
    instagramMessages: ingest.messages,
    archiveMessageFiles: ingest.archiveMessageFiles,
    ignoredArchiveEntries: ingest.ignoredArchiveEntries,
    warningCount: ingest.parseWarnings.length,
    warnings: ingest.parseWarnings.slice(0, 10),
    style: styleSnapshot(),
    apiKeyConfigured: Boolean(process.env.GROQ_API_KEY),
    limits: { maxUploadMb: MAX_UPLOAD_MB, maxArchiveTextMb: MAX_ARCHIVE_TEXT_MB },
  });
});

app.get("/api/chats", (_, res) => {
  res.json({
    ok: true,
    chats: chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      participants: chat.participants,
      messageCount: chat.messageCount,
      ownMessages: chat.ownMessages,
      otherMessages: chat.otherMessages,
      lastTimestamp: chat.lastTimestamp,
      lastMessage: chat.lastMessage.slice(0, 180),
      sourceFiles: chat.sources.length,
    })),
  });
});

app.get("/api/chats/:id", (req, res) => {
  const chat = chats.find((item) => item.id === req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 200));
  const requestedBefore = req.query.before == null ? chat.messages.length : Number(req.query.before);
  const end = Math.min(chat.messages.length, Math.max(0, Number.isFinite(requestedBefore) ? requestedBefore : chat.messages.length));
  const start = Math.max(0, end - limit);
  const page = chat.messages.slice(start, end).map((message) => ({
    sender: message.sender,
    text: message.text,
    timestamp: message.timestamp,
    isMe: isMe(message.sender),
  }));
  res.json({
    ok: true,
    chat: {
      id: chat.id,
      title: chat.title,
      participants: chat.participants,
      messageCount: chat.messageCount,
      ownMessages: chat.ownMessages,
      otherMessages: chat.otherMessages,
    },
    messages: page,
    nextBefore: start > 0 ? start : null,
  });
});

app.post("/api/upload", upload.array("files", 100), (req, res) => {
  rebuild();
  const counts = countKinds();
  res.json({
    ok: true,
    uploaded: req.files?.length || 0,
    ...counts,
    instagramChats: ingest.chats,
    instagramFiles: ingest.instagramFiles,
    instagramMessages: ingest.messages,
    ignoredArchiveEntries: ingest.ignoredArchiveEntries,
    warnings: ingest.parseWarnings.slice(0, 10),
    style: styleSnapshot(),
  });
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
    const voiceText = voices.length ? voices.map((x, i) => `VOICE ${i + 1}: ${x.sample}`).join("\n") : "No voice samples loaded.";
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