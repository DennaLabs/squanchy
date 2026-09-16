export interface ChatArgs {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
}

export async function chat({ apiKey, model, system, user, temperature = 0.2 }: ChatArgs): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/squanchy",
    "X-Title": "squanchy",
  };
  headers["Authorization"] = ["Bearer", apiKey].join(" ");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
}
