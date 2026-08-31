(() => {
  const REQUEST_LIMIT = 5 * 1024 * 1024;
  const FILE_TARGET = 2.5 * 1024 * 1024;
  const MAX_FILES_PER_BATCH = 60;
  const decoder = new TextDecoder("utf-8");

  const $ = (s) => document.querySelector(s);
  const bar = () => $("#uploadBar");
  const label = () => $("#uploadText");

  function setProgress(percent, text) {
    const b = bar();
    const l = label();
    if (b) b.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (l && text) l.textContent = text;
  }

  function showToast(text, time = 3500) {
    if (typeof window.toast === "function") window.toast(text, time);
    else console.log(text);
  }

  function safeName(value) {
    return String(value || "chat")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .slice(-3)
      .join("-")
      .replace(/[^\p{L}\p{N}_. -]/gu, "_")
      .slice(0, 140) || "chat";
  }

  function u16(view, offset) { return view.getUint16(offset, true); }
  function u32(view, offset) { return view.getUint32(offset, true); }
  function u64(view, offset) {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP أكبر من الحجم المدعوم");
    return Number(value);
  }

  async function readSlice(file, start, length) {
    const end = Math.min(file.size, start + length);
    if (start < 0 || start > file.size || end < start) throw new Error("ZIP فيه offset غير صالح");
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  function findSignature(bytes, signature, from) {
    for (let i = from; i >= 0; i--) {
      if (bytes[i] === (signature & 255) &&
          bytes[i + 1] === ((signature >>> 8) & 255) &&
          bytes[i + 2] === ((signature >>> 16) & 255) &&
          bytes[i + 3] === ((signature >>> 24) & 255)) return i;
    }
    return -1;
  }

  function parseZip64Extra(extra, needs) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    let cursor = 0;
    while (cursor + 4 <= extra.length) {
      const id = u16(view, cursor);
      const size = u16(view, cursor + 2);
      const start = cursor + 4;
      const end = start + size;
      if (end > extra.length) break;
      if (id === 0x0001) {
        let p = start;
        const result = {};
        if (needs.uncompressed && p + 8 <= end) { result.uncompressedSize = u64(view, p); p += 8; }
        if (needs.compressed && p + 8 <= end) { result.compressedSize = u64(view, p); p += 8; }
        if (needs.offset && p + 8 <= end) { result.localHeaderOffset = u64(view, p); p += 8; }
        return result;
      }
      cursor = end;
    }
    return {};
  }

  async function listZipEntries(file) {
    const tailSize = Math.min(file.size, 66 * 1024);
    const tailStart = file.size - tailSize;
    const tail = await readSlice(file, tailStart, tailSize);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const eocd = findSignature(tail, 0x06054b50, tail.length - 22);
    if (eocd < 0) throw new Error("الملف مش ZIP صالح أو ناقص");

    let totalEntries = u16(tailView, eocd + 10);
    let centralSize = u32(tailView, eocd + 12);
    let centralOffset = u32(tailView, eocd + 16);

    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      const locator = findSignature(tail, 0x07064b50, eocd - 20);
      if (locator < 0 || locator + 20 > tail.length) throw new Error("ZIP64 locator مش موجود");
      const zip64Offset = u64(tailView, locator + 8);
      const zip64 = await readSlice(file, zip64Offset, 56);
      const zview = new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength);
      if (u32(zview, 0) !== 0x06064b50) throw new Error("ZIP64 record غير صالح");
      totalEntries = u64(zview, 32);
      centralSize = u64(zview, 40);
      centralOffset = u64(zview, 48);
    }

    if (centralSize > 256 * 1024 * 1024) throw new Error("ZIP directory كبير جدًا");
    const central = await readSlice(file, centralOffset, centralSize);
    const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
    const entries = [];
    let cursor = 0;

    for (let n = 0; n < totalEntries && cursor + 46 <= central.length; n++) {
      if (u32(view, cursor) !== 0x02014b50) break;
      const flags = u16(view, cursor + 8);
      const method = u16(view, cursor + 10);
      let compressedSize = u32(view, cursor + 20);
      let uncompressedSize = u32(view, cursor + 24);
      const nameLen = u16(view, cursor + 28);
      const extraLen = u16(view, cursor + 30);
      const commentLen = u16(view, cursor + 32);
      let localHeaderOffset = u32(view, cursor + 42);
      const nameStart = cursor + 46;
      const nameEnd = nameStart + nameLen;
      const extraEnd = nameEnd + extraLen;
      if (extraEnd > central.length) break;
      const name = decoder.decode(central.subarray(nameStart, nameEnd)).replace(/\\/g, "/");
      const extra = central.subarray(nameEnd, extraEnd);
      const needs = {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      };
      if (needs.uncompressed || needs.compressed || needs.offset) {
        const z = parseZip64Extra(extra, needs);
        if (needs.uncompressed) uncompressedSize = z.uncompressedSize;
        if (needs.compressed) compressedSize = z.compressedSize;
        if (needs.offset) localHeaderOffset = z.localHeaderOffset;
      }
      entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor = extraEnd + commentLen;
    }
    return entries;
  }

  function isMessageJson(name) {
    const n = String(name).replace(/\\/g, "/").toLowerCase();
    const base = n.split("/").pop() || "";
    return /^message_\d+\.json$/.test(base);
  }

  function isPreferredMessageJson(name) {
    const n = String(name).replace(/\\/g, "/").toLowerCase();
    return isMessageJson(n) && /(^|\/)messages\//.test(n);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("المتصفح قديم وما بدعم فك ZIP محليًا. حدّث Chrome.");
    }
    let stream;
    try {
      stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    } catch {
      throw new Error("المتصفح ما بدعم deflate-raw. حدّث Chrome لآخر نسخة.");
    }
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZipEntry(file, entry) {
    if (entry.flags & 1) throw new Error("ZIP مشفّر بكلمة مرور");
    if (![0, 8].includes(entry.method)) throw new Error(`ضغط ZIP غير مدعوم (${entry.method})`);
    const local = await readSlice(file, entry.localHeaderOffset, 30);
    const view = new DataView(local.buffer, local.byteOffset, local.byteLength);
    if (u32(view, 0) !== 0x04034b50) throw new Error("ZIP local header غير صالح");
    const nameLen = u16(view, 26);
    const extraLen = u16(view, 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const compressed = await readSlice(file, dataStart, entry.compressedSize);
    if (entry.method === 0) return compressed;
    return inflateRaw(compressed);
  }

  function isInstagramObject(data) {
    return data && typeof data === "object" && Array.isArray(data.messages) &&
      (Array.isArray(data.participants) || data.messages.some(m => m && typeof m.sender_name === "string"));
  }

  function splitInstagramObject(data, baseName) {
    const participants = Array.isArray(data.participants) ? data.participants : [];
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const files = [];
    let part = [];
    let approx = JSON.stringify({ participants, messages: [] }).length;
    let partNo = 1;

    function flush() {
      if (!part.length) return;
      const body = JSON.stringify({ participants, messages: part });
      files.push(new File([body], `${safeName(baseName)}-part-${partNo++}.json`, { type: "application/json" }));
      part = [];
      approx = JSON.stringify({ participants, messages: [] }).length;
    }

    for (const message of messages) {
      const chunk = JSON.stringify(message);
      if (part.length && approx + chunk.length + 2 > FILE_TARGET) flush();
      part.push(message);
      approx += chunk.length + 2;
    }
    flush();
    return files;
  }

  async function processJsonFile(file, baseName = file.name) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return [file]; }
    if (!isInstagramObject(data)) return [file];
    return splitInstagramObject(data, baseName);
  }

  async function extractInstagramFromZip(file) {
    setProgress(2, "بفحص ZIP محليًا... الصور والفيديو مش رح تنرفع");
    const entries = await listZipEntries(file);
    const preferred = entries.filter(e => isPreferredMessageJson(e.name));
    const candidates = preferred.length ? preferred : entries.filter(e => isMessageJson(e.name));
    if (!candidates.length) throw new Error("ما لقيت message_*.json داخل ZIP");

    const output = [];
    const warnings = [];
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i];
      const pct = 3 + Math.round(((i + 1) / candidates.length) * 42);
      setProgress(pct, `استخراج المسجات محليًا... ${i + 1}/${candidates.length}`);
      try {
        const bytes = await readZipEntry(file, entry);
        const data = JSON.parse(decoder.decode(bytes));
        if (!isInstagramObject(data)) continue;
        output.push(...splitInstagramObject(data, entry.name));
      } catch (error) {
        warnings.push(`${entry.name}: ${error.message}`);
      }
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 0));
    }
    if (!output.length) throw new Error(warnings[0] || "ما قدرت أقرأ مسجات Instagram من ZIP");
    if (warnings.length) console.warn("Instagram import warnings", warnings.slice(0, 20));
    return output;
  }

  async function sendBatch(files, batchNo, batchCount) {
    const fd = new FormData();
    for (const file of files) fd.append("files", file, file.name);
    const response = await fetch("/api/upload", { method: "POST", body: fd });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 413) throw new Error("حتى الدفعة الصغيرة رجعت 413. جرّب تحديث Codespace ثم أعد الرفع.");
      throw new Error(data.error || `Upload failed (${response.status})`);
    }
    return data;
  }

  function makeBatches(files) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const file of files) {
      if (file.size > REQUEST_LIMIT) throw new Error(`ملف JSON واحد أكبر من الحد بعد التقسيم: ${file.name}`);
      if (current.length && (current.length >= MAX_FILES_PER_BATCH || size + file.size > REQUEST_LIMIT)) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(file);
      size += file.size;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async function smartUpload(fileList) {
    const selected = [...(fileList || [])];
    if (!selected.length) return;
    try {
      const prepared = [];
      for (let i = 0; i < selected.length; i++) {
        const file = selected[i];
        const lower = file.name.toLowerCase();
        if (lower.endsWith(".zip")) prepared.push(...await extractInstagramFromZip(file));
        else if (lower.endsWith(".json")) prepared.push(...await processJsonFile(file));
        else {
          if (file.size > REQUEST_LIMIT) throw new Error(`${file.name} كبير على الرفع المباشر. للـInstagram ارفع ZIP أو JSON.`);
          prepared.push(file);
        }
      }

      const batches = makeBatches(prepared);
      let lastData = null;
      for (let i = 0; i < batches.length; i++) {
        const pct = 46 + Math.round(((i + 1) / batches.length) * 51);
        setProgress(pct, `رفع المسجات فقط... دفعة ${i + 1}/${batches.length}`);
        lastData = await sendBatch(batches[i], i + 1, batches.length);
      }

      setProgress(100, `تم: ${(lastData?.instagramChats || 0).toLocaleString("en-US")} شات • ${(lastData?.instagramMessages || 0).toLocaleString("en-US")} مسج`);
      showToast(`تمام — رفعت النصوص فقط وقرأت ${(lastData?.instagramMessages || 0).toLocaleString("en-US")} مسج`, 4500);
      if (typeof window.loadStatus === "function") await window.loadStatus();
      if (typeof window.loadChats === "function") await window.loadChats(true);
      if (typeof window.setView === "function") window.setView("chats");
      setTimeout(() => { const b = bar(); if (b) b.style.width = "0%"; }, 1800);
    } catch (error) {
      console.error(error);
      setProgress(0, "فشل الرفع");
      showToast(error.message || "Import failed", 7000);
    } finally {
      const input = $("#fileInput");
      if (input) input.value = "";
    }
  }

  window.uploadFiles = smartUpload;
  window.smartInstagramUpload = smartUpload;

  const input = $("#fileInput");
  if (input) input.onchange = () => smartUpload(input.files);

  console.log("MIRROR smart importer ready: ZIP media stays in the browser; only message JSON is uploaded.");
})();