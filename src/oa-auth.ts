/**
 * Авторизация: страница /authorize, где пользователь один раз вставляет
 * API-ключ OpenAI. Ключ проверяется живым запросом (без затрат) и уезжает
 * в props гранта — их шифрует workers-oauth-provider.
 *
 * Здесь же публичная раздача сгенерированных картинок: GET /i/<uuid>.
 */
import {
  MAX_EDGE,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_USES,
  consumeMaskToken,
  consumeUploadToken,
  imageUrl,
  isUploadTokenValid,
  peekMaskToken,
  resolveUploadType,
  serveImage,
  storeImage,
  storeMask,
  validateKey,
} from "./oa-api";

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formPage(state: string, error?: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>Картинки OpenAI → Claude</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:40rem;margin:0 auto;padding:1.25rem;line-height:1.6">
<h1>🎨 Подключение генерации картинок</h1>
${error ? `<p style="color:#b00020"><b>Ошибка:</b> ${esc(error)}</p>` : ""}
<p>Нужен API-ключ OpenAI с включённым биллингом:</p>
<ol>
<li>Открой <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>;</li>
<li><b>Create new secret key</b> — скопируй ключ (показывается один раз);</li>
<li>вставь его сюда:</li>
</ol>
<form method="POST" action="/authorize">
<input type="hidden" name="state" value="${esc(state)}">
<input type="password" name="key" required placeholder="sk-..."
  style="width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box" autocomplete="off">
<button type="submit" style="margin-top:1rem;padding:.6rem 2rem;font-size:1rem">Подключить</button>
</form>
<p style="color:#666;font-size:.9rem">Ключ хранится в зашифрованном виде в KV твоего
Cloudflare-аккаунта. Каждая генерация тратит деньги с баланса OpenAI
(low ≈ $0.01–0.02, medium ≈ $0.04–0.06, high ≈ $0.17–0.25). Отозвать ключ можно
в любой момент на platform.openai.com.</p>
</body>`;
}

async function authorizeGet(request: Request, env: any): Promise<Response> {
  let oauthReqInfo: any;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e: any) {
    return new Response("Некорректный запрос авторизации: " + (e?.message || e), { status: 400 });
  }
  if (!oauthReqInfo.clientId) return new Response("Отсутствует client_id", { status: 400 });
  const state = b64urlEncode(JSON.stringify(oauthReqInfo));
  return new Response(formPage(state), { headers: { "content-type": "text/html;charset=utf-8" } });
}

async function authorizePost(request: Request, env: any): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") || "");
  const key = String(form.get("key") || "").trim();

  let oauthReqInfo: any;
  try {
    oauthReqInfo = JSON.parse(b64urlDecode(state));
  } catch {
    return new Response("Повреждён параметр state — начни подключение заново.", { status: 400 });
  }

  const htmlError = (msg: string) =>
    new Response(formPage(state, msg), { status: 400, headers: { "content-type": "text/html;charset=utf-8" } });

  if (!key) return htmlError("Ключ пуст.");
  try {
    await validateKey(key);
  } catch (e: any) {
    return htmlError(String(e?.message || e).slice(0, 300));
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: "openai-" + key.slice(-6),
    metadata: { label: "OpenAI …" + key.slice(-6) },
    scope: oauthReqInfo.scope,
    props: { openaiKey: key },
  });
  return Response.redirect(redirectTo, 302);
}

const HOME_PAGE = `<!doctype html><meta charset="utf-8">
<title>Картинки OpenAI → Claude</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:40rem;margin:0 auto;padding:1.25rem;line-height:1.6">
<h1>🎨 Коннектор генерации картинок → Claude</h1>
<p>Это удалённый MCP-сервер: генерация и правка изображений (OpenAI gpt-image-2)
из любого чата Claude или ChatGPT. Готовые PNG раздаются по ссылкам /i/… (хранятся 30 дней).</p>
<p>Чтобы подключить: в claude.ai открой <b>Настройки → Коннекторы → Добавить
пользовательский коннектор</b> и укажи URL:</p>
<p><code id="u"></code></p>
<script>document.getElementById("u").textContent = location.origin + "/mcp";</script>
</body>`;

// ---------- Загрузка своих фото по одноразовой ссылке ----------

// Без viewport мобильный Safari верстает страницу на 980 px и показывает её
// уменьшенной: текст нечитаем, в кнопки не попасть пальцем, а перетаскивание
// панорамирует страницу. noZoom нужен рисовалке маски — там жест пальцем
// должен рисовать, а не масштабировать.
function pageHead(title: string, noZoom = false): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1${noZoom ? ",maximum-scale=1,user-scalable=no" : ""}">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:0 auto;padding:1.25rem;
line-height:1.6;font-size:1.05rem;overscroll-behavior:none;color:#111;background:#fff}
h1{font-size:1.45rem;line-height:1.25;margin:.4rem 0 .8rem}
button{min-height:2.9rem;padding:.7rem 1.3rem;font-size:1rem;border-radius:.5rem;
border:1px solid #bbb;background:#f4f4f4;cursor:pointer;margin:.2rem .3rem .2rem 0}
button:disabled{opacity:.5}
input[type=file]{display:block;width:100%;margin:1rem 0;font-size:1rem}
input[type=range]{height:2.2rem;vertical-align:middle}
img{max-width:100%;border-radius:8px}
code{word-break:break-all;font-size:.95rem}
</style>`;
}

