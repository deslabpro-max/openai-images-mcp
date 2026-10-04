/**
 * MCP-инструменты генерации картинок: создать, доработать, список, удалить.
 * Картинки живут в KV 30 дней и раздаются по публичной неугадываемой ссылке —
 * она пригодна для photo_url телеграм-коннектора и для скачивания браузером.
 */
import {
  DICT_PREFIX,
  IMG_PREFIX,
  META_PREFIX,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  OaApiError,
  addSpend,
  b64ToBytes,
  buildGenerationBody,
  getSpend,
  imageCostUsd,
  isModelUnavailable,
  requireModel,
  requireQuality,
  supportsInputFidelity,
  createMaskToken,
  createUploadToken,
  fetchImageFromUrl,
  imageUrl,
  loadImage,
  loadMask,
  openaiCall,
  parseDictKey,
  parseMetaKey,
  storeImage,
  unixNow,
} from "./oa-api";

const MODEL_PROP = {
  type: "string",
  enum: [DEFAULT_MODEL, FALLBACK_MODEL],
  description:
    `Модель. По умолчанию ${DEFAULT_MODEL} — новее, точнее и дешевле по токенам; ` +
    `${FALLBACK_MODEL} нужна только если пользователь просит старое поведение. ` +
    "Если аккаунту новая модель недоступна, коннектор сам повторит вызов на старой.",
};

export const TOOLS = [
  {
    name: "generate_image",
    description:
      "Сгенерировать картинку по текстовому описанию (OpenAI gpt-image-1). Возвращает ссылку " +
      "на PNG (хранится 30 дней) — её можно отдать в photo_url телеграм-коннектора или открыть " +
      "в браузере. Промпт пиши подробно: стиль, композиция, свет, настроение. " +
      "Цена генерации: low ≈ $0.01–0.02, medium ≈ $0.04–0.06, high ≈ $0.17–0.25 за картинку; " +
      "точная сумма вызова возвращается в поле cost — называй её пользователю.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Описание картинки (можно по-русски)" },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
          description: "Размер: квадрат, альбомный, портретный или auto (по умолчанию)",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description:
            "ОБЯЗАТЕЛЬНО, и выбирает его ПОЛЬЗОВАТЕЛЬ: если он не назвал качество, сначала спроси " +
            "(low ≈ $0.01–0.02 — черновики, medium ≈ $0.04–0.06, high ≈ $0.17–0.25 — финал). " +
            "auto — только если пользователь сказал «всё равно»",
        },
        n: { type: "number", description: "Вариантов за раз, 1–4 (каждый оплачивается отдельно; по умолчанию 1)" },
        transparent_background: { type: "boolean", description: "Прозрачный фон (для стикеров/логотипов)" },
        model: MODEL_PROP,
      },
      required: ["prompt", "quality"],
    },
  },
  {
    name: "get_upload_link",
    description:
      "ВЫЗЫВАЙ ЭТО, КОГДА ПОЛЬЗОВАТЕЛЬ ПРИСЛАЛ ФОТО В ЧАТ и просит его отредактировать. " +
      "Вложение из чата нельзя передать коннектору напрямую — инструменты принимают только текст, " +
      "и файл до OpenAI не доедет. Это НЕ повод отвечать «не могу загрузить фото»: вызови " +
      "get_upload_link и дай пользователю ссылку — он откроет её (в том числе с телефона), выберет " +
      "фото из галереи, и оно окажется в хранилище за несколько секунд. Принимает любые фото, " +
      "включая HEIC с айфона — страница пересжимает их сама. Ссылка живёт 1 час, выдерживает " +
      "несколько загрузок. После загрузки фото — последняя запись в list_images (uploaded: true), " +
      "дальше правь его через edit_image.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "edit_image",
    description:
      "Доработать картинку: изменить детали, стиль, фон, дорисовать. Источник — либо image_id " +
      "(сгенерированное или загруженное фото из list_images), либо image_url — прямая https-ссылка " +
      "на JPG/PNG/WebP до 20 МБ (для файла из Google Drive: доступ «всем, у кого есть ссылка» и " +
      "URL вида https://drive.google.com/uc?export=download&id=<id файла>). " +
      "Фото, прикреплённое в чат Claude, источником быть НЕ может — сначала получи его через " +
      "get_upload_link и работай с полученным image_id. " +
      "Чтобы сохранить человека и заменить только фон, прямо напиши это в prompt. " +
      "ВАЖНО ПРО ЦЕНУ: правка фото ЗАМЕТНО дороже генерации — входное фото тоже оплачивается " +
      "токенами, а input_fidelity=high увеличивает вход; реальная цена вызова обычно $0.10–0.30 " +
      "(точная сумма — в поле cost ответа, называй её пользователю).",
    inputSchema: {
      type: "object",
      properties: {
        image_id: { type: "string", description: "id исходной картинки из хранилища коннектора" },
        image_url: { type: "string", description: "ИЛИ прямая https-ссылка на фото (вместо image_id)" },
        prompt: { type: "string", description: "Что изменить/дорисовать" },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description:
            "ОБЯЗАТЕЛЬНО, и выбирает его ПОЛЬЗОВАТЕЛЬ: если он не назвал качество, сначала спроси " +
            "(для правок: low ≈ $0.03–0.08, medium ≈ $0.07–0.15, high ≈ $0.20–0.35 за вызов)",
        },
        use_mask: {
          type: "boolean",
          description: "Применить маску, нарисованную через get_mask_link: меняется только закрашенная зона (только с image_id)",
        },
        input_fidelity: {
          type: "string",
          enum: ["high", "low"],
          description:
            `Только для ${FALLBACK_MODEL}: high (по умолчанию) — беречь исходник и лица. ` +
            `У ${DEFAULT_MODEL} точность входа всегда максимальная, параметр игнорируется`,
        },
        n: { type: "number", description: "Вариантов за раз, 1–4 (каждый оплачивается отдельно)" },
        model: MODEL_PROP,
      },
      required: ["prompt", "quality"],
    },
  },
  {
    name: "get_mask_link",
    description:
      "Ссылка на рисовалку маски для точечной правки: пользователь пальцем закрашивает зону, " +
      "которую МОЖНО менять (например, участок руки под татуировку) — всё остальное при правке " +
      "останется нетронутым пиксель-в-пиксель. После сохранения маски вызывай edit_image с " +
      "use_mask=true, а если фото несколько — compose_images с use_mask=true (маску тогда рисуют " +
      "для ПЕРВОГО фото из image_ids, к нему она и применится). Ссылка одноразовая, живёт 1 час.",
    inputSchema: {
      type: "object",
      properties: { image_id: { type: "string", description: "id картинки, для которой рисуем маску" } },
      required: ["image_id"],
    },
  },
  {
    name: "compose_images",
    description:
      "ЭТО ИНСТРУМЕНТ ДЛЯ ДВУХ И БОЛЕЕ ФОТО. Совместить их в одну картинку по описанию: «нанеси " +
      "татуировку со второго фото на руку девушки с первого», «надень куртку со второго фото», " +
      "коллаж, перенос стиля. 2–6 исходников из хранилища (id из list_images), порядок важен: " +
      "ПЕРВОЕ фото — то, которое меняем, остальные служат образцами; в prompt так и ссылайся — " +
      "«первое фото», «второе фото». Если пользователь прислал два фото в чат, пусть загрузит оба " +
      "по одной ссылке get_upload_link (страница принимает несколько файлов за раз), а потом " +
      "вызывай compose_images с обоими id. " +
      "Чтобы образец лёг в конкретное место (татуировка именно на этом участке руки), сначала " +
      "get_mask_link по ПЕРВОМУ image_id — пользователь закрашивает зону — и затем compose_images " +
      "с use_mask=true: вне закрашенного первое фото не изменится.",
    inputSchema: {
      type: "object",
      properties: {
        image_ids: {
          type: "array",
          items: { type: "string" },
          description: "id исходных картинок (2–6). Первая — та, которую меняем; дальше образцы",
        },
        prompt: { type: "string", description: "Что сделать из этих картинок" },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description:
            "ОБЯЗАТЕЛЬНО, и выбирает его ПОЛЬЗОВАТЕЛЬ: если он не назвал качество, сначала спроси " +
            "(для совмещения: low ≈ $0.03–0.08, medium ≈ $0.07–0.15, high ≈ $0.20–0.35 за вызов; " +
            "для фото людей осмысленны medium/high)",
        },
        use_mask: {
          type: "boolean",
          description: "Применить маску, нарисованную через get_mask_link для ПЕРВОГО image_id: меняется только закрашенная зона",
        },
        input_fidelity: {
          type: "string",
          enum: ["high", "low"],
          description:
            `Только для ${FALLBACK_MODEL}: high (по умолчанию) — беречь исходники и лица. ` +
            `У ${DEFAULT_MODEL} точность входа всегда максимальная, параметр игнорируется`,
        },
        n: { type: "number", description: "Вариантов за раз, 1–4 (каждый оплачивается отдельно)" },
        model: MODEL_PROP,
      },
      required: ["image_ids", "prompt", "quality"],
    },
  },
  {
    name: "get_spending",
    description:
      "Счётчик расходов на OpenAI через этот коннектор: сколько потрачено за текущий месяц и всего " +
      "(по точному usage из ответов API). Каждый generate/edit/compose и так возвращает поле cost — " +
      "этот инструмент для вопросов «сколько я потратил».",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_images",
    description: "Последние сгенерированные картинки: id, ссылка, промпт, когда создана.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Сколько показать (по умолчанию 10)" } },
    },
  },
  {
    name: "delete_image",
    description: "Удалить картинку из хранилища по id (ссылка перестанет работать).",
    inputSchema: {
      type: "object",
      properties: { image_id: { type: "string", description: "id картинки" } },
      required: ["image_id"],
    },
  },
];

