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
const MY_NAME = process.env.MY_NAME || "Alaa 6001";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "missing" });
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const chatsDir = path.join(__dirname, "chats");
fs.mkdirSync(chatsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, chatsDir),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\p{L}\p{N}_. -]/gu, "_")}`)
});
const upload = multer({
  storage,
  limits: { files: 80, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith(".txt");
    cb(ok ? null : new Error("Only .txt WhatsApp files are allowed"), ok);
  }
});

const MSG_RE = /^[\u200e\u200f\ufeff]*\[(\d{1,2}\/\d{1,2}\/\d{4}),\s*(.*?)\]\s*([^:]+?):\s?(.*)$/;
const URL_RE = /https?:\/\/\S+/gi;
const PAY_RE = /https?:\/\/(?:www\.)?link\.yallapay\.live\/\S*/gi;
const IBAN_RE = /\bSA\d{2}[A-Z0-9]{10,}\b/gi;
const LONG_NUM_RE = /(?<![\d,])\d{5,}(?![\d,])/g;

const JUNK = [
  "messages and calls are end-to-end encrypted",
  "this business is now using a secure service from meta",
  "ai from meta receives messages",
  "pinned a message",
  "you deleted this message"
];
const MEDIA = ["image omitted","document omitted","video omitted","audio omitted","sticker omitted","gif omitted"];
const ONE_OFF = ["كيفية استرداد رمز الهدية","Go to User Profile - Settings - Gift Code","Gift code:","kXqZvtLP"];

function basic(text=""){
  let out=text.replace(/\u200e|\u200f|\ufeff/g,"").replace(/\s*<This message was edited>\s*/gi,"").trim();
  const lower=out.toLowerCase();
  const hits=ONE_OFF.map(x=>lower.indexOf(x.toLowerCase())).filter(x=>x>=0);
  if(hits.length) out=out.slice(0,Math.min(...hits));
  return out.split("\n").map(x=>x.trim()).filter(x=>{
    const l=x.toLowerCase();
    return x && !JUNK.some(j=>l.includes(j));
  }).map(x=>{
    for(const m of MEDIA) x=x.replace(new RegExp(m,"ig"),"");
    return x.trim();
  }).filter(Boolean).join("\n").trim();
}

function customerClean(text=""){
  return basic(text).replace(IBAN_RE,"[BANK_DETAILS]").replace(LONG_NUM_RE,"[ID]").replace(URL_RE,"[CUSTOMER_LINK]").trim();
}

function alaaClean(text=""){
  let out=basic(text), action="NONE";
  PAY_RE.lastIndex=0;
  if(PAY_RE.test(out)){ action="CREATE_PAYMENT_LINK"; PAY_RE.lastIndex=0; out=out.replace(PAY_RE,""); }
  PAY_RE.lastIndex=0; IBAN_RE.lastIndex=0;
  if(IBAN_RE.test(out)){ action=action==="NONE"?"SEND_BANK_DETAILS":`${action}|SEND_BANK_DETAILS`; IBAN_RE.lastIndex=0; out=out.replace(IBAN_RE,""); }
  IBAN_RE.lastIndex=0; URL_RE.lastIndex=0;
  if(URL_RE.test(out)){ action=action==="NONE"?"SEND_EXTERNAL_LINK":`${action}|SEND_EXTERNAL_LINK`; URL_RE.lastIndex=0; out=out.replace(URL_RE,""); }
  URL_RE.lastIndex=0;
  out=out.replace(LONG_NUM_RE,"").split("\n").map(x=>x.trim()).filter(Boolean).join("\n");
  return {reply:out.trim(),action};
}

function parseFile(file){
  const lines=fs.readFileSync(file,"utf8").split(/\r?\n/);
  const messages=[]; let current=null;
  for(const line of lines){
    const m=line.match(MSG_RE);
    if(m){ if(current) messages.push(current); current={sender:m[3].trim(),text:m[4]||""}; }
    else if(current) current.text+="\n"+line;
  }
  if(current) messages.push(current);

  const turns=[];
  for(const m of messages){
    const text=basic(m.text); if(!text) continue;
    const last=turns.at(-1);
    if(last && last.sender===m.sender) last.text+="\n"+text;
    else turns.push({sender:m.sender,text});
  }

  const pairs=[];
  for(let i=1;i<turns.length;i++){
    const prev=turns[i-1], cur=turns[i];
    if(cur.sender!==MY_NAME || prev.sender===MY_NAME) continue;
    const customer=customerClean(prev.text);
    const {reply,action}=alaaClean(cur.text);
    if(!customer || (!reply && action==="NONE")) continue;
    pairs.push({id:crypto.randomUUID(),customer,reply,action,source:path.basename(file)});
  }
  return pairs;
}

let records=[], index=null;
function rebuild(){
  const files=fs.readdirSync(chatsDir).filter(x=>x.toLowerCase().endsWith(".txt")).map(x=>path.join(chatsDir,x));
  records=[];
  for(const f of files){ try{records.push(...parseFile(f));}catch(e){console.warn("Parse error",f,e.message);} }
  index=new MiniSearch({
    fields:["customer","reply"],
    storeFields:["customer","reply","action","source"],
    searchOptions:{boost:{customer:3,reply:1},fuzzy:.2,prefix:true,combineWith:"OR"}
  });
  if(records.length) index.addAll(records);
  console.log(`🧠 ${records.length} examples indexed from ${files.length} chats`);
}
rebuild();

function retrieve(q,limit=10){
  if(!index || !records.length) return [];
  const out=[], seen=new Set();
  for(const r of index.search(q,{fuzzy:.25,prefix:true})){
    const k=`${r.customer}|${r.reply}`; if(seen.has(k)) continue; seen.add(k);
    out.push({customer:r.customer,reply:r.reply,action:r.action||"NONE",source:r.source,score:Number((r.score||0).toFixed(2))});
    if(out.length>=limit) break;
  }
  return out;
}

const SYSTEM=`You are the work reply assistant for Alaa 6001.
Use retrieved historical WhatsApp examples only as style/workflow references.
Rules:
- Match the customer's language exactly: Arabic->Arabic, English->English.
- Keep Alaa's real style: short, casual, friendly, direct.
- Never reveal/copy another customer's ID, name, bank data, phone, receipt or payment link.
- Never invent a payment link, bank details, support number, customer ID, payment confirmation or completed action.
- Historical prices/policies may be outdated. Do not invent current business facts.
- If an external system is needed, put it in "action" instead of pretending it happened.
- Suggested actions: NONE, CREATE_PAYMENT_LINK, SEND_BANK_DETAILS, SEND_SUPPORT_CONTACT, CHECK_PAYMENT, CHECK_ACCOUNT, ASK_FOR_ID.
Return JSON only: {"reply":"customer-facing reply","action":"internal action","note":"very short internal note"}.`;

app.get("/api/status",(_,res)=>{
  const files=fs.readdirSync(chatsDir).filter(x=>x.toLowerCase().endsWith(".txt"));
  res.json({ok:true,model:MODEL,chatFiles:files.length,examples:records.length,apiKeyConfigured:Boolean(process.env.GROQ_API_KEY)});
});

app.post("/api/upload",upload.array("files",80),(req,res)=>{
  rebuild();
  res.json({ok:true,uploaded:req.files?.length||0,examples:records.length});
});

app.post("/api/chat",async(req,res)=>{
  try{
    if(!process.env.GROQ_API_KEY) return res.status(400).json({error:"GROQ_API_KEY missing in .env"});
    const message=String(req.body?.message||"").trim();
    if(!message) return res.status(400).json({error:"Message required"});
    const history=Array.isArray(req.body?.history)?req.body.history.slice(-6):[];
    const examples=retrieve(message,10);
    const exText=examples.length?examples.map((x,i)=>`Example ${i+1}\nCUSTOMER:\n${x.customer}\nALAA:\n${x.reply||"[no text]"}\nACTION:${x.action}`).join("\n\n---\n\n"):"No examples loaded.";
    const hist=history.length?history.map(x=>`${x.role==="user"?"CUSTOMER":"ALAA"}: ${x.content}`).join("\n"):"No live context.";
    const c=await groq.chat.completions.create({
      model:MODEL,
      reasoning_effort:"low",
      temperature:.35,
      max_completion_tokens:500,
      response_format:{type:"json_object"},
      messages:[
        {role:"system",content:SYSTEM},
        {role:"user",content:`RETRIEVED EXAMPLES:\n${exText}\n\nLIVE CONTEXT:\n${hist}\n\nNEW CUSTOMER MESSAGE:\n${message}\n\nReturn JSON only.`}
      ]
    });
    const raw=c.choices?.[0]?.message?.content||"{}";
    let p; try{p=JSON.parse(raw);}catch{p={reply:raw,action:"NONE",note:""};}
    res.json({ok:true,reply:String(p.reply||"").trim(),action:String(p.action||"NONE"),note:String(p.note||""),examples});
  }catch(e){ console.error(e); res.status(500).json({error:e.message||"Groq request failed"}); }
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`⚡ ALAA AI: http://localhost:${PORT}`);
  console.log(`🧠 ${MODEL}`);
});