const html = (body: string, status = 200, opts: { title?: string; noZoom?: boolean } = {}) =>
  new Response(`${pageHead(opts.title || "Загрузка фото", opts.noZoom)}<body>${body}</body>`, {
    status,
    headers: { "content-type": "text/html;charset=utf-8" },
  });

// Именно функция, а не готовый Response: тело ответа — поток, привязанный к
// I/O-контексту своего запроса, поэтому один объект нельзя переиспользовать
// между запросами (а конструирование на уровне модуля Workers и вовсе
// считают запрещённой операцией в глобальной области).
const expired = () =>
  html(
    "<h1>⏳ Ссылка недействительна</h1><p>Истёк её час или исчерпан лимит загрузок. " +
      "Попроси Claude дать новую: «дай ссылку для загрузки фото».</p>",
    410,
  );

// Страница сама декодирует выбранный файл и пересжимает его в PNG/JPEG:
// с айфона фото приходят в HEIC, который OpenAI не принимает, зато Safari
// декодирует нативно. Заодно уменьшаем длинную сторону до MAX_EDGE — иначе
// 12-мегапиксельный снимок упирается в лимиты на ровном месте.
// Без JS форма отправляет файл как есть (годится для PNG/JPEG/WebP).
async function uploadGet(env: any, token: string): Promise<Response> {
  if (!(await isUploadTokenValid(env, token))) return expired();
  return html(`<h1>📤 Загрузка фото</h1>
<p>Выбери фото — можно несколько сразу, прямо из «Фотоплёнки». Формат любой,
включая HEIC с айфона: страница сама переведёт его в понятный Claude вид.</p>
<form id="f" method="POST" enctype="multipart/form-data">
<input id="file" type="file" name="file" accept="image/*,.heic,.heif" multiple required
  style="display:block;margin:1rem 0">
<button type="submit" style="padding:.6rem 2rem;font-size:1rem">Загрузить</button>
</form>
<div id="log"></div>
<p style="color:#666;font-size:.9rem">Ссылка живёт 1 час и выдерживает до
${UPLOAD_MAX_USES} загрузок — неудачная попытка её не сжигает. Фото хранится
30 дней, удалить раньше можно командой Claude (delete_image).</p>
<script>
const MAX_EDGE = ${MAX_EDGE}, MAX_BYTES = ${UPLOAD_MAX_BYTES};
const log = document.getElementById("log"), form = document.getElementById("f");
const say = (h) => { const d = document.createElement("div"); d.innerHTML = h; log.appendChild(d); return d; };

async function decode(file) {
  // createImageBitmap уважает EXIF-поворот и на Safari умеет HEIC.
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
}

async function shrink(file) {
  const bmp = await decode(file);
  const w0 = bmp.naturalWidth || bmp.width, h0 = bmp.naturalHeight || bmp.height;
  if (!w0 || !h0) throw new Error("пустое изображение");
  const k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  // PNG бережёт прозрачность, но для фото он вчетверо тяжелее JPEG.
  const keepAlpha = /png|webp/i.test(file.type) || /\\.(png|webp)$/i.test(file.name || "");
  let blob = await new Promise((r) => c.toBlob(r, keepAlpha ? "image/png" : "image/jpeg", 0.92));
  if (blob && blob.size > MAX_BYTES) {
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
  }
  if (!blob) throw new Error("не удалось пересжать");
  return blob;
}

async function send(blob, name) {
  const fd = new FormData();
  fd.append("file", blob, name);
  const resp = await fetch(location.pathname + "?json=1", { method: "POST", body: fd });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.image_id) throw new Error(data.error || ("HTTP " + resp.status));
  return data;
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const files = [...document.getElementById("file").files];
  if (!files.length) return;
  form.querySelector("button").disabled = true;
  log.innerHTML = "";
  for (const file of files) {
    const row = say("⏳ " + (file.name || "фото") + " — готовлю…");
    try {
      const blob = await shrink(file);
      const data = await send(blob, (file.name || "photo").replace(/\\.[^.]+$/, "") + (blob.type === "image/png" ? ".png" : ".jpg"));
      row.innerHTML = "✅ <b>" + (file.name || "фото") + "</b> — загружено<br>" +
        "<img src='" + data.url + "' style='max-width:100%;border-radius:8px;margin:.5rem 0'><br>" +
        "<code>" + data.image_id + "</code>";
    } catch (err) {
      const heic = /heic|heif/i.test(file.type + " " + (file.name || ""));
      row.innerHTML = "❌ <b>" + (file.name || "фото") + "</b> — " + String(err.message || err) +
        (heic ? "<br>Этот браузер не открывает HEIC. Загрузи с айфона через Safari или включи " +
                "«Настройки → Камера → Форматы → Наиболее совместимый» и сними заново." : "");
    }
  }
  form.querySelector("button").disabled = false;
  say("<p style='margin-top:1rem'>Готово — вернись в чат Claude и скажи, что сделать с фото. " +
      "Он найдёт его сам (последние записи в list_images).</p>");
};
</script>`);
}

/** Разбор одного файла из формы: возвращает id либо текст ошибки. */
async function acceptFile(request: Request, env: any, token: string, file: any): Promise<{ id?: string; error?: string }> {
  if (!file || typeof file === "string") return { error: "Файл не выбран." };
  if (file.size > UPLOAD_MAX_BYTES) {
    return { error: `Файл больше ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} МБ — ужми и попробуй ещё раз.` };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) return { error: "Пустой файл." };
  const ct = resolveUploadType(bytes, file.type);
  if (ct === "image/heic") {
    return {
      error:
        "Это HEIC-фото с айфона, OpenAI такой формат не принимает. Открой эту ссылку в Safari " +
        "(там страница пересжимает HEIC сама) или включи «Настройки → Камера → Форматы → Наиболее совместимый».",
    };
  }
  if (!ct) return { error: `Формат ${file.type || "не распознан"} не поддерживается — нужен JPG, PNG или WebP.` };
  const id = await storeImage(env, bytes, { prompt: `[загружено] ${file.name || "фото"}`, uploaded: true }, ct);
  // Токен списываем только теперь: неудачные попытки ссылку не сжигают.
  await consumeUploadToken(env, token);
  return { id };
}

async function uploadPost(request: Request, env: any, token: string): Promise<Response> {
  if (!(await isUploadTokenValid(env, token))) return expired();
  const wantsJson = new URL(request.url).searchParams.get("json") === "1";
  const fail = (msg: string, status: number) =>
    wantsJson
      ? Response.json({ error: msg }, { status })
      : html(`<h1>Ошибка</h1><p>${esc(msg)}</p><p><a href="${esc(new URL(request.url).pathname)}">Попробовать ещё раз</a></p>`, status);

  let files: any[];
  try {
    files = (await request.formData()).getAll("file");
  } catch {
    return fail("Не удалось прочитать файл — попробуй ещё раз.", 400);
  }
  if (!files.length) return fail("Файл не выбран.", 400);

  const origin = new URL(request.url).origin;
  const done: { id: string; url: string }[] = [];
  let lastError = "";
  for (const file of files) {
    const r = await acceptFile(request, env, token, file);
    if (r.id) done.push({ id: r.id, url: imageUrl(origin, r.id) });
    else lastError = r.error || "не удалось загрузить";
  }
  if (!done.length) return fail(lastError, 415);

  if (wantsJson) return Response.json({ image_id: done[0].id, url: done[0].url, uploaded: done.length });
  return html(`<h1>✅ Фото загружено</h1>
${done.map((d) => `<p><img src="${esc(d.url)}" style="max-width:100%;border-radius:8px"><br><code>${esc(d.id)}</code></p>`).join("")}
<p>Теперь вернись в чат Claude и скажи, что сделать с фото — он найдёт его сам
(последние записи в list_images).</p>
${lastError ? `<p style="color:#b00020">Часть файлов не прошла: ${esc(lastError)}</p>` : ""}`);
}