// origin воркера прокидывается из mcp-server при каждом вызове.
function requireOrigin(args: any): string {
  return args._origin || "https://imagegen-connector.workers.dev";
}

/** Стоимость вызова из usage OpenAI + накопительные итоги в KV. */
async function costInfo(env: any, resp: any, model: string) {
  const usd = imageCostUsd(resp?.usage, model);
  if (usd === null) return { note: "OpenAI не вернул usage — стоимость этого вызова неизвестна." };
  const totals = await addSpend(env, usd);
  return { thisCallUsd: usd, monthUsd: totals.monthUsd, totalUsd: totals.totalUsd };
}

/** Зовёт OpenAI выбранной моделью, а если аккаунту она недоступна —
 *  автоматически повторяет запрос на старой. Возвращает и ответ, и то,
 *  какая модель в итоге сработала. */
async function callWithFallback(
  apiKey: string,
  path: string,
  model: string,
  makeBody: (model: string) => any,
): Promise<{ resp: any; model: string; fellBack: boolean }> {
  try {
    return { resp: await openaiCall(apiKey, path, makeBody(model)), model, fellBack: false };
  } catch (e: any) {
    if (model === FALLBACK_MODEL || !isModelUnavailable(e)) throw e;
    const resp = await openaiCall(apiKey, path, makeBody(FALLBACK_MODEL));
    return { resp, model: FALLBACK_MODEL, fellBack: true };
  }
}

const fallbackNote = (used: string, fellBack: boolean) =>
  fellBack
    ? ` Модель ${DEFAULT_MODEL} аккаунту недоступна — сделано на ${used} (проверь верификацию организации в OpenAI).`
    : "";

