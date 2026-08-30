import "dotenv/config";
import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const response = await groq.chat.completions.create({
  model: "openai/gpt-oss-120b",
  messages: [
    {
      role: "system",
      content: `
You are a customer support assistant.
Reply briefly and naturally.
Match the customer's language.
Do not invent payment links, IDs, bank info, or completed actions.
      `,
    },
    {
      role: "user",
      content: "السلام عليكم",
    },
  ],
});

console.log(response.choices[0].message.content);