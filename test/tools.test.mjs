// Тесты коннектора картинок: сборка запросов, хранилище, инструменты
// с подменённым fetch и фейковым KV.
import test from "node:test";
import assert from "node:assert/strict";
import {
  UPLOAD_MAX_USES,
  buildGenerationBody,
  consumeUploadToken,
  createUploadToken,
  isUploadTokenValid,
  loadImage,
  parseMetaKey,
  resolveUploadType,
  serveImage,
  sniffImageType,
  storeImage,
  storeMask,
} from "../dist-test/oa-api.mjs";
import { TOOLS, callTool } from "../dist-test/tools.mjs";

const PROPS = { openaiKey: "sk-test" };
const ORIGIN = "https://imagegen-connector.example.workers.dev";
// 1x1 PNG (крошечный base64 для тестов)
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeEnv(route) {
  const kv = new Map();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const isForm = init.body instanceof FormData;
    calls.push({
      url: u,
      body: init.body && !isForm ? JSON.parse(init.body) : init.body,
      isForm,
      formKeys: isForm ? [...init.body.keys()] : undefined,
      formGet: isForm ? (k) => init.body.get(k) : undefined,
      auth: init.headers?.authorization,
    });
    const r = route(u, init);
    // Бинарный ответ (скачивание фото по внешней ссылке).
    if (r && r.__binary) {
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h.toLowerCase() === "content-type" ? r.__ct : null) },
        arrayBuffer: async () => r.__binary.buffer,
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => r,
    };
  };
  const meta = new Map();
  const env = {
    OAUTH_KV: {
      list: async ({ prefix }) => ({
        keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
      }),
      get: async (k, type) => {
        if (!kv.has(k)) return null;
        const v = kv.get(k);
        return type === "json" ? JSON.parse(v) : v;
      },
      getWithMetadata: async (k, _type) => ({
        value: kv.has(k) ? kv.get(k) : null,
        metadata: meta.get(k) ?? null,
      }),
      put: async (k, v, opts) => {
        kv.set(k, v);
        if (opts?.metadata) meta.set(k, opts.metadata);
      },
      delete: async (k) => {
        kv.delete(k);
        meta.delete(k);
      },
    },
  };
  return { env, calls, kv };
}

test("buildGenerationBody: дефолты и валидация параметров", () => {
  assert.throws(
    () => buildGenerationBody({ prompt: "кот в скафандре" }),
    /Качество не выбрано.*Спроси пользователя/s,
    "без quality — отказ с вопросом для пользователя",
  );
  const body = buildGenerationBody({ prompt: "кот в скафандре", quality: "auto" });
  assert.equal(body.model, "gpt-image-2", "по умолчанию — новая модель");
  assert.equal(
    buildGenerationBody({ prompt: "x", quality: "low", model: "gpt-image-1" }).model,
    "gpt-image-1",
    "старую модель можно попросить явно",
  );
  assert.throws(
    () => buildGenerationBody({ prompt: "x", quality: "low", model: "dall-e-3" }),
    /Неизвестная модель/,
  );
  assert.equal(body.size, "auto");
  assert.equal(body.n, 1);
  assert.throws(() => buildGenerationBody({ prompt: "" }), /Пустой prompt/);
  assert.throws(() => buildGenerationBody({ prompt: "x", size: "512x512" }), /Недопустимый size/);
  assert.throws(() => buildGenerationBody({ prompt: "x", quality: "ultra" }), /Недопустимое quality/);
});

test("parseMetaKey: обратим и отбрасывает мусор", () => {
  const p = parseMetaKey("imgm:000001755000:abc-def");
  assert.deepEqual(p, { created: 1755000, id: "abc-def" });
  assert.equal(parseMetaKey("img:xyz"), null);
});

test("generate_image: запрос в OpenAI, PNG в KV, ссылка на /i/", async () => {
  const { env, calls, kv } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }], usage: {} }));
  const res = await callTool(
    "generate_image",
    { prompt: "обложка поста про маркетинг", size: "1536x1024", quality: "medium", _origin: ORIGIN },
    env, PROPS,
  );
  assert.equal(res.status, "generated");
  assert.match(res.url, new RegExp(`^${ORIGIN}/i/[0-9a-f-]{36}$`));

  const gen = calls.find((c) => c.url.endsWith("/images/generations"));
  assert.equal(gen.auth, "Bearer sk-test");
  assert.equal(gen.body.size, "1536x1024");
  assert.equal(gen.body.quality, "medium");

  const imgKeys = [...kv.keys()].filter((k) => k.startsWith("img:"));
  const metaKeys = [...kv.keys()].filter((k) => k.startsWith("imgm:"));
  assert.equal(imgKeys.length, 1, "PNG лёг в KV");
  assert.equal(metaKeys.length, 1, "метаданные легли в KV");
});

test("serveImage: раздаёт PNG, мусорный id — 404", async () => {
  const { env, kv } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const res = await callTool("generate_image", { prompt: "тест", quality: "low", _origin: ORIGIN }, env, PROPS);
  const id = res.image_id;
  const ok = await serveImage(env, id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal((await serveImage(env, "not-a-uuid")).status, 404);
  assert.equal((await serveImage(env, crypto.randomUUID())).status, 404);
});

test("edit_image: исходник уходит multipart'ом, результат — новая картинка", async () => {
  const { env, calls } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const first = await callTool("generate_image", { prompt: "кот", quality: "low", _origin: ORIGIN }, env, PROPS);
  const res = await callTool(
    "edit_image", { image_id: first.image_id, prompt: "добавь шляпу", quality: "low", _origin: ORIGIN }, env, PROPS,
  );
  assert.equal(res.status, "edited");
  assert.notEqual(res.image_id, first.image_id, "правка — новая картинка, исходник цел");
  const edit = calls.find((c) => c.url.endsWith("/images/edits"));
  assert.equal(edit.isForm, true, "правка уходит multipart/form-data");
});

test("edit_image: несуществующий исходник — понятная ошибка", async () => {
  const { env } = makeEnv(() => ({}));
  await assert.rejects(
    () => callTool("edit_image", { image_id: "нет-такого", prompt: "x", quality: "low", _origin: ORIGIN }, env, PROPS),
    /не найдена/,
  );
});

test("list_images и delete_image: список новые-сверху, удаление чистит и мету", async () => {
  const { env, kv } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const a = await callTool("generate_image", { prompt: "первая", quality: "low", _origin: ORIGIN }, env, PROPS);
  const b = await callTool("generate_image", { prompt: "вторая", quality: "low", _origin: ORIGIN }, env, PROPS);

  const list = await callTool("list_images", { quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.equal(list.images.length, 2);
  assert.ok(list.images.some((i) => i.prompt === "вторая"));

  await callTool("delete_image", { image_id: a.image_id }, env, PROPS);
  assert.equal([...kv.keys()].filter((k) => k.includes(a.image_id)).length, 0, "PNG и мета удалены");
  const after = await callTool("list_images", { quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.equal(after.images.length, 1);
  assert.equal(after.images[0].image_id, b.image_id);
});

test("токен загрузки: несколько попыток в пределах лимита, потом сгорает", async () => {
  const { env } = makeEnv(() => ({}));
  const token = await createUploadToken(env);
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(await isUploadTokenValid(env, token), true);
  for (let i = 0; i < UPLOAD_MAX_USES; i++) {
    assert.equal(await consumeUploadToken(env, token), true, `загрузка ${i + 1} проходит`);
  }
  assert.equal(await isUploadTokenValid(env, token), false, "лимит исчерпан");
  assert.equal(await consumeUploadToken(env, token), false);
  assert.equal(await consumeUploadToken(env, "мусор"), false);
});

test("токен загрузки: старый формат значения от прежней версии воркера ещё работает", async () => {
  const { env } = makeEnv(() => ({}));
  const token = "00000000-0000-4000-8000-000000000001";
  await env.OAUTH_KV.put("upl:" + token, "1");
  assert.equal(await isUploadTokenValid(env, token), true);
  assert.equal(await consumeUploadToken(env, token), true);
  assert.equal(await consumeUploadToken(env, token), false);
});

test("тип картинки определяется по сигнатуре, а не по заголовку", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
  const heic = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(jpeg), "image/jpeg");
  assert.equal(sniffImageType(webp), "image/webp");
  assert.equal(sniffImageType(heic), "image/heic", "фото с айфона узнаём");
  assert.equal(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);

  // Браузер/Drive часто врут про тип — сигнатура важнее.
  assert.equal(resolveUploadType(png, "application/octet-stream"), "image/png");
  assert.equal(resolveUploadType(jpeg, ""), "image/jpeg", "пустой type с iOS не мешает");
  assert.equal(resolveUploadType(new Uint8Array([1, 2, 3]), "image/png"), "image/png", "запасной вариант — заявленный");
  assert.equal(resolveUploadType(new Uint8Array([1, 2, 3]), "text/html"), null);
});

test("edit_image по ссылке: картинка под octet-stream принимается, HEIC — с подсказкой", async () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  const { env, calls } = makeEnv((u) => {
    if (u.includes("octet")) return { __binary: PNG, __ct: "application/octet-stream" };
    if (u.includes("heic")) return { __binary: HEIC, __ct: "application/octet-stream" };
    return { data: [{ b64_json: TINY_PNG_B64 }] };
  });

  const res = await callTool(
    "edit_image",
    { image_url: "https://drive.google.com/uc?export=download&id=octet", prompt: "фон", quality: "low", _origin: ORIGIN },
    env, PROPS,
  );
  assert.equal(res.status, "edited", "Drive отдал octet-stream — всё равно правим");
  assert.ok(calls.some((c) => c.url.endsWith("/images/edits")));

  await assert.rejects(
    () => callTool("edit_image", { image_url: "https://example.com/heic", prompt: "p", quality: "low", _origin: ORIGIN }, env, PROPS),
    /HEIC.*get_upload_link/s,
    "по HEIC отправляем к странице загрузки, а не в тупик",
  );
});

test("get_upload_link: отдаёт ссылку /upload/<токен> и учит Claude, что делать дальше", async () => {
  const { env, kv } = makeEnv(() => ({}));
  const res = await callTool("get_upload_link", { quality: "low", _origin: ORIGIN }, env, PROPS);
  const m = res.upload_url.match(new RegExp(`^${ORIGIN}/upload/([0-9a-f-]{36})$`));
  assert.ok(m, "ссылка правильной формы");
  assert.ok(kv.has("upl:" + m[1]), "токен лёг в KV");
  assert.match(res.note, /list_images/, "в подсказке сказано, как найти фото после загрузки");
});

test("описания инструментов разворачивают Claude от отказа к ссылке на загрузку", async () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
  assert.match(byName.get_upload_link, /прислал фото в чат/i, "триггер описан прямым текстом");
  assert.match(byName.get_upload_link, /не могу загрузить/i, "запрещённый ответ назван явно");
  assert.match(byName.edit_image, /get_upload_link/, "правка отсылает к загрузке");
});

test("загруженное фото помечено в list_images как своё", async () => {
  const { env } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  await callTool("generate_image", { prompt: "нарисованное", quality: "low", _origin: ORIGIN }, env, PROPS);
  await storeImage(env, new Uint8Array([1, 2, 3]), { prompt: "[загружено] я.jpg", uploaded: true }, "image/jpeg");

  const list = await callTool("list_images", { quality: "low", _origin: ORIGIN }, env, PROPS);
  const mine = list.images.filter((i) => i.uploaded);
  assert.equal(mine.length, 1, "своё фото отличимо от сгенерированного");
  assert.match(mine[0].prompt, /загружено/);
});

test("загруженный JPEG: тип файла сохраняется при раздаче и правке", async () => {
  const { env, calls } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const id = await storeImage(env, new Uint8Array([1, 2, 3]), { prompt: "[загружено] я.jpg", uploaded: true }, "image/jpeg");

  const img = await loadImage(env, id);
  assert.equal(img.ct, "image/jpeg");
  const served = await serveImage(env, id);
  assert.equal(served.headers.get("content-type"), "image/jpeg");

  const list = await callTool("list_images", { quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.equal(list.images[0].prompt, "[загружено] я.jpg", "загрузка видна в списке");

  await callTool("edit_image", { image_id: id, prompt: "замени фон на закат", quality: "low", _origin: ORIGIN }, env, PROPS);
  const edit = calls.find((c) => c.url.endsWith("/images/edits"));
  assert.equal(edit.isForm, true);
});

test("edit_image по image_url: скачивает фото и шлёт в правку", async () => {
  const DRIVE_URL = "https://drive.google.com/uc?export=download&id=abc123";
  const { env, calls } = makeEnv((u) => {
    if (u === DRIVE_URL) return { __binary: new Uint8Array([9, 9, 9]), __ct: "image/jpeg" };
    return { data: [{ b64_json: TINY_PNG_B64 }] };
  });
  const res = await callTool(
    "edit_image",
    { image_url: DRIVE_URL, prompt: "замени фон на горы", quality: "low", _origin: ORIGIN },
    env, PROPS,
  );
  assert.equal(res.status, "edited");
  assert.ok(calls.some((c) => c.url === DRIVE_URL), "фото скачано по ссылке");
  const edit = calls.find((c) => c.url.endsWith("/images/edits"));
  assert.equal(edit.isForm, true);
});

test("edit_image по image_url: не-картинка и кривые ссылки — понятные ошибки", async () => {
  const { env } = makeEnv((u) =>
    u.startsWith("https://drive")
      ? { __binary: new Uint8Array([1]), __ct: "text/html" }
      : { data: [] },
  );
  await assert.rejects(
    () => callTool("edit_image", { image_url: "https://drive.google.com/file/d/x", prompt: "p", quality: "low", _origin: ORIGIN }, env, PROPS),
    /не картинка.*uc\?export=download/s,
  );
  await assert.rejects(
    () => callTool("edit_image", { image_url: "http://insecure.example/a.png", prompt: "p", quality: "low", _origin: ORIGIN }, env, PROPS),
    /https:\/\//,
  );
  await assert.rejects(
    () => callTool("edit_image", { prompt: "p", quality: "low", _origin: ORIGIN }, env, PROPS),
    /Укажи источник/,
  );
});

test("buildGenerationBody: n, прозрачный фон; мягкий фильтр — всегда", () => {
  const body = buildGenerationBody({ prompt: "стикер кота", n: 3, transparent_background: true, quality: "low" });
  assert.equal(body.n, 3);
  assert.equal(body.background, "transparent");
  assert.throws(() => buildGenerationBody({ prompt: "x", n: 7, quality: "low" }), /от 1 до 4/);
  const plain = buildGenerationBody({ prompt: "x", quality: "low" });
  assert.equal(plain.moderation, "low", "moderation=low по умолчанию во всех запросах");
  assert.ok(!("background" in plain));
});

test("generate_image: n=2 — оба варианта сохраняются и возвращаются", async () => {
  const { env } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }, { b64_json: TINY_PNG_B64 }] }));
  const res = await callTool("generate_image", { prompt: "два кота", n: 2, quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.equal(res.variants.length, 2);
  assert.notEqual(res.variants[0].image_id, res.variants[1].image_id);
});

