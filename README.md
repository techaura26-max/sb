# ALAA // AI — Groq + Local RAG

واجهة مودرن جاهزة لـ GitHub Codespaces.

## التشغيل

1. ارفع ملفات المشروع إلى Repo جديد.
2. افتح: Code → Codespaces → Create codespace.
3. داخل Terminal:

```bash
npm install
cp .env.example .env
```

4. افتح `.env` وحط:

```env
GROQ_API_KEY=gsk_xxxxxxxxx
GROQ_MODEL=openai/gpt-oss-120b
MY_NAME=Alaa 6001
PORT=3000
```

5. شغّل:

```bash
npm start
```

6. Codespaces سيظهر Port 3000. اضغط **Open in Browser**.

## الشاتات

عندك طريقتين:
- اسحب ملفات WhatsApp `.txt` إلى مجلد `chats/`.
- أو افتح الواجهة وارمِ ملفات `.txt` في مربع الرفع.

النظام يقرأ الشاتات محليًا ويستخرج Customer → Alaa، ثم عند كل رسالة يبحث عن أقرب أمثلة ويرسل فقط الأمثلة المختارة إلى Groq.

## مهم

- لا ترفع `.env` إلى GitHub.
- ملفات `chats/*.txt` موجودة في `.gitignore`.
- روابط YallaPay وIBAN والأرقام الطويلة لا تُستخدم كأجوبة للموديل.
- المشروع RAG وليس fine-tune.