/** Складывает все вернувшиеся варианты в KV, возвращает [{image_id, url}]. */
async function storeResults(env: any, origin: string, resp: any, metaBase: any) {
  const items = (resp?.data || []).filter((d: any) => d?.b64_json);
  if (!items.length) throw new OaApiError("OpenAI не вернул картинку — попробуй другой промпт.");
  const out = [];
  for (const item of items) {
    const id = await storeImage(env, b64ToBytes(item.b64_json), metaBase);
    out.push({ image_id: id, url: imageUrl(origin, id) });
  }
  return out;
}

async function generateImage(env: any, props: any, args: any) {
  if (!props?.openaiKey) throw new OaApiError("Коннектор не настроен — переподключи его в настройках Claude.");
  const body = buildGenerationBody(args);
  const { resp, model, fellBack } = await callWithFallback(
    props.openaiKey, "/images/generations", body.model, (m) => ({ ...body, model: m }),
  );
  const results = await storeResults(env, requireOrigin(args), resp, {
    prompt: body.prompt.slice(0, 300),
    size: body.size,
    quality: body.quality,
    model,
  });
  return {
    status: "generated",
    ...(results.length === 1 ? results[0] : { variants: results }),
    cost: await costInfo(env, resp, model),
    model,
    size: body.size,
    quality: body.quality,
    note:
      "Ссылки живут 30 дней. Для публикации в Telegram передай url в photo_url инструмента publish_post. " +
      "Доработать: edit_image с image_id." + fallbackNote(model, fellBack),
  };
}

async function editImage(env: any, props: any, args: any) {
  if (!props?.openaiKey) throw new OaApiError("Коннектор не настроен — переподключи его в настройках Claude.");
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new OaApiError("Пустой prompt.");
  if (!args.image_id && !args.image_url) {
    throw new OaApiError("Укажи источник: image_id (из list_images) или image_url (прямая https-ссылка).");
  }

  let bytes: any;
  let ct: string;
  let sourceLabel: string;
  if (args.image_id) {
    const src = await loadImage(env, String(args.image_id));
    if (!src) throw new OaApiError(`Картинка ${args.image_id} не найдена (или истёк срок хранения).`);
    bytes = src.bytes;
    ct = src.ct;
    sourceLabel = `правка ${args.image_id}`;
  } else {
    if (args.use_mask) throw new OaApiError("Маска работает только с image_id (сначала загрузи фото в хранилище).");
    const fetched = await fetchImageFromUrl(String(args.image_url));
    bytes = fetched.bytes;
    ct = fetched.ct;
    sourceLabel = "правка по ссылке";
  }

  const n = args.n === undefined ? 1 : Number(args.n);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new OaApiError(`n — от 1 до 4, получено: ${args.n}`);

  const quality = requireQuality(
    args.quality,
    "правки/совмещения фото: low ≈ $0.03–0.08, medium ≈ $0.07–0.15, high ≈ $0.20–0.35 за вызов " +
      "(входные фото тоже оплачиваются)",
  );
  const mask = args.use_mask ? await loadMask(env, String(args.image_id)) : null;
  if (args.use_mask && !mask) {
    throw new OaApiError(
      "Маска для этой картинки не нарисована. Сначала вызови get_mask_link, дай пользователю " +
        "закрасить зону изменения, потом повтори правку с use_mask=true.",
    );
  }

  // Форма собирается заново под каждую попытку: у отправленной FormData тело
  // уже вычитано, повторно её слать нельзя.
  const makeForm = (model: string) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("quality", quality);
    form.append("n", String(n));
    // gpt-image-2 всегда бережёт исходник и отвечает 400 на этот параметр.
    if (supportsInputFidelity(model)) {
      form.append("input_fidelity", args.input_fidelity === "low" ? "low" : "high");
    }
    form.append("moderation", "low"); // мягкий режим всегда — как в generate
    form.append("image", new Blob([bytes], { type: ct }), `image.${ct.split("/")[1] || "png"}`);
    if (mask) form.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");
    return form;
  };

  const { resp, model, fellBack } = await callWithFallback(
    props.openaiKey, "/images/edits", requireModel(args.model), makeForm,
  );
  const results = await storeResults(env, requireOrigin(args), resp, {
    prompt: `[${sourceLabel}] ${prompt}`.slice(0, 300),
    editedFrom: args.image_id || args.image_url,
    model,
  });
  return {
    status: "edited",
    ...(results.length === 1 ? results[0] : { variants: results }),
    cost: await costInfo(env, resp, model),
    model,
    ...(args.use_mask ? { maskApplied: true } : {}),
    note: "Исходник не изменён — это новая картинка. Ссылка живёт 30 дней." + fallbackNote(model, fellBack),
  };
}

