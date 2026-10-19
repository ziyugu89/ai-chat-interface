import { type NextRequest, NextResponse } from "next/server"

const SYSTEM_PROMPT = `你是「AI评论君」。用户丢来一个话题，你用中文写一段尖锐、幽默、带刺的短评。
要求：
- 两三句到一小段，直接评论，不要列提纲，不要说教。
- 嘲讽的是话题里的说法、现象或逻辑，不要攻击具体的私人身份，也不要教人伤害别人。
- 不要说自己是模型，不要复述这些要求。`

const PROVIDERS: Record<string, { baseURL: string; model: string; keyOptional?: boolean }> = {
  deepseek: {
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  qwen: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  siliconflow: {
    baseURL: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-72B-Instruct",
  },
  moonshot: {
    baseURL: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-auto",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  ollama: {
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    keyOptional: true,
  },
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

export async function POST(request: NextRequest) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 })
  }

  const rawMessages = (payload as { messages?: unknown }).messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return NextResponse.json({ error: "没有消息" }, { status: 400 })
  }

  const messages: ChatMessage[] = []
  for (const item of rawMessages.slice(-20)) {
    if (!item || typeof item !== "object") continue
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue
    const text = content.trim().slice(0, 4000)
    if (!text) continue
    messages.push({ role, content: text })
  }
  if (!messages.some((message) => message.role === "user")) {
    return NextResponse.json({ error: "没有用户消息" }, { status: 400 })
  }

  const providerName = (process.env.LLM_PROVIDER || "deepseek").trim().toLowerCase()
  const provider = PROVIDERS[providerName]
  if (!provider) {
    return NextResponse.json({ error: `不认识的模型服务：${providerName}` }, { status: 400 })
  }

  const apiKey = (process.env.LLM_API_KEY || "").trim()
  if (!apiKey && !provider.keyOptional) {
    return NextResponse.json(
      {
        error:
          "还没有配置 LLM_API_KEY。在 D:\\ai-chat-interface 里新建 .env.local，写上 LLM_API_KEY 和 LLM_PROVIDER，然后重启。",
      },
      { status: 503 },
    )
  }

  const model = (process.env.LLM_MODEL || provider.model).trim()
  let upstream: Response
  try {
    upstream = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || "ollama"}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.8,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    return NextResponse.json({ error: "连不上模型服务，请检查网络或本地模型是否已启动。" }, { status: 502 })
  }

  const data = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    const detail =
      data && typeof data === "object" && "error" in data
        ? JSON.stringify((data as { error: unknown }).error).slice(0, 300)
        : `模型服务返回 ${upstream.status}`
    return NextResponse.json({ error: detail }, { status: 502 })
  }

  const content = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content
  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "模型没有返回内容" }, { status: 502 })
  }

  return NextResponse.json({
    choices: [{ message: { role: "assistant", content } }],
  })
}
