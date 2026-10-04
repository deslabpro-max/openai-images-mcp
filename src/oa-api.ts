/**
 * Клиент OpenAI Images API (gpt-image-1) и хранилище картинок в KV.
 *
 * Сгенерированные PNG складываются в KV с TTL 30 дней и раздаются по
 * неугадываемой публичной ссылке /i/<uuid> — её можно отдавать напрямую
 * в photo_url телеграм-коннектора или скачивать браузером.
 */

const OPENAI_BASE = "https://api.openai.com/v1";

export class OaApiError extends Error {}

export const unixNow = (): number => Math.floor(Date.now() / 1000);

export const IMAGE_TTL_DAYS = 30;
export const IMG_PREFIX = "img:"; // img:<uuid> → бинарный PNG
export const META_PREFIX = "imgm:"; // imgm:<unix12>:<uuid> → метаданные (для списка)

export const ALLOWED_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"];
export const ALLOWED_QUALITY = ["low", "medium", "high", "auto"];

// Модель по умолчанию — gpt-image-2 (вышла весной 2026): качество выше,
// а токены дешевле, чем у gpt-image-1. Если у аккаунта нет к ней доступа,
// вызовы автоматически повторяются на FALLBACK_MODEL.
export const DEFAULT_MODEL = "gpt-image-2";
export const FALLBACK_MODEL = "gpt-image-1";
export const ALLOWED_MODELS = [DEFAULT_MODEL, FALLBACK_MODEL];

/** gpt-image-2 всегда работает с максимальной точностью входных картинок и
 *  отвечает 400 на сам параметр input_fidelity — шлём его только старой. */
export function supportsInputFidelity(model: string): boolean {
  return model === FALLBACK_MODEL;
}

export function requireModel(model: any): string {
  const m = model || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(m)) {
    throw new OaApiError(`Неизвестная модель «${model}». Доступны: ${ALLOWED_MODELS.join(", ")}`);
  }
  return m;
}

/** Аккаунт без доступа к модели (не оплачен, не верифицирован, модель снята). */
export function isModelUnavailable(err: any): boolean {
  return /model_not_found|does not exist|do not have access|not have access|unsupported.*model|must be verified/i.test(
    String(err?.message || err),
  );
}

export async function openaiCall(apiKey: string, path: string, body: any): Promise<any> {
  const resp = await fetch(OPENAI_BASE + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body instanceof FormData ? {} : { "content-type": "application/json" }),
    },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) {
      throw new OaApiError("OpenAI не принял API-ключ (401). Переподключи коннектор с действующим ключом.");
    }
    if (resp.status === 429) {
      throw new OaApiError(`OpenAI: лимит запросов или исчерпан баланс — ${msg}`);
    }
    throw new OaApiError(`OpenAI API ${path}: ${msg}`);
  }
  return json;
}

/** Лёгкая проверка ключа при подключении (без затрат): достаточно доступа
 *  хотя бы к одной из моделей — новой или старой. */