test("маска: get_mask_link → правка с use_mask шлёт mask в форме", async () => {
  const { env, calls, kv } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const gen = await callTool("generate_image", { prompt: "портрет", quality: "low", _origin: ORIGIN }, env, PROPS);

  const link = await callTool("get_mask_link", { image_id: gen.image_id, quality: "low", _origin: ORIGIN }, env, PROPS);
  const m = link.mask_url.match(new RegExp(`^${ORIGIN}/mask/([0-9a-f-]{36})$`));
  assert.ok(m, "ссылка на рисовалку правильной формы");
  assert.equal(kv.get("mtk:" + m[1]), gen.image_id, "токен привязан к картинке");

  // Без нарисованной маски — понятная ошибка.
  await assert.rejects(
    () => callTool("edit_image", { image_id: gen.image_id, prompt: "тату", use_mask: true, quality: "low", _origin: ORIGIN }, env, PROPS),
    /не нарисована/,
  );

  await storeMask(env, gen.image_id, new Uint8Array([7, 7]));
  await callTool("edit_image", { image_id: gen.image_id, prompt: "тату-рукав", use_mask: true, quality: "low", _origin: ORIGIN }, env, PROPS);
  const edit = calls.filter((c) => c.url.endsWith("/images/edits")).at(-1);
  assert.ok(edit.formKeys.includes("mask"), "маска ушла в форму");
  assert.equal(edit.formGet("model"), "gpt-image-2");
  assert.equal(edit.formGet("input_fidelity"), null, "gpt-image-2 отвечает 400 на input_fidelity — не шлём");
  assert.equal(edit.formGet("moderation"), "low", "мягкий фильтр и в правках");

  await assert.rejects(
    () => callTool("edit_image", { image_url: "https://x/y.png", prompt: "p", use_mask: true, quality: "low", _origin: ORIGIN }, env, PROPS),
    /только с image_id/,
  );
});

