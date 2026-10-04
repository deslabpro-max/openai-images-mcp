// Тесты страницы загрузки своих фото: /upload/<токен>.
// Проверяем то, что нельзя увидеть глазами в бандле — что inline-скрипт
// собрался корректно (интерполяция констант, экранирование регулярок)
// и что неудачная попытка не сжигает рабочую ссылку.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EDGE,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_USES,
  createUploadToken,
  isUploadTokenValid,
} from "../dist-test/oa-api.mjs";
import { OaAuthHandler } from "../dist-test/oa-auth.mjs";

const ORIGIN = "https://imagegen-connector.example.workers.dev";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

function makeEnv() {
  const kv = new Map();
  const meta = new Map();
  return {
    kv,
    OAUTH_KV: {
      list: async ({ prefix }) => ({
        keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      }),
      get: async (k, type) => {
        if (!kv.has(k)) return null;
        const v = kv.get(k);
        return type === "json" ? JSON.parse(v) : v;
      },
      getWithMetadata: async (k) => ({ value: kv.has(k) ? kv.get(k) : null, metadata: meta.get(k) ?? null }),
      put: async (k, v, opts) => {
        kv.set(k, v);
        if (opts?.metadata) meta.set(k, opts.metadata);
      },
      delete: async (k) => { kv.delete(k); meta.delete(k); },
    },
  };
}

const get = (env, path) => OaAuthHandler.fetch(new Request(ORIGIN + path), env, {});

function post(env, path, files) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new Blob([f.bytes], { type: f.type }), f.name);
  return OaAuthHandler.fetch(new Request(ORIGIN + path, { method: "POST", body: fd }), env, {});
}

test("все страницы пригодны для телефона", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);
  await env.OAUTH_KV.put("mtk:" + token, "some-image-id");

  const pages = {
    "страница загрузки": await (await get(env, `/upload/${token}`)).text(),
    "рисовалка маски": await (await get(env, `/mask/${token}`)).text(),
    "ссылка недействительна": await (await get(env, "/upload/00000000-0000-4000-8000-000000000000")).text(),
    главная: await (await get(env, "/")).text(),
  };

  for (const [name, page] of Object.entries(pages)) {
    // Без viewport мобильный Safari верстает на 980 px и всё уезжает мелким.
    assert.match(page, /<meta name="viewport" content="width=device-width/, `${name}: есть viewport`);
    assert.ok(!/margin:4rem auto/.test(page), `${name}: нет полей, съедающих экран телефона`);
  }

  // Рисовалке маски зум только мешает: жест пальцем должен рисовать.
  assert.match(pages["рисовалка маски"], /user-scalable=no/);
  assert.ok(!/user-scalable=no/.test(pages["страница загрузки"]), "на остальных страницах зум оставляем");
});

test("рисовалка маски: палец рисует, а не таскает страницу", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);
  await env.OAUTH_KV.put("mtk:" + token, "some-image-id");
  const page = await (await get(env, `/mask/${token}`)).text();

  assert.match(page, /touch-action:none/, "холст не отдаёт жест прокрутке");
  assert.match(page, /\{ passive: false \}/, "preventDefault на touch работает только с passive:false");
  assert.match(page, /touchmove/, "прокрутка глушится явно — одного touch-action на iOS мало");
  assert.match(page, /setPointerCapture/, "палец не теряется за краем холста");
  assert.match(page, /lineTo/, "штрих линией, иначе быстрый мах пальцем даёт пунктир");
  assert.match(page, /destination-out/, "есть ластик для промахов");
  assert.match(page, /max-height:60vh/, "холст помещается в экран вместе с кнопками");
});

test("страница загрузки: inline-скрипт собрался рабочим", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);
  const html = await (await get(env, `/upload/${token}`)).text();

  // Константы воркера должны доехать до браузера числами, а не именами.
  assert.match(html, new RegExp(`const MAX_EDGE = ${MAX_EDGE}, MAX_BYTES = ${UPLOAD_MAX_BYTES}`));
  assert.match(html, new RegExp(`до\\s*${UPLOAD_MAX_USES} загрузок`));
  // Экранирование в регулярках: в браузер должен уехать \. а не \\.
  assert.ok(html.includes("/\\.(png|webp)$/i"), "регулярка расширения не задвоила слеш");
  assert.ok(!html.includes("\\\\."), "в скрипте нет задвоенных экранирований");
  assert.match(html, /createImageBitmap/, "HEIC декодируется в браузере");
  assert.match(html, /accept="image\/\*,\.heic,\.heif"/, "айфон может выбрать HEIC");
  assert.match(html, /multiple/, "можно выбрать несколько фото");
});

test("загрузка PNG: фото попадает в хранилище, ссылка остаётся живой", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);

  const resp = await post(env, `/upload/${token}?json=1`, [{ bytes: PNG, type: "image/png", name: "a.png" }]);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.match(data.image_id, /^[0-9a-f-]{36}$/);
  assert.equal(data.url, `${ORIGIN}/i/${data.image_id}`);
  assert.ok(env.kv.has("img:" + data.image_id), "картинка легла в KV");

  assert.equal(await isUploadTokenValid(env, token), true, "ссылка ещё работает");
  const served = await get(env, `/i/${data.image_id}`);
  assert.equal(served.headers.get("content-type"), "image/png");
});

test("iOS шлёт файл без типа — спасает сигнатура", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);
  const resp = await post(env, `/upload/${token}?json=1`, [{ bytes: JPEG, type: "", name: "IMG_0001" }]);
  assert.equal(resp.status, 200);
  const { image_id } = await resp.json();
  const served = await get(env, `/i/${image_id}`);
  assert.equal(served.headers.get("content-type"), "image/jpeg");
});

test("неудачная попытка НЕ сжигает ссылку", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);

  const bad = await post(env, `/upload/${token}?json=1`, [{ bytes: new Uint8Array([1, 2, 3]), type: "text/plain", name: "x.txt" }]);
  assert.equal(bad.status, 415);
  assert.match((await bad.json()).error, /не поддерживается/);
  assert.equal(await isUploadTokenValid(env, token), true, "ссылка пережила ошибку");

  const heic = await post(env, `/upload/${token}?json=1`, [{ bytes: HEIC, type: "image/heic", name: "IMG.HEIC" }]);
  assert.equal(heic.status, 415);
  assert.match((await heic.json()).error, /Safari|Наиболее совместимый/, "по HEIC есть внятный выход");
  assert.equal(await isUploadTokenValid(env, token), true);

  // …и после двух ошибок фото всё ещё грузится по той же ссылке.
  const ok = await post(env, `/upload/${token}?json=1`, [{ bytes: PNG, type: "image/png", name: "a.png" }]);
  assert.equal(ok.status, 200);
});

test("несколько фото за раз и исчерпание лимита ссылки", async () => {
  const env = makeEnv();
  const token = await createUploadToken(env);

  const resp = await post(env, `/upload/${token}`, [
    { bytes: PNG, type: "image/png", name: "a.png" },
    { bytes: JPEG, type: "image/jpeg", name: "b.jpg" },
  ]);
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.equal(html.match(/<code>/g).length, 2, "оба фото показаны с id");

  for (let i = 0; i < UPLOAD_MAX_USES - 2; i++) {
    assert.equal((await post(env, `/upload/${token}?json=1`, [{ bytes: PNG, type: "image/png", name: "n.png" }])).status, 200);
  }
  const exhausted = await post(env, `/upload/${token}?json=1`, [{ bytes: PNG, type: "image/png", name: "n.png" }]);
  assert.equal(exhausted.status, 410, "лимит исчерпан — ссылка закрылась");
  assert.equal((await get(env, `/upload/${token}`)).status, 410);
});

test("чужой или протухший токен — 410, без утечки хранилища", async () => {
  const env = makeEnv();
  assert.equal((await get(env, "/upload/00000000-0000-4000-8000-000000000000")).status, 410);
  assert.equal((await post(env, "/upload/мусор?json=1", [{ bytes: PNG, type: "image/png", name: "a.png" }])).status, 410);
  assert.equal(env.kv.size, 0, "ничего не сохранилось");
});

test("страница «ссылка недействительна» строится заново на каждый запрос", async () => {
  // Готовый Response на уровне модуля переиспользовать нельзя: его тело —
  // поток, привязанный к своему запросу. Workers ругаются на это ещё при
  // инициализации («Disallowed operation called within global scope»),
  // а если модуль всё же поднялся — падает второе чтение тела.
  const env = makeEnv();
  const bad = "/upload/00000000-0000-4000-8000-000000000000";
  const first = await get(env, bad);
  const second = await get(env, bad);

  assert.notEqual(first, second, "каждый раз новый объект Response");
  const t1 = await first.text();
  const t2 = await second.text();
  assert.match(t1, /недействительна/);
  assert.equal(t1, t2, "тело читается у обоих ответов");

  // То же для рисовалки маски — она возвращает ту же страницу.
  const m1 = await get(env, `/mask/00000000-0000-4000-8000-000000000000`);
  const m2 = await get(env, `/mask/00000000-0000-4000-8000-000000000000`);
  assert.equal(await m1.text(), await m2.text());
});