// ---------- Рисовалка маски: закрась зону, которую можно менять ----------

async function maskGet(env: any, token: string): Promise<Response> {
  const imageId = await peekMaskToken(env, token);
  if (!imageId) return expired();
  return html(`<h1>🖌 Выдели зону изменения</h1>
<p>Закрась пальцем то, что нужно <b>изменить</b> (например, участок руки под тату).
Всё незакрашенное останется нетронутым.</p>
<div style="position:sticky;top:0;background:#fff;padding:.5rem 0;z-index:2;border-bottom:1px solid #eee">
<label>Кисть <input id="size" type="range" min="10" max="140" value="45" style="width:7rem"></label>
<button id="mode" type="button">✏️ Кисть</button>
<button id="clear" type="button">Стереть всё</button>
<button id="save" type="button" style="font-weight:600">Сохранить маску</button>
<div id="st" style="color:#666;font-size:.95rem;margin-top:.3rem"></div>
</div>
<canvas id="c" style="max-width:100%;max-height:60vh;touch-action:none;border-radius:8px;cursor:crosshair"></canvas>
<script>
const img = new Image();
img.src = "/i/${esc(imageId)}";
const c = document.getElementById("c"), x = c.getContext("2d");
const paint = document.createElement("canvas"), p = paint.getContext("2d");
const size = document.getElementById("size"), st = document.getElementById("st");
let drawing = false, erase = false, last = null;
img.onload = () => {
  c.width = paint.width = img.naturalWidth;
  c.height = paint.height = img.naturalHeight;
  redraw();
};
function redraw() {
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0);
  x.globalAlpha = 0.5;
  x.drawImage(paint, 0, 0);
  x.globalAlpha = 1;
}
function pos(e) {
  const r = c.getBoundingClientRect();
  return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height };
}
// Линия между соседними точками, а не отдельные кружки: при быстром движении
// пальца pointermove приходит редко, и точки складывались в пунктир.
function stroke(a, b) {
  p.globalCompositeOperation = erase ? "destination-out" : "source-over";
  p.strokeStyle = "#e00";
  p.lineWidth = +size.value * c.width / c.clientWidth;
  p.lineCap = p.lineJoin = "round";
  p.beginPath();
  p.moveTo(a.x, a.y);
  p.lineTo(b.x, b.y);
  p.stroke();
  redraw();
}
c.addEventListener("pointerdown", e => {
  e.preventDefault();
  c.setPointerCapture(e.pointerId);
  drawing = true;
  last = pos(e);
  stroke(last, last);
});
c.addEventListener("pointermove", e => {
  if (!drawing) return;
  e.preventDefault();
  const q = pos(e);
  stroke(last, q);
  last = q;
});
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
  c.addEventListener(ev, () => { drawing = false; last = null; });
}
// На iOS одного touch-action мало: без этого палец таскает страницу вместо
// того, чтобы рисовать. passive:false обязателен, иначе preventDefault молчит.
for (const ev of ["touchstart", "touchmove"]) {
  c.addEventListener(ev, e => e.preventDefault(), { passive: false });
}
document.getElementById("mode").onclick = (e) => {
  erase = !erase;
  e.target.textContent = erase ? "🧽 Ластик" : "✏️ Кисть";
};
document.getElementById("clear").onclick = () => { p.clearRect(0, 0, paint.width, paint.height); redraw(); };
document.getElementById("save").onclick = async () => {
  const data = p.getImageData(0, 0, paint.width, paint.height).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
  if (!painted) { st.textContent = "Сначала закрась зону изменения."; return; }
  // Маска OpenAI: прозрачное = менять, непрозрачное = сохранить.
  const m = document.createElement("canvas");
  m.width = paint.width; m.height = paint.height;
  const mx = m.getContext("2d");
  mx.fillStyle = "#000";
  mx.fillRect(0, 0, m.width, m.height);
  mx.globalCompositeOperation = "destination-out";
  mx.drawImage(paint, 0, 0);
  st.textContent = "Сохраняю…";
  const blob = await new Promise(res => m.toBlob(res, "image/png"));
  const fd = new FormData();
  fd.append("mask", blob, "mask.png");
  const resp = await fetch(location.pathname, { method: "POST", body: fd });
  st.textContent = resp.ok
    ? "✅ Маска сохранена — вернись в чат Claude и попроси применить правку."
    : "Ошибка сохранения: " + resp.status + ". Попроси у Claude новую ссылку.";
  if (resp.ok) document.getElementById("save").disabled = true;
};
</script>`, 200, { title: "Маска для правки", noZoom: true });
}