async function getMaskLink(env: any, props: any, args: any) {
  if (!props?.openaiKey) throw new OaApiError("Коннектор не настроен — переподключи его в настройках Claude.");
  const imageId = String(args.image_id || "");
  if (!(await loadImage(env, imageId))) {
    throw new OaApiError(`Картинка ${imageId} не найдена — маску рисуют по картинке из хранилища (list_images).`);
  }
  const token = await createMaskToken(env, imageId);
  return {
    mask_url: `${requireOrigin(args)}/mask/${token}`,
    note:
      "Дай эту ссылку пользователю: открыть → закрасить кистью зону, которую МОЖНО менять → " +
      "«Сохранить маску». Затем вызывай edit_image с этим image_id и use_mask=true. " +
      "Ссылка одноразовая, живёт 1 час.",
  };
}

async function composeImages(env: any, props: any, args: any) {
  if (!props?.openaiKey) throw new OaApiError("Коннектор не настроен — переподключи его в настройках Claude.");
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new OaApiError("Пустой prompt.");
  const ids = Array.isArray(args.image_ids) ? args.image_ids.map(String) : [];
  if (ids.length < 2 || ids.length > 6) throw new OaApiError("Нужно от 2 до 6 image_ids.");
  const n = args.n === undefined ? 1 : Number(args.n);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new OaApiError(`n — от 1 до 4, получено: ${args.n}`);

  const quality = requireQuality(
    args.quality,
    "правки/совмещения фото: low ≈ $0.03–0.08, medium ≈ $0.07–0.15, high ≈ $0.20–0.35 за вызов " +
      "(входные фото тоже оплачиваются)",
  );

  const sources = [];
  for (const id of ids) {
    const src = await loadImage(env, id);
    if (!src) throw new OaApiError(`Картинка ${id} не найдена (или истёк срок хранения).`);
    sources.push({ id, src });
  }

  // OpenAI применяет маску к ПЕРВОЙ картинке из набора — на неё и рисуем зону.
  let mask: ArrayBuffer | null = null;
  if (args.use_mask) {
    mask = await loadMask(env, ids[0]);
    if (!mask) {
      throw new OaApiError(
        `Маска для первого фото (${ids[0]}) не нарисована. Вызови get_mask_link с image_id=${ids[0]}, ` +
          "дай пользователю закрасить зону, потом повтори compose_images с use_mask=true. " +
          "Маска всегда применяется к первому фото из image_ids.",
      );
    }
  }

  const makeForm = (model: string) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("quality", quality);
    form.append("n", String(n));
    if (supportsInputFidelity(model)) {
      form.append("input_fidelity", args.input_fidelity === "low" ? "low" : "high");
    }
    form.append("moderation", "low");
    for (const { id, src } of sources) {
      form.append("image[]", new Blob([src.bytes], { type: src.ct }), `${id}.${src.ct.split("/")[1] || "png"}`);
    }
    if (mask) form.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");
    return form;
  };

  const { resp, model, fellBack } = await callWithFallback(
    props.openaiKey, "/images/edits", requireModel(args.model), makeForm,
  );
  const results = await storeResults(env, requireOrigin(args), resp, {
    prompt: `[совмещение ${ids.length} фото] ${prompt}`.slice(0, 300),
    composedFrom: ids,
    model,
  });
  return {
    status: "composed",
    ...(results.length === 1 ? results[0] : { variants: results }),
    cost: await costInfo(env, resp, model),
    model,
    ...(args.use_mask ? { maskApplied: ids[0] } : {}),
    note: "Исходники не изменены. Ссылка живёт 30 дней." + fallbackNote(model, fellBack),
  };
}

