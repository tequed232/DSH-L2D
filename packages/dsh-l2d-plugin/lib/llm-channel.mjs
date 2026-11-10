/**
 * 宿主 LLM 调用通道（DeepSeek chat/completions，JSON 模式）。
 *
 * 从 index.js 的「戳一戳 API 决定动作」（requestDeepSeekPokeAction）抽出，供它与
 * AI 节点编辑（/dsh-l2d/api/nodegraph/ai-edit）共用同一条通道：同一端点、同一模型环境变量
 * DSH_L2D_API_MODEL（缺省 deepseek-chat）、同一 Key 来源（插件设置 apiKey > 环境变量
 * DEEPSEEK_API_KEY）、同样的硬超时。
 *
 * 安全约束：Key 只进 Authorization 头，绝不进返回值、错误信息或日志。
 */

export const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_LLM_TIMEOUT_MS = 10000;

/** 取 Key：插件设置优先，其次环境变量；都没有返回空串（调用方据此判定通道不可用）。 */
export function resolveDeepSeekKey(settings) {
  const fromSettings = settings && typeof settings.apiKey === 'string' ? settings.apiKey : '';
  return String(fromSettings || process.env.DEEPSEEK_API_KEY || '').trim();
}

/**
 * 发起一次 JSON 模式对话，返回解析后的 JSON 对象。
 * 失败抛 Error（message 不含 Key）：'HTTP <status> <body 前 180 字>' / 'API 返回不是 JSON'。
 *
 * @param {{key: string, system: string, user: string, temperature?: number, maxTokens?: number,
 *          timeoutMs?: number, fetchImpl?: typeof fetch, model?: string}} opts
 */
export async function deepseekChatJson(opts) {
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const model = opts.model || process.env.DSH_L2D_API_MODEL || 'deepseek-chat';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || DEFAULT_LLM_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        temperature: opts.temperature === undefined ? 1 : opts.temperature,
        max_tokens: opts.maxTokens || 900,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 180)}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    try {
      return JSON.parse(content);
    } catch {
      throw new Error('API 返回不是 JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}