export async function validateKey(apiKey: string): Promise<void> {
  let lastStatus = 0;
  for (const model of ALLOWED_MODELS) {
    const resp = await fetch(`${OPENAI_BASE}/models/${model}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (resp.ok) return;
    if (resp.status === 401) throw new OaApiError("OpenAI не принял этот API-ключ.");
    lastStatus = resp.status;
  }
  if (lastStatus === 403 || lastStatus === 404) {
    throw new OaApiError(
      `Ключ рабочий, но модели картинок (${ALLOWED_MODELS.join(", ")}) недоступны — проверь, что ` +
        "в аккаунте OpenAI включён биллинг и организация верифицирована для Images API.",
    );
  }
  throw new OaApiError(`OpenAI ответил ${lastStatus} — попробуй ещё раз.`);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Кладёт картинку в KV (тип файла — в metadata ключа), возвращает id. */
export async function storeImage(
  env: any,
  bytes: Uint8Array,
  meta: any,
  contentType = "image/png",
): Promise<string> {
  const id = crypto.randomUUID();
  const ttl = IMAGE_TTL_DAYS * 86400;
  await env.OAUTH_KV.put(IMG_PREFIX + id, bytes.buffer as ArrayBuffer, {
    expirationTtl: ttl,
    metadata: { ct: contentType },
  });
  await env.OAUTH_KV.put(
    `${META_PREFIX}${String(unixNow()).padStart(12, "0")}:${id}`,
    JSON.stringify({ ...meta, contentType }),
    { expirationTtl: ttl },
  );
  return id;
}

/** Байты + тип сохранённой картинки (для правок и раздачи). */
export async function loadImage(env: any, id: string): Promise<{ bytes: ArrayBuffer; ct: string } | null> {
  const { value, metadata } = await env.OAUTH_KV.getWithMetadata(IMG_PREFIX + id, "arrayBuffer");
  if (!value) return null;
  return { bytes: value, ct: (metadata as any)?.ct || "image/png" };
}

export function imageUrl(origin: string, id: string): string {
  return `${origin}/i/${id}`;
}

export function parseMetaKey(key: string): { created: number; id: string } | null {
  const m = key.match(/^imgm:(\d{12}):(.+)$/);
  return m ? { created: Number(m[1]), id: m[2] } : null;
}

/** Качество всегда выбирает пользователь: без явного quality инструмент
 *  отказывает с текстом-вопросом, который Claude передаст в чат. */
export function requireQuality(quality: any, priceHint: string): string {
  if (!quality) {
    throw new OaApiError(
      "Качество не выбрано. Спроси пользователя, какое качество взять для " + priceHint +
        ". Когда ответит — повтори вызов с его выбором (если пользователю всё равно, передай auto).",
    );
  }
  if (!ALLOWED_QUALITY.includes(quality)) {
    throw new OaApiError(`Недопустимое quality «${quality}». Можно: ${ALLOWED_QUALITY.join(", ")}`);
  }
  return quality;
}

/** Валидация параметров генерации (до похода в API). */
export function buildGenerationBody(args: {
  prompt: string;
  size?: string;
  quality?: string;
  n?: number;
  transparent_background?: boolean;
  model?: string;
}): any {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new OaApiError("Пустой prompt.");
  const size = args.size || "auto";
  if (!ALLOWED_SIZES.includes(size)) {
    throw new OaApiError(`Недопустимый size «${args.size}». Можно: ${ALLOWED_SIZES.join(", ")}`);
  }
  const quality = requireQuality(args.quality, "генерации: low ≈ $0.01–0.02, medium ≈ $0.04–0.06, high ≈ $0.17–0.25 за картинку");
  const n = args.n === undefined ? 1 : Number(args.n);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new OaApiError(`n — от 1 до 4 вариантов, получено: ${args.n}. Каждый вариант оплачивается отдельно.`);
  }
  return {
    model: requireModel(args.model),
    prompt,
    size,
    quality,
    n,
    // Наименее строгий из официальных режимов фильтрации — всегда:
    // ложных отказов меньше, а жёсткое ядро правил OpenAI работает
    // на их серверах в любом случае.
    moderation: "low",
    ...(args.transparent_background ? { background: "transparent" } : {}),
  };
}

// ---------- Счётчик расходов ----------
// Стоимость считается из usage, который OpenAI возвращает в каждом ответе, —
// это точный расход токенов, а не прикидка. Цены на 2026-08, $ за 1 млн
// токенов. При смене прайса OpenAI поправить таблицу здесь.
export const PRICES_PER_MTOK: Record<string, { textIn: number; imageIn: number; imageOut: number }> = {
  "gpt-image-2": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-1": { textIn: 5, imageIn: 10, imageOut: 40 },
};

export function imageCostUsd(usage: any, model: string = DEFAULT_MODEL): number | null {
  const out = Number(usage?.output_tokens) || 0;
  if (!out) return null;
  const p = PRICES_PER_MTOK[model] || PRICES_PER_MTOK[DEFAULT_MODEL];
  const text = Number(usage?.input_tokens_details?.text_tokens) || 0;
  const img = Number(usage?.input_tokens_details?.image_tokens) || 0;
  const usd = (text * p.textIn + img * p.imageIn + out * p.imageOut) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

export const SPEND_KEY = "spend:v1";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Копит расход в KV (всего и помесячно), возвращает свежие итоги. */
export async function addSpend(env: any, usd: number): Promise<{ monthUsd: number; totalUsd: number }> {
  const rec: any = (await env.OAUTH_KV.get(SPEND_KEY, "json")) || { totalUsd: 0, byMonth: {}, ops: 0 };
  const month = new Date().toISOString().slice(0, 7);
  rec.totalUsd = round4((rec.totalUsd || 0) + usd);
  rec.byMonth[month] = round4((rec.byMonth[month] || 0) + usd);
  rec.ops = (rec.ops || 0) + 1;
  await env.OAUTH_KV.put(SPEND_KEY, JSON.stringify(rec));
  return { monthUsd: rec.byMonth[month], totalUsd: rec.totalUsd };
}

export async function getSpend(env: any): Promise<any> {
  const rec: any = (await env.OAUTH_KV.get(SPEND_KEY, "json")) || { totalUsd: 0, byMonth: {}, ops: 0 };
  const month = new Date().toISOString().slice(0, 7);
  return {
    currentMonth: month,
    currentMonthUsd: rec.byMonth?.[month] || 0,
    totalUsd: rec.totalUsd || 0,
    operations: rec.ops || 0,
    byMonth: rec.byMonth || {},
  };
}

/** Раздача картинки по /i/<id> (публично, id неугадываемый). */
export async function serveImage(env: any, id: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const img = await loadImage(env, id);
  if (!img) {
    return new Response("Картинка не найдена или истёк срок хранения (30 дней).", { status: 404 });
  }
  return new Response(img.bytes, {
    headers: {
      "content-type": img.ct,
      "cache-control": "public, max-age=86400",
      "content-disposition": `inline; filename="${id}.${img.ct.split("/")[1] || "png"}"`,
    },
  });
}

// ---------- Загрузка своих фото ----------
// Одноразовая ссылка выдаётся инструментом get_upload_link (то есть только
// авторизованному пользователю), сама страница /upload/<токен> публичная,
// но токен неугадываемый, живёт 1 час и сгорает после использования.

export const UPLOAD_PREFIX = "upl:";
export const UPLOAD_TTL_SEC = 3600;
// Потолок KV на значение — 25 МиБ, поэтому исходник принимаем с запасом.
// Страница загрузки всё равно ужимает фото до MAX_EDGE перед отправкой.
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
// Что умеет принимать OpenAI images/edits. HEIC с айфона сюда не входит —
// его пересжимает в PNG/JPEG сама страница загрузки (Safari декодирует HEIC).
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"];
// Длинная сторона, до которой страница ужимает фото: gpt-image-1 работает
// с ~1024–1536 px, больше — только лишние мегабайты и риск упереться в лимит.
export const MAX_EDGE = 2048;
// Ссылка живёт час и переживает неудачные попытки (неверный формат, обрыв
// связи): сгорает только по успешным загрузкам, чтобы одна опечатка
// не заставляла просить у Claude новую ссылку.
export const UPLOAD_MAX_USES = 10;

/** Тип картинки по сигнатуре файла — заголовку/расширению не доверяем:
 *  iOS отдаёт HEIC как image/heic или вовсе с пустым type, а Google Drive
 *  умеет присылать картинку под application/octet-stream. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  // ISO-BMFF: ....ftyp<brand>. Бренды heic/heix/hevc/mif1/msf1 — это HEIF с айфона.
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(brand)) return "image/heic";
  }
  return null;
}

/** Тип загруженного файла: сначала сигнатура, потом заявленный браузером. */
export function resolveUploadType(bytes: Uint8Array, declared?: string): string | null {
  return sniffImageType(bytes) || (UPLOAD_TYPES.includes(String(declared)) ? String(declared) : null);
}

export async function createUploadToken(env: any): Promise<string> {
  const token = crypto.randomUUID();
  await env.OAUTH_KV.put(UPLOAD_PREFIX + token, JSON.stringify({ left: UPLOAD_MAX_USES }), {
    expirationTtl: UPLOAD_TTL_SEC,
  });
  return token;
}

/** Сколько загрузок осталось у токена (0 — токена нет или он исчерпан).
 *  Понимает и старый формат значения ("1") от прежних версий воркера. */
async function uploadUsesLeft(env: any, token: string): Promise<number> {
  if (!/^[0-9a-f-]{36}$/.test(token)) return 0;
  const raw = await env.OAUTH_KV.get(UPLOAD_PREFIX + token);
  if (!raw) return 0;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  // Прежняя версия воркера писала сюда просто "1" — такой токен доживает
  // свой час как одноразовый, а не считается исчерпанным.
  if (!parsed || typeof parsed !== "object") return 1;
  const left = Number(parsed.left);
  return Number.isFinite(left) && left > 0 ? left : 0;
}

/** Списывает одну удачную загрузку. Вызывать ТОЛЬКО после того, как файл
 *  принят и сохранён, иначе неудачная попытка убивает рабочую ссылку. */
export async function consumeUploadToken(env: any, token: string): Promise<boolean> {
  const left = await uploadUsesLeft(env, token);
  if (!left) return false;
  if (left <= 1) {
    await env.OAUTH_KV.delete(UPLOAD_PREFIX + token);
  } else {
    await env.OAUTH_KV.put(UPLOAD_PREFIX + token, JSON.stringify({ left: left - 1 }), {
      expirationTtl: UPLOAD_TTL_SEC,
    });
  }
  return true;
}

export async function isUploadTokenValid(env: any, token: string): Promise<boolean> {
  return (await uploadUsesLeft(env, token)) > 0;
}

// ---------- Маски для точечной правки ----------
// Ссылку на рисовалку маски выдаёт инструмент get_mask_link (только
// авторизованному), страница /mask/<токен> публичная, токен одноразовый.
// Готовая маска хранится рядом с картинкой: прозрачные места = «менять»,
// закрашенные = «не трогать» (формат OpenAI images/edits).

export const MASK_TOKEN_PREFIX = "mtk:";
export const MASK_PREFIX = "msk:";

export async function createMaskToken(env: any, imageId: string): Promise<string> {
  const token = crypto.randomUUID();
  await env.OAUTH_KV.put(MASK_TOKEN_PREFIX + token, imageId, { expirationTtl: UPLOAD_TTL_SEC });
  return token;
}

/** Возвращает image_id токена (не сжигая — сжигаем при сохранении маски). */
export async function peekMaskToken(env: any, token: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(token)) return null;
  return env.OAUTH_KV.get(MASK_TOKEN_PREFIX + token);
}

export async function consumeMaskToken(env: any, token: string): Promise<string | null> {
  const imageId = await peekMaskToken(env, token);
  if (imageId) await env.OAUTH_KV.delete(MASK_TOKEN_PREFIX + token);
  return imageId;
}

export async function storeMask(env: any, imageId: string, bytes: Uint8Array): Promise<void> {
  await env.OAUTH_KV.put(MASK_PREFIX + imageId, bytes.buffer as ArrayBuffer, {
    expirationTtl: IMAGE_TTL_DAYS * 86400,
  });
}

export async function loadMask(env: any, imageId: string): Promise<ArrayBuffer | null> {
  return env.OAUTH_KV.get(MASK_PREFIX + imageId, "arrayBuffer");
}

/** Скачивает фото по внешней ссылке (например, из расшаренной папки
 *  Google Drive). Только https, только image/*, не больше 10 МБ. */
export async function fetchImageFromUrl(url: string): Promise<{ bytes: Uint8Array; ct: string }> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new OaApiError(`Некорректный image_url: ${url}`);
  }
  if (u.protocol !== "https:") throw new OaApiError("image_url должен начинаться с https://");
  const resp = await fetch(u.toString(), { redirect: "follow" });
  if (!resp.ok) throw new OaApiError(`Не удалось скачать фото по ссылке (HTTP ${resp.status}).`);
  const declared = (resp.headers.get("content-type") || "").split(";")[0].trim();
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (!bytes.byteLength) throw new OaApiError("По ссылке пришёл пустой файл.");
  if (bytes.byteLength > UPLOAD_MAX_BYTES) throw new OaApiError("Фото по ссылке больше 20 МБ.");
  // Заголовку не верим: Drive отдаёт картинки как octet-stream, а страницу
  // «нет доступа» — как text/html. Решает сигнатура файла.
  const ct = resolveUploadType(bytes, declared);
  if (ct === "image/heic") {
    throw new OaApiError(
      "По ссылке HEIC-фото с айфона — OpenAI такой формат не принимает. " +
        "Дай пользователю ссылку из get_upload_link: страница загрузки пересжимает HEIC сама.",
    );
  }
  if (!ct) {
    throw new OaApiError(
      `По ссылке не картинка (content-type: ${declared || "неизвестен"}). ` +
        "Для Google Drive нужна прямая ссылка вида https://drive.google.com/uc?export=download&id=<id> " +
        "и доступ «всем, у кого есть ссылка» — иначе приходит HTML-страница входа.",
    );
  }
  return { bytes, ct };
}