async function maskPost(request: Request, env: any, token: string): Promise<Response> {
  const imageId = await consumeMaskToken(env, token);
  if (!imageId) return expired();
  let file: any;
  try {
    file = (await request.formData()).get("mask");
  } catch {
    return new Response("bad form", { status: 400 });
  }
  if (!file || typeof file === "string") return new Response("no mask", { status: 400 });
  if (file.size > UPLOAD_MAX_BYTES) return new Response("too big", { status: 413 });
  await storeMask(env, imageId, new Uint8Array(await file.arrayBuffer()));
  return new Response("ok");
}

export const OaAuthHandler = {
  async fetch(request: Request, env: any, _ctx: any): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize" && request.method === "GET") return authorizeGet(request, env);
    if (pathname === "/authorize" && request.method === "POST") return authorizePost(request, env);
    if (pathname.startsWith("/i/")) return serveImage(env, pathname.slice(3));
    if (pathname.startsWith("/upload/")) {
      const token = pathname.slice("/upload/".length);
      return request.method === "POST" ? uploadPost(request, env, token) : uploadGet(env, token);
    }
    if (pathname.startsWith("/mask/")) {
      const token = pathname.slice("/mask/".length);
      return request.method === "POST" ? maskPost(request, env, token) : maskGet(env, token);
    }
    if (pathname === "/" || pathname === "") {
      return new Response(HOME_PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
