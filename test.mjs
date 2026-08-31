import "dotenv/config";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const response = await groq.chat.completions.create({
  model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  response_format: { type: "json_object" },
  messages: [
    {
      role: "system",
      content: `You are a personal reply ghostwriter. Reply naturally as the owner, match the user's language and texting tone, and return JSON only: {"reply":"..."}.`,
    },
    {
      role: "user",
      content: "NEW MESSAGE: وينك اليوم؟",
    },
  ],
});

console.log(response.choices[0].message.content);