test("get_mask_link для несуществующей картинки — ошибка", async () => {
  const { env } = makeEnv(() => ({}));
  await assert.rejects(
    () => callTool("get_mask_link", { image_id: "нет-такой", quality: "low", _origin: ORIGIN }, env, PROPS),
    /не найдена/,
  );
});

test("compose_images: несколько исходников уходят одним запросом", async () => {
  const { env, calls } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const a = await callTool("generate_image", { prompt: "человек", quality: "low", _origin: ORIGIN }, env, PROPS);
  const b = await callTool("generate_image", { prompt: "куртка", quality: "low", _origin: ORIGIN }, env, PROPS);
  const res = await callTool(
    "compose_images",
    { image_ids: [a.image_id, b.image_id], prompt: "надень куртку со второго фото", quality: "low", _origin: ORIGIN },
    env, PROPS,
  );
  assert.equal(res.status, "composed");
  const edit = calls.filter((c) => c.url.endsWith("/images/edits")).at(-1);
  assert.equal(edit.formKeys.filter((k) => k === "image[]").length, 2, "оба исходника в форме");

  await assert.rejects(
    () => callTool("compose_images", { image_ids: [a.image_id], prompt: "p", quality: "low", _origin: ORIGIN }, env, PROPS),
    /от 2 до 6/,
  );
});

