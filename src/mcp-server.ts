/**
 * Минимальный MCP-сервер (Streamable HTTP, stateless) на /mcp.
 *
 * claude.ai шлёт JSON-RPC 2.0 сообщения POST-запросами; отвечаем обычным
 * application/json. Авторизацию уже проверил OAuthProvider — API-ключ OpenAI
 * лежит в ctx.props. Origin воркера прокидывается в инструменты, чтобы они
 * строили публичные ссылки на картинки.
 */
import { TOOLS, callTool } from "./tools";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_VERSION = "2025-06-18";

const SERVER_INFO = { name: "openai-images", version: "2.5.0" };

const INSTRUCTIONS =
  "Генерация и правка картинок через OpenAI gpt-image-1 (платно, с баланса OpenAI пользователя: " +
  "low ≈ $0.01–0.02, medium ≈ $0.04–0.06, high ≈ $0.17–0.25 за штуку). " +
  "ГЛАВНОЕ ПРО ФОТО ПОЛЬЗОВАТЕЛЯ: если он прикрепил фото в чат и просит его отредактировать, " +
  "ты НЕ можешь передать это вложение коннектору — MCP-инструменты принимают только текстовые " +
  "аргументы, и байты картинки в них не пролезают. Никогда не отвечай на это «не могу загрузить " +
  "фото» и не предлагай описать его словами: сразу вызови get_upload_link, дай пользователю " +
  "ссылку, попроси открыть и выбрать то же фото из галереи (страница принимает любой формат, " +
  "включая HEIC с айфона, и несколько фото за раз). Как только он подтвердит загрузку — list_images, " +
  "взять верхние записи с uploaded: true и править их. " +
  "ЕСЛИ ФОТО ДВА И БОЛЬШЕ (человек + образец татуировки, человек + предмет одежды) — это НЕ повод " +
  "отказываться и не повод звать edit_image дважды: пусть пользователь загрузит все фото по ОДНОЙ " +
  "ссылке (страница берёт несколько файлов за раз), а потом вызывай compose_images со всеми id — " +
  "первым тот снимок, который меняем. Для попадания в конкретное место добавь маску: get_mask_link " +
  "по первому id → compose_images с use_mask=true. " +
  "generate_image возвращает " +
  "ссылку на PNG (живёт 30 дней) — её можно открыть в браузере или передать в photo_url " +
  "телеграм-коннектора для публикации в канал. Альтернатива загрузке — image_url в edit_image: " +
  "прямая ссылка на файл, например из " +
  "Google Drive с доступом по ссылке (URL вида https://drive.google.com/uc?export=download&id=<id>; " +
  "id файла бери через Drive-коннектор). Загруженное фото первое в list_images, и его можно " +
  "править edit_image («сохрани человека без изменений, замени фон на …» — для фото бери quality " +
  "medium или high; input_fidelity=high включён по умолчанию и бережёт лица). Для точечных правок " +
  "(тату на руке, замена одной детали) предложи маску: get_mask_link → пользователь закрашивает " +
  "зону → edit_image с use_mask=true — незакрашенное не изменится совсем. compose_images совмещает " +
  "2–6 картинок («куртку со второго фото — на человека с первого»). n=2–4 даёт варианты на выбор " +
  "(каждый оплачивается). Фильтр модерации всегда в самом мягком официальном режиме (moderation=low); " +
  "если OpenAI всё же отклонил запрос — это их жёсткие серверные правила, переформулируй промпт. " +
  "МОДЕЛЬ: по умолчанию gpt-image-2 (новее и дешевле по токенам, чем gpt-image-1); менять её не " +
  "нужно, если пользователь не просит. У gpt-image-2 точность входных фото всегда максимальная, " +
  "поэтому input_fidelity к ней не применяется. Если аккаунту новая модель недоступна, коннектор " +
  "сам повторит вызов на gpt-image-1 и скажет об этом в note. " +
  "КАЧЕСТВО ВСЕГДА ВЫБИРАЕТ ПОЛЬЗОВАТЕЛЬ: параметр quality обязателен, и если пользователь не " +
  "назвал качество сам — сначала задай ему вопрос с ценами (low — черновик, medium, high — финал; " +
  "для правок фото цены выше, см. описания инструментов) и только потом вызывай инструмент. " +
  "Без quality инструмент откажет. Не выбирай качество за пользователя; auto — только если он " +
  "явно сказал «всё равно». " +
  "ДЕНЬГИ: каждый generate/edit/compose возвращает поле cost (точная стоимость вызова по usage " +
  "OpenAI + итоги за месяц и всего) — ВСЕГДА называй пользователю стоимость операции сразу после " +
  "неё, не жди вопроса. Помни: правка/совмещение фото дороже генерации ($0.10–0.30 за вызов из-за " +
  "оплаты входных фото и input_fidelity=high). На вопрос «сколько я потратил» — get_spending. " +
  "Промпты пиши развёрнуто; для дорогих генераций (high, n>1) сначала уточни у пользователя, " +
  "что он согласен.";

function rpcResult(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg: any, env: any, props: any, origin: string): Promise<any | undefined> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }

  if (msg.method === "initialize") {
    const requested = msg.params?.protocolVersion;
    return rpcResult(msg.id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }

  // Уведомления (нет id) — принимаем и молчим.
  if (msg.id === undefined || msg.id === null) return undefined;

  switch (msg.method) {
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      try {
        const result = await callTool(
          name,
          { ...(msg.params?.arguments || {}), _origin: origin },
          env,
          props,
        );
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        });
      } catch (e: any) {
        return rpcResult(msg.id, {
          content: [{ type: "text", text: `Ошибка: ${e?.message || e}` }],
          isError: true,
        });
      }
    }
    case "resources/list":
      return rpcResult(msg.id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(msg.id, { resourceTemplates: [] });
    case "prompts/list":
      return rpcResult(msg.id, { prompts: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export const mcpHandler = {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed: этот сервер принимает только POST", { status: 405 });
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
    }

    const props = ctx.props;
    const origin = new URL(request.url).origin;
    const messages = Array.isArray(payload) ? payload : [payload];
    const responses = (
      await Promise.all(messages.map((m) => handleMessage(m, env, props, origin)))
    ).filter((r) => r !== undefined);

    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(payload) ? responses : responses[0]);
  },
};