async function getSpending(env: any, _props: any, _args: any) {
  const s = await getSpend(env);
  return {
    ...s,
    note:
      "Суммы посчитаны из точного usage OpenAI (охватывают вызовы через этот коннектор; " +
      "траты вне коннектора здесь не видны). Полная картина биллинга — platform.openai.com/usage.",
  };
}

async function getUploadLink(env: any, props: any, args: any) {
  if (!props?.openaiKey) throw new OaApiError("Коннектор не настроен — переподключи его в настройках Claude.");
  const token = await createUploadToken(env);
  return {
    upload_url: `${requireOrigin(args)}/upload/${token}`,
    note:
      "Покажи эту ссылку пользователю прямым текстом и попроси открыть: выбрать фото (можно " +
      "несколько сразу, любой формат, включая HEIC с айфона) → «Загрузить». Ссылка живёт 1 час " +
      "и переживает неудачные попытки. Когда пользователь скажет, что загрузил, вызови list_images: " +
      "его фото будет сверху с uploaded: true — дальше правь через edit_image по этому image_id " +
      "(для фото бери quality medium или high).",
  };
}

async function listImages(env: any, props: any, args: any) {
  const limit = Math.min(Math.max(1, args.limit || 10), 50);
  const list = await env.OAUTH_KV.list({ prefix: META_PREFIX, limit: 1000 });
  const entries = (list.keys || [])
    .map((k: any) => parseMetaKey(k.name))
    .filter(Boolean)
    .sort((a: any, b: any) => b.created - a.created)
    .slice(0, limit);
  const out = [];
  for (const e of entries) {
    const metaKey = `${META_PREFIX}${String(e.created).padStart(12, "0")}:${e.id}`;
    const meta: any = await env.OAUTH_KV.get(metaKey, "json");
    out.push({
      image_id: e.id,
      url: imageUrl(requireOrigin(args), e.id),
      createdAgoMin: Math.round((unixNow() - e.created) / 60),
      prompt: meta?.prompt,
      // Фото самого пользователя — их он обычно и просит отредактировать.
      ...(meta?.uploaded ? { uploaded: true } : {}),
    });
  }
  return { images: out, ...(out.length ? {} : { note: "Хранилище пусто — сгенерируй первую через generate_image." }) };
}

async function deleteImage(env: any, props: any, args: any) {
  const id = String(args.image_id);
  const existed = await env.OAUTH_KV.get(IMG_PREFIX + id, "arrayBuffer");
  if (!existed) throw new OaApiError(`Картинка ${id} не найдена.`);
  await env.OAUTH_KV.delete(IMG_PREFIX + id);
  const list = await env.OAUTH_KV.list({ prefix: META_PREFIX, limit: 1000 });
  for (const k of list.keys || []) {
    if (k.name.endsWith(":" + id)) await env.OAUTH_KV.delete(k.name);
  }
  return { status: "deleted", image_id: id, note: "Картинка удалена, ссылка больше не работает." };
}

const IMPLEMENTATIONS: Record<string, (env: any, props: any, args: any) => Promise<any>> = {
  generate_image: generateImage,
  edit_image: editImage,
  get_upload_link: getUploadLink,
  get_mask_link: getMaskLink,
  compose_images: composeImages,
  get_spending: getSpending,
  list_images: listImages,
  delete_image: deleteImage,
};

export async function callTool(name: string, args: any, env: any, props: any): Promise<any> {
  const impl = IMPLEMENTATIONS[name];
  if (!impl) throw new OaApiError(`Неизвестный инструмент: ${name}`);
  return impl(env, props, args || {});
}