test("compose_images: маска применяется к первому фото — тату на нужном участке руки", async () => {
  // Совмещение просим в двух вариантах — значит и OpenAI отвечает двумя.
  const { env, calls } = makeEnv((u) =>
    u.endsWith("/images/edits")
      ? { data: [{ b64_json: TINY_PNG_B64 }, { b64_json: TINY_PNG_B64 }] }
      : { data: [{ b64_json: TINY_PNG_B64 }] },
  );
  const person = await callTool("generate_image", { prompt: "девушка", quality: "low", _origin: ORIGIN }, env, PROPS);
  const tattoo = await callTool("generate_image", { prompt: "эскиз тату", quality: "low", _origin: ORIGIN }, env, PROPS);
  const ids = [person.image_id, tattoo.image_id];

  // Без нарисованной маски — ошибка называет, для какого именно фото её рисовать.
  await assert.rejects(
    () => callTool("compose_images", { image_ids: ids, prompt: "нанеси тату", use_mask: true, quality: "low", _origin: ORIGIN }, env, PROPS),
    new RegExp(`Маска для первого фото \\(${person.image_id}\\)`),
  );

  // Маска рисуется по первому фото — по нему же её и подхватываем.
  await storeMask(env, person.image_id, new Uint8Array([5, 5]));
  const res = await callTool(
    "compose_images",
    { image_ids: ids, prompt: "нанеси татуировку со второго фото на руку", use_mask: true, quality: "high", n: 2, _origin: ORIGIN },
    env, PROPS,
  );
  assert.equal(res.status, "composed");
  assert.equal(res.maskApplied, person.image_id, "видно, к какому фото применена маска");
  assert.equal(res.variants.length, 2, "n=2 даёт два варианта");

  const req = calls.filter((c) => c.url.endsWith("/images/edits")).at(-1);
  assert.equal(req.formKeys.filter((k) => k === "image[]").length, 2, "оба фото ушли");
  assert.ok(req.formKeys.includes("mask"), "маска ушла в форму");
  assert.equal(req.formGet("quality"), "high");
  assert.equal(req.formGet("n"), "2");
  assert.equal(req.formGet("input_fidelity"), null, "у gpt-image-2 точность входа и так максимальная");

  // Маска второго фото на совмещение не влияет — берётся только первая.
  const { env: env2, calls: calls2 } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const p2 = await callTool("generate_image", { prompt: "a", quality: "low", _origin: ORIGIN }, env2, PROPS);
  const t2 = await callTool("generate_image", { prompt: "b", quality: "low", _origin: ORIGIN }, env2, PROPS);
  await storeMask(env2, t2.image_id, new Uint8Array([9]));
  await assert.rejects(
    () => callTool("compose_images", { image_ids: [p2.image_id, t2.image_id], prompt: "p", use_mask: true, quality: "low", _origin: ORIGIN }, env2, PROPS),
    /Маска для первого фото/,
  );
  assert.equal(calls2.filter((c) => c.url.endsWith("/images/edits")).length, 0, "в OpenAI не пошли");
});

test("описание compose_images ведёт Claude к сценарию «два фото»", async () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));
  assert.match(byName.compose_images, /ДВУХ И БОЛЕЕ ФОТО/, "инструмент опознаётся как «для двух фото»");
  assert.match(byName.compose_images, /get_upload_link/, "сказано, как получить оба фото");
  assert.match(byName.compose_images, /use_mask/, "сказано про маску по первому фото");
});

test("generate_image без ключа — просьба переподключить коннектор", async () => {
  const { env } = makeEnv(() => ({}));
  await assert.rejects(
    () => callTool("generate_image", { prompt: "x", quality: "low", _origin: ORIGIN }, env, {}),
    /переподключи/i,
  );
});

test("счётчик: стоимость считается из usage по прайсу своей модели", async () => {
  const { imageCostUsd } = await import("../dist-test/oa-api.mjs");
  const usage = { output_tokens: 4160, input_tokens_details: { text_tokens: 100, image_tokens: 300 } };
  // gpt-image-2: (100·5 + 300·8 + 4160·30) / 1e6 = 0.1277
  assert.equal(imageCostUsd(usage), 0.1277, "по умолчанию — прайс новой модели");
  assert.equal(imageCostUsd(usage, "gpt-image-2"), 0.1277);
  // gpt-image-1 дороже: (100·5 + 300·10 + 4160·40) / 1e6 = 0.1699
  assert.equal(imageCostUsd(usage, "gpt-image-1"), 0.1699);
  assert.equal(imageCostUsd({}), null, "без usage стоимость неизвестна, а не ноль");
});

test("счётчик: каждая операция возвращает cost и копит итоги", async () => {
  // gpt-image-2: (200·5 + 1000·30) / 1e6 = 0.031
  const usage = { output_tokens: 1000, input_tokens_details: { text_tokens: 200, image_tokens: 0 } };
  const { env } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }], usage }));
  const a = await callTool("generate_image", { prompt: "кот", quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.equal(a.cost.thisCallUsd, 0.031);
  assert.equal(a.cost.totalUsd, 0.031);
  assert.equal(a.model, "gpt-image-2", "в ответе видно, какой моделью сделано");

  const b = await callTool("generate_image", { prompt: "пёс", quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.equal(b.cost.totalUsd, 0.062, "итог накапливается");
  assert.equal(b.cost.monthUsd, 0.062);

  const s = await callTool("get_spending", {}, env, PROPS);
  assert.equal(s.totalUsd, 0.062);
  assert.equal(s.operations, 2);
  assert.equal(s.currentMonthUsd, 0.062);
});

test("модель: нет доступа к gpt-image-2 — автоматический откат на gpt-image-1", async () => {
  const seen = [];
  const kv = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const isForm = init.body instanceof FormData;
    const model = isForm ? init.body.get("model") : JSON.parse(init.body).model;
    seen.push(model);
    if (model === "gpt-image-2") {
      return {
        ok: false, status: 404,
        json: async () => ({ error: { message: "The model `gpt-image-2` does not exist or you do not have access to it." } }),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }], usage: { output_tokens: 1000, input_tokens_details: { text_tokens: 200, image_tokens: 0 } } }),
    };
  };
  const env = {
    OAUTH_KV: {
      list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }),
      get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      getWithMetadata: async (k) => ({ value: kv.get(k) ?? null, metadata: null }),
      put: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
    },
  };

  const res = await callTool("generate_image", { prompt: "кот", quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.deepEqual(seen, ["gpt-image-2", "gpt-image-1"], "сначала новая, потом откат");
  assert.equal(res.model, "gpt-image-1");
  assert.match(res.note, /недоступна/, "пользователю сказано про откат");
  // Цена посчитана по прайсу той модели, которая реально отработала:
  // (200·5 + 1000·40) / 1e6 = 0.041
  assert.equal(res.cost.thisCallUsd, 0.041);
});

test("счётчик: без usage в ответе операция не падает, cost честно неизвестен", async () => {
  const { env } = makeEnv(() => ({ data: [{ b64_json: TINY_PNG_B64 }] }));
  const res = await callTool("generate_image", { prompt: "кот", quality: "low", _origin: ORIGIN }, env, PROPS);
  assert.match(res.cost.note, /стоимость .*неизвестна/i);
  const s = await callTool("get_spending", {}, env, PROPS);
  assert.equal(s.operations, 0, "неизвестная стоимость в счётчик не пишется");
});
