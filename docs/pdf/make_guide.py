#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Красивая PDF-инструкция «Fitbit → Claude и ChatGPT» (стиль лендинга).
Рисуется на canvas постранично: макеты экранов вместо скриншотов."""
import os, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.graphics.shapes import Drawing
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics import renderPDF

HERE = os.path.dirname(os.path.abspath(__file__))
FD = os.path.join(HERE, "fonts")
for name, file in [("Un", "Unbounded-Bold.ttf"), ("UnM", "Unbounded-Medium.ttf"),
                   ("Px", "Plex-Regular.ttf"), ("PxM", "Plex-Medium.ttf"),
                   ("PxS", "Plex-SemiBold.ttf"), ("PxB", "Plex-Bold.ttf"),
                   ("Mo", "IBMPlexMono-Regular.ttf"), ("MoM", "IBMPlexMono-Medium.ttf")]:
    pdfmetrics.registerFont(TTFont(name, os.path.join(FD, file)))
pdfmetrics.registerFontFamily("Px", normal="Px", bold="PxB", italic="Px", boldItalic="PxB")

W, H = A4
M = 42                      # поля
CW = W - 2 * M              # ширина контента
REPO = "https://github.com/deslabpro-max/openai-images-mcp"
PROMPT_URL = REPO + "/blob/main/docs/AGENT_PROMPT.md"
PROMPT_MD = os.path.join(HERE, "..", "AGENT_PROMPT.md")


def agent_prompt_text():
    src = open(PROMPT_MD, encoding="utf-8").read()
    return src.split("```text", 1)[1].split("```", 1)[0].strip("\n")

C = lambda h: colors.HexColor(h)
DARK, DARK2, ACC, ACC_D, MINT = C("#15112A"), C("#201A3C"), C("#6A46E5"), C("#4B2FB8"), C("#B7A4FF")
PAPER, INK, MUT, LINE, SOFT = C("#F5F3EF"), C("#1B1830"), C("#5B5770"), C("#E4E0D8"), C("#F9F7F3")
SAGE, SAGE_T = C("#A49CC8"), C("#CEC8E8")
WARN_BG, WARN = C("#FFF4DE"), C("#C98A14")
WHITE = colors.white
UI_BLUE = C("#1A73E8")
OA_BLACK = C("#0D0D0D")    # кнопки кабинета OpenAI в макетах
CF_ORANGE = C("#F38020")    # «Cloudflare» в макетах


def st(**kw):
    base = dict(fontName="Px", fontSize=10, leading=14.2, textColor=INK)
    base.update(kw)
    return ParagraphStyle("s", **base)

S_BODY = st()
S_BODY_S = st(fontSize=9, leading=12.6, textColor=MUT)
S_STEP = st(fontSize=10, leading=14.2)


def para(c, text, x, ytop, w, style=S_BODY):
    p = Paragraph(text, style)
    _, h = p.wrap(w, 2000)
    p.drawOn(c, x, ytop - h)
    return h


def rrect(c, x, y, w, h, r, fill=None, stroke=None, lw=0.8):
    c.saveState()
    if fill is not None: c.setFillColor(fill)
    if stroke is not None: c.setStrokeColor(stroke); c.setLineWidth(lw)
    c.roundRect(x, y, w, h, r, stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
    c.restoreState()


def text(c, s, x, y, font="Px", size=10, color=INK, anchor="l"):
    c.saveState(); c.setFont(font, size); c.setFillColor(color)
    {"l": c.drawString, "r": c.drawRightString, "c": c.drawCentredString}[anchor](x, y, s)
    c.restoreState()


def check_icon(c, x, y, s=7, color=ACC, lw=1.6):
    c.saveState(); c.setStrokeColor(color); c.setLineWidth(lw); c.setLineCap(1); c.setLineJoin(1)
    p = c.beginPath(); p.moveTo(x, y + s * 0.5); p.lineTo(x + s * 0.38, y + s * 0.12); p.lineTo(x + s, y + s * 0.9)
    c.drawPath(p, stroke=1, fill=0); c.restoreState()


def arrow(c, x1, y, x2, color=C("#A29EB4"), lw=1.4):
    c.saveState(); c.setStrokeColor(color); c.setLineWidth(lw); c.setLineCap(1)
    c.line(x1, y, x2, y); c.line(x2 - 5, y + 4, x2, y); c.line(x2 - 5, y - 4, x2, y); c.restoreState()


def marker(c, x, y, n, r=8.5, fill=ACC):
    """Нумерованная метка на макете экрана — «куда нажимать»."""
    c.saveState(); c.setFillColor(fill); c.setStrokeColor(WHITE); c.setLineWidth(1.6)
    c.circle(x, y, r, stroke=1, fill=1); c.restoreState()
    text(c, str(n), x, y - 3.4, "PxB", 9.5, WHITE, "c")


def chip(c, x, y, s, font="PxM", size=8.2, fg=SAGE, border=C("#3E3566"), fill=None, pad=8, h=17):
    w = pdfmetrics.stringWidth(s, font, size) + 2 * pad
    rrect(c, x, y, w, h, h / 2, fill=fill, stroke=border)
    text(c, s, x + pad, y + h / 2 - size * 0.34, font, size, fg)
    return w


def qr(c, url, x, y, size):
    w = QrCodeWidget(url); b = w.getBounds()
    d = Drawing(size, size, transform=[size / (b[2] - b[0]), 0, 0, size / (b[3] - b[1]), 0, 0])
    d.add(w); renderPDF.draw(d, c, x, y)


# ---------- макет окна (вместо скриншота) ----------

def window(c, x, ytop, w, h, url, title=None, dark_bar=False):
    """Окно браузера: полоса с точками и адресом. Возвращает y верха контента."""
    rrect(c, x + 2, ytop - h - 3, w, h, 9, fill=C("#E6E2D8"))
    rrect(c, x, ytop - h, w, h, 9, fill=WHITE, stroke=LINE)
    bar = 22
    c.saveState(); p = c.beginPath()
    p.roundRect(x, ytop - bar, w, bar, 9); c.clipPath(p, stroke=0)
    c.setFillColor(C("#F1EEE6")); c.rect(x, ytop - bar, w, bar, stroke=0, fill=1); c.restoreState()
    c.saveState(); c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(x, ytop - bar, x + w, ytop - bar); c.restoreState()
    for i, col in enumerate(["#E26D5C", "#E8B04B", "#6BBF6A"]):
        c.saveState(); c.setFillColor(C(col)); c.circle(x + 11 + i * 9, ytop - bar / 2, 2.6, stroke=0, fill=1); c.restoreState()
    rrect(c, x + 44, ytop - bar + 5, w - 56, bar - 10, 5, fill=WHITE)
    text(c, url, x + 51, ytop - bar / 2 - 2.6, "Mo", 7, MUT)
    y = ytop - bar - 12
    if title:
        text(c, title, x + 14, y - 8, "PxS", 11, INK)
        y -= 22
    return y


def field(c, x, ytop, w, label, value, hl=False, mono=False, dropdown=False):
    text(c, label, x, ytop - 8, "PxM", 7.6, MUT)
    bh = 20
    by = ytop - 12 - bh
    rrect(c, x, by, w, bh, 4, fill=C("#F0ECFD") if hl else WHITE, stroke=ACC if hl else C("#C9CFCB"), lw=1.3 if hl else 0.8)
    text(c, value, x + 7, by + bh / 2 - 3, "Mo" if mono else "Px", 7.6 if mono else 8.4, INK)
    if dropdown:
        c.saveState(); c.setFillColor(MUT); p = c.beginPath()
        p.moveTo(x + w - 14, by + 12); p.lineTo(x + w - 8, by + 12); p.lineTo(x + w - 11, by + 8); p.close()
        c.drawPath(p, stroke=0, fill=1); c.restoreState()
    return by


def button(c, x, y, s, fill=ACC, fg=WHITE, h=21, size=8.6, stroke=None):
    w = pdfmetrics.stringWidth(s, "PxS", size) + 22
    rrect(c, x, y, w, h, 5, fill=fill, stroke=stroke)
    text(c, s, x + 11, y + h / 2 - size * 0.35, "PxS", size, fg)
    return w


# ---------- общие элементы страниц ----------

def header_light(c, page_no, label):
    c.setFillColor(PAPER); c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(DARK); c.rect(0, H - 26, W, 26, stroke=0, fill=1)
    logo(c, M, H - 17.5, 9, light=True)
    text(c, label, W - M, H - 17, "PxM", 7.8, SAGE, "r")
    text(c, f"{page_no}", W - M, 22, "PxM", 8, MUT, "r")
    text(c, "github.com/deslabpro-max/openai-images-mcp  ·  MIT  ·  не аффилирован с OpenAI",
         M, 22, "Px", 7.4, MUT)


def logo(c, x, y, size=11, light=True):
    s = size / 11.0
    cx, cy, r = x + 8 * s, y + 3.5 * s, 7 * s
    c.saveState(); c.setFillColor(MINT); p = c.beginPath()
    p.moveTo(cx, cy + r); p.curveTo(cx + r * .15, cy + r * .15, cx + r * .15, cy + r * .15, cx + r, cy)
    p.curveTo(cx + r * .15, cy - r * .15, cx + r * .15, cy - r * .15, cx, cy - r)
    p.curveTo(cx - r * .15, cy - r * .15, cx - r * .15, cy - r * .15, cx - r, cy)
    p.curveTo(cx - r * .15, cy + r * .15, cx - r * .15, cy + r * .15, cx, cy + r)
    c.drawPath(p, stroke=0, fill=1); c.restoreState()
    text(c, "Картинки → ИИ", x + 20 * s, y, "Un", size, C("#F2EFE6") if light else INK)


def step_header(c, ytop, n, title, minutes):
    rrect(c, M, ytop - 34, 34, 34, 9, fill=ACC)
    text(c, str(n), M + 17, ytop - 23.5, "Un", 16, WHITE, "c")
    text(c, "ШАГ " + str(n), M + 46, ytop - 11, "PxB", 7.8, ACC)
    text(c, title, M + 46, ytop - 29, "Un", 16.5, INK)
    w = pdfmetrics.stringWidth(minutes, "PxS", 8.2) + 18
    rrect(c, W - M - w, ytop - 26, w, 18, 9, fill=WHITE, stroke=LINE)
    text(c, minutes, W - M - w + 9, ytop - 20.3, "PxS", 8.2, ACC_D)
    return ytop - 50


def numbered(c, x, ytop, w, items, gap=7):
    """Список шагов с круглыми номерами. items: html-строки. Возвращает низ."""
    y = ytop
    for i, s in enumerate(items, 1):
        c.saveState(); c.setFillColor(C("#E7E1FB")); c.circle(x + 8, y - 7, 8, stroke=0, fill=1); c.restoreState()
        text(c, str(i), x + 8, y - 10.2, "PxB", 8.6, ACC_D, "c")
        h = para(c, s, x + 24, y, w - 24, S_STEP)
        y -= max(h, 16) + gap
    return y


def callout(c, x, ytop, w, title, body, warn=False):
    bg, fg = (WARN_BG, WARN) if warn else (C("#EFEBFC"), ACC_D)
    tw = w - 44
    p = Paragraph(body, st(fontSize=9.2, leading=13, textColor=C("#3E3A2E") if warn else C("#2A1F63")))
    _, bh = p.wrap(tw, 1000)
    h = bh + 34
    rrect(c, x, ytop - h, w, h, 10, fill=bg)
    # иконка
    cx, cy = x + 20, ytop - 20
    c.saveState(); c.setStrokeColor(fg); c.setLineWidth(1.5); c.setLineJoin(1); c.setLineCap(1)
    if warn:
        p2 = c.beginPath(); p2.moveTo(cx, cy + 7); p2.lineTo(cx + 7.5, cy - 6); p2.lineTo(cx - 7.5, cy - 6); p2.close()
        c.drawPath(p2, stroke=1, fill=0); c.line(cx, cy + 2, cx, cy - 2); c.circle(cx, cy - 4, 0.4, stroke=1, fill=1)
    else:
        c.roundRect(cx - 6, cy - 7, 12, 9, 2, stroke=1, fill=0)
        p2 = c.beginPath(); p2.moveTo(cx - 3.5, cy + 2); p2.lineTo(cx - 3.5, cy + 4.5)
        p2.arcTo(cx - 3.5, cy + 1, cx + 3.5, cy + 8, 180, -180); p2.lineTo(cx + 3.5, cy + 2)
        c.drawPath(p2, stroke=1, fill=0)
    c.restoreState()
    text(c, title, x + 36, ytop - 18, "PxB", 9.6, fg)
    p.drawOn(c, x + 36, ytop - 24 - bh)
    return ytop - h


# ======================= СТРАНИЦЫ =======================

def glow(c, x, y, radii=((260, 0.05), (190, 0.05), (120, 0.06))):
    for r, a in radii:
        c.saveState(); c.setFillColor(ACC); c.setFillAlpha(a); c.circle(x, y, r, stroke=0, fill=1); c.restoreState()


def mix(c1, c2, t):
    return colors.Color(c1.red + (c2.red - c1.red) * t, c1.green + (c2.green - c1.green) * t,
                        c1.blue + (c2.blue - c1.blue) * t)


def draw_art(c, x, y, w, h, variant="lighthouse", r=10):
    """Векторная «сгенерированная картинка» для макетов."""
    c.saveState(); p = c.beginPath(); p.roundRect(x, y, w, h, r); c.clipPath(p, stroke=0)
    if variant == "lighthouse":
        top, bot = C("#2B1B5E"), C("#F59E6B")
    elif variant == "mountains":
        top, bot = C("#1F3A6B"), C("#9CC7E8")
    else:
        top, bot = C("#3B1E54"), C("#E86FA0")
    n = 40
    for i in range(n):
        c.setFillColor(mix(top, bot, i / (n - 1)))
        c.rect(x, y + h - (i + 1) * h / n, w, h / n + 0.6, stroke=0, fill=1)
    if variant == "lighthouse":
        c.setFillColor(C("#FFD08A")); c.circle(x + w * 0.66, y + h * 0.42, h * 0.13, stroke=0, fill=1)
        c.setFillColor(C("#2A2350"))
        c.rect(x, y, w, h * 0.34, stroke=0, fill=1)
        c.setStrokeColor(C("#F7B98A")); c.setLineWidth(1)
        for k in range(5):
            yy = y + h * (0.06 + 0.06 * k)
            c.line(x + w * (0.5 + 0.03 * k), yy, x + w * (0.82 - 0.03 * k), yy)
        c.setFillColor(C("#1A1538")); pp = c.beginPath()
        pp.moveTo(x, y + h * 0.34); pp.lineTo(x + w * 0.36, y + h * 0.34); pp.lineTo(x + w * 0.30, y + h * 0.24)
        pp.lineTo(x, y + h * 0.22); pp.close(); c.drawPath(pp, stroke=0, fill=1)
        bx = x + w * 0.2
        c.setFillColor(C("#F5F0FF")); tw = w * 0.07
        pp = c.beginPath(); pp.moveTo(bx - tw, y + h * 0.33); pp.lineTo(bx - tw * .6, y + h * 0.66)
        pp.lineTo(bx + tw * .6, y + h * 0.66); pp.lineTo(bx + tw, y + h * 0.33); pp.close(); c.drawPath(pp, stroke=0, fill=1)
        c.setFillColor(C("#E0526B"))
        for k in (0.42, 0.54):
            c.rect(bx - tw * .9 + (k - .42) * tw * .5, y + h * k, tw * 1.8 - (k - .42) * tw, h * 0.04, stroke=0, fill=1)
        c.setFillColor(C("#FFE6A8")); c.rect(bx - tw * .45, y + h * 0.66, tw * .9, h * 0.06, stroke=0, fill=1)
        c.setFillColor(C("#2A2350")); c.rect(bx - tw * .7, y + h * 0.72, tw * 1.4, h * 0.03, stroke=0, fill=1)
        c.setFillColor(C("#FFE6A8")); c.setFillAlpha(0.35); pp = c.beginPath()
        pp.moveTo(bx, y + h * 0.69); pp.lineTo(x + w, y + h * 0.82); pp.lineTo(x + w, y + h * 0.62); pp.close()
        c.drawPath(pp, stroke=0, fill=1); c.setFillAlpha(1)
    elif variant == "mountains":
        c.setFillColor(C("#FFF4D6")); c.circle(x + w * 0.72, y + h * 0.7, h * 0.1, stroke=0, fill=1)
        for col, pts in [("#4A6FA5", [(0, .30), (.25, .70), (.45, .40), (.62, .62), (1, .28)]),
                         ("#2C4A7A", [(0, .18), (.3, .48), (.55, .22), (.8, .45), (1, .2)])]:
            c.setFillColor(C(col)); pp = c.beginPath(); pp.moveTo(x, y)
            for a, b in pts: pp.lineTo(x + w * a, y + h * b)
            pp.lineTo(x + w, y); pp.close(); c.drawPath(pp, stroke=0, fill=1)
    else:
        for (cx, cy, rr, col, a) in [(.3, .6, .32, "#FFB36B", .9), (.7, .4, .38, "#7A5CFF", .8), (.55, .75, .2, "#FFE38A", .9)]:
            c.setFillColor(C(col)); c.setFillAlpha(a); c.circle(x + w * cx, y + h * cy, h * rr, stroke=0, fill=1)
        c.setFillAlpha(1)
    c.restoreState()


def sparkle(c, cx, cy, r, col):
    c.saveState(); c.setFillColor(col); p = c.beginPath()
    p.moveTo(cx, cy + r); p.curveTo(cx + r * .15, cy + r * .15, cx + r * .15, cy + r * .15, cx + r, cy)
    p.curveTo(cx + r * .15, cy - r * .15, cx + r * .15, cy - r * .15, cx, cy - r)
    p.curveTo(cx - r * .15, cy - r * .15, cx - r * .15, cy - r * .15, cx - r, cy)
    p.curveTo(cx - r * .15, cy + r * .15, cx - r * .15, cy + r * .15, cx, cy + r)
    c.drawPath(p, stroke=0, fill=1); c.restoreState()


def cover_footer(c):
    rrect(c, M, 60, CW, 104, 14, fill=DARK2)
    cols = [("3 шага", "без программирования"), ("≈25 мин", "+ верификация OpenAI"),
            ("$0.04", "за картинку"), ("8", "инструментов в чате")]
    cw = (CW - 118) / 4
    for i, (a, b) in enumerate(cols):
        xx = M + 20 + i * cw
        text(c, a, xx, 118, "Un", 15, C("#F2EFE6"))
        text(c, b, xx, 100, "Px", 8.2, SAGE)
    rrect(c, W - M - 94, 72, 80, 80, 8, fill=WHITE)
    qr(c, REPO, W - M - 90, 76, 72)
    c.linkURL(REPO, (W - M - 94, 72, W - M - 14, 152), relative=0)
    text(c, "код и инструкция на GitHub", W - M - 54, 64, "Px", 7, SAGE, "c")
    text(c, "Проект открытый (MIT), не аффилирован с OpenAI, Anthropic и Cloudflare.",
         M, 34, "Px", 7.4, C("#837CA6"))


COVER_FULL = os.path.join(HERE, "cover-full.jpg") if os.path.exists(os.path.join(HERE, "cover-full.jpg")) else None


def page_cover_full(c):
    """Обложка из готового фона A4 (см. make_cover.py)."""
    c.drawImage(COVER_FULL, 0, 0, W, H)
    logo(c, M, H - 52, 12)
    x = M
    for s_ in ["Бесплатно", "Открытый код · MIT", "gpt-image-2"]:
        x += chip(c, x, H - 104, s_) + 6
    t = Paragraph("Рисуйте словами. Прямо в чате.",
                  st(fontName="Un", fontSize=32, leading=38, textColor=C("#F2EFE6")))
    _, th = t.wrap(CW - 60, 400); t.drawOn(c, M, H - 122 - th)
    y = H - 122 - th - 14
    para(c, "Пошаговая инструкция: свой генератор картинок OpenAI <b>gpt-image-2</b> в <b>Claude</b> и "
            "<b>ChatGPT</b>. Генерация, правка своих фото, совмещение картинок — около $0.04 за картинку.",
         M, y, 420, st(fontSize=11, leading=16, textColor=SAGE_T))
    cover_footer(c)


def page_cover(c):
    if COVER_FULL:
        return page_cover_full(c)
    c.setFillColor(DARK); c.rect(0, 0, W, H, stroke=0, fill=1)
    glow(c, W - 150, 400)
    logo(c, M, H - 52, 12)
    x = M
    for s_ in ["Бесплатно", "Открытый код · MIT", "gpt-image-2"]:
        x += chip(c, x, H - 104, s_) + 6
    t = Paragraph("Рисуйте<br/>словами.<br/>Прямо в чате.",
                  st(fontName="Un", fontSize=34, leading=40, textColor=C("#F2EFE6")))
    _, th = t.wrap(300, 400); t.drawOn(c, M, H - 124 - th)
    y = H - 124 - th - 18
    para(c, "Пошаговая инструкция: свой генератор картинок OpenAI <b>gpt-image-2</b> в <b>Claude</b> и "
            "<b>ChatGPT</b>. Генерация, правка своих фото, совмещение картинок — около $0.04 за картинку.",
         M, y, 250, st(fontSize=11, leading=16, textColor=SAGE_T))

    # «сгенерированные» картинки справа
    for (ax, ay, aw, ah, v, rot) in [(W - 220, H - 300, 150, 112, "mountains", 8), (W - 170, H - 420, 140, 104, "abstract", -6)]:
        c.saveState(); c.translate(ax + aw / 2, ay + ah / 2); c.rotate(rot)
        rrect(c, -aw / 2 + 3, -ah / 2 - 4, aw, ah, 10, fill=C("#0B0818"))
        draw_art(c, -aw / 2, -ah / 2, aw, ah, v); c.restoreState()
    for (sx, sy, sr) in [(W - 236, H - 190, 9), (W - 58, H - 300, 6), (W - 252, H - 446, 5)]:
        sparkle(c, sx, sy, sr, MINT)

    # чат: запрос → картинка
    cx, ytop, cw_ = M, 404, 352
    h = 236
    rrect(c, cx + 3, ytop - h - 4, cw_, h, 14, fill=C("#0B0818"))
    rrect(c, cx, ytop - h, cw_, h, 14, fill=WHITE)
    c.saveState(); c.setFillColor(C("#37B58C")); c.circle(cx + 16, ytop - 15, 3.2, stroke=0, fill=1); c.restoreState()
    text(c, "Claude · коннектор «Картинки» подключён", cx + 25, ytop - 18, "PxS", 8, MUT)
    c.saveState(); c.setStrokeColor(C("#ECE8DE")); c.line(cx, ytop - 28, cx + cw_, ytop - 28); c.restoreState()
    ub = "Нарисуй маяк на закате, акварель"
    bw = pdfmetrics.stringWidth(ub, "Px", 9) + 22
    rrect(c, cx + cw_ - bw - 12, ytop - 62, bw, 24, 10, fill=ACC)
    text(c, ub, cx + cw_ - bw - 1, ytop - 53, "Px", 9, WHITE)
    rrect(c, cx + 12, ytop - 222, 236, 152, 10, fill=C("#F1EFF7"))
    draw_art(c, cx + 18, ytop - 196, 224, 120, "lighthouse", 8)
    text(c, "Готово · medium · $0.042", cx + 20, ytop - 212, "PxM", 8, MUT)
    rrect(c, cx + 256, ytop - 222, 84, 24, 10, fill=C("#F1EFF7"))
    check_icon(c, cx + 264, ytop - 214, 7)
    text(c, "PNG, 30 дней", cx + 276, ytop - 213, "Px", 7.8, INK)
    cover_footer(c)


def page_overview(c):
    header_light(c, 2, "Как это работает")
    y = H - 64
    text(c, "ЧТО ПОЛУЧИТСЯ", M, y, "PxB", 8, ACC); y -= 26
    text(c, "Ваш ИИ-ассистент научится рисовать", M, y, "Un", 17, INK); y -= 18
    y -= para(c, "Личный сервер-коннектор связывает Claude или ChatGPT с OpenAI. Дальше просто пишете в любом "
              "чате — на телефоне, в браузере, на компьютере:", M, y, CW, st(fontSize=10.2, leading=15, textColor=MUT)) + 12
    phrases = ["Нарисуй обложку про осень, акварель", "Сделай 3 варианта логотипа кофейни",
               "Замени фон на моём фото на море", "Куртку со 2-го фото — на человека с 1-го",
               "Стикер с котом, прозрачный фон", "Сколько я потратил в этом месяце?"]
    colw = (CW - 12) / 2
    for i, s_ in enumerate(phrases):
        xx = M + (i % 2) * (colw + 12); yy = y - (i // 2) * 34
        rrect(c, xx, yy - 26, colw, 26, 13, fill=WHITE, stroke=LINE)
        text(c, "«" + s_ + "»", xx + 14, yy - 16.5, "Px", 8.9, INK)
    y -= 3 * 34 + 26

    text(c, "КАК ЭТО РАБОТАЕТ", M, y, "PxB", 8, ACC); y -= 14
    nodes = [("Claude · ChatGPT", "вы пишете, что нарисовать"), ("Ваш сервер", "Cloudflare, бесплатно; ключ только у вас"),
             ("OpenAI gpt-image-2", "рисует с вашим ключом"), ("Ссылка на PNG", "хранится 30 дней")]
    nw = (CW - 3 * 22) / 4; nh = 74
    for i, (a, b) in enumerate(nodes):
        xx = M + i * (nw + 22)
        dark = i == 1
        rrect(c, xx, y - nh, nw, nh, 10, fill=DARK if dark else WHITE, stroke=None if dark else LINE)
        sparkle(c, xx + 18, y - 20, 6, MINT if dark else ACC)
        text(c, a, xx + 12, y - 40, "PxB", 9.2, C("#F2EFE6") if dark else INK)
        para(c, b, xx + 12, y - 45, nw - 20, st(fontSize=7.6, leading=10, textColor=SAGE if dark else MUT))
        if i < 3: arrow(c, xx + nw + 4, y - nh / 2, xx + nw + 18)
    y -= nh + 22
    y = callout(c, M, y, CW, "Почему это выгодно",
                "Платите только OpenAI и только за нарисованное: обычная картинка в среднем качестве — около $0.04, "
                "без подписок и наценок. Ключ OpenAI вводите один раз на странице коннектора — в чат он не попадает, "
                "хранится зашифрованным в вашем Cloudflare. Код открыт (MIT).") - 30

    text(c, "ЧТО ПОНАДОБИТСЯ", M, y, "PxB", 8, ACC); y -= 12
    needs = [("Аккаунт OpenAI и $5", "platform.openai.com, пополненный баланс; OpenAI работает не во всех странах"),
             ("Верификация организации", "проверка документа в OpenAI — без неё модели картинок недоступны"),
             ("GitHub и Cloudflare", "бесплатные аккаунты, карта не нужна"),
             ("ИИ-ассистент", "Claude (платный план) или ChatGPT Plus / Pro")]
    for i, (a, b) in enumerate(needs):
        xx = M + (i % 2) * (colw + 12); yy = y - (i // 2) * 58
        rrect(c, xx, yy - 50, colw, 50, 10, fill=WHITE, stroke=LINE)
        c.saveState(); c.setFillColor(C("#E7E1FB")); c.circle(xx + 18, yy - 18, 9, stroke=0, fill=1); c.restoreState()
        check_icon(c, xx + 13.5, yy - 22, 9)
        text(c, a, xx + 34, yy - 21, "PxB", 9.4, INK)
        para(c, b, xx + 34, yy - 25, colw - 44, st(fontSize=8, leading=10.6, textColor=MUT))
    y -= 2 * 58 + 24

    text(c, "ПЛАН", M, y, "PxB", 8, ACC); y -= 14
    plan = [("1", "OpenAI", "10 мин + ожидание"), ("2", "Сервер", "5 мин"), ("3", "Подключение", "3 мин")]
    pw = (CW - 2 * 10) / 3
    for i, (n, a, b) in enumerate(plan):
        xx = M + i * (pw + 10)
        rrect(c, xx, y - 40, pw, 40, 10, fill=SOFT, stroke=LINE)
        rrect(c, xx + 10, y - 30, 20, 20, 6, fill=ACC)
        text(c, n, xx + 20, y - 24, "Un", 10, WHITE, "c")
        text(c, a, xx + 38, y - 18, "PxB", 9.2, INK)
        text(c, b, xx + 38, y - 30, "Px", 8, MUT)


def oa_window(c, x, ytop, w, h, path, title=None):
    return window(c, x, ytop, w, h, "platform.openai.com" + path, title)


def page_step1(c):
    header_light(c, 3, "Шаг 1 · OpenAI")
    y = step_header(c, H - 52, 1, "Аккаунт OpenAI и ключ", "≈ 10 мин + ожидание")
    y -= para(c, "Всё делается в кабинете разработчика <font name='Mo' size='8.6'>platform.openai.com</font> — это не "
              "chatgpt.com, но аккаунт может быть тот же.", M, y, CW, st(fontSize=10.2, leading=15, textColor=MUT)) + 12
    colw = (CW - 16) / 2
    text(c, "1.1  Баланс", M, y - 8, "PxB", 10.5, INK)
    numbered(c, M, y - 20, colw, ["Settings (шестерёнка) → <b>Billing</b>",
                                  "<b>Add payment details</b> → карта → <b>Add to credit balance</b> → $5–10"], gap=5)
    xr = M + colw + 16
    text(c, "1.2  Верификация — обязательно", xr, y - 8, "PxB", 10.5, INK)
    numbered(c, xr, y - 20, colw, ["Settings → <b>Organization</b> → <b>General</b> → <b>Verify Organization</b>",
                                   "Документ и селфи через Persona; ответ — до суток"], gap=5)
    y -= 92
    yy = oa_window(c, M, y, colw, 112, "/settings/…/billing", "Billing")
    text(c, "Credit balance", M + 14, yy - 8, "PxM", 8, MUT)
    text(c, "$0.00", M + 14, yy - 26, "Un", 15, INK)
    bw = button(c, M + 14, yy - 58, "Add to credit balance", fill=OA_BLACK)
    marker(c, M + 14 + bw + 12, yy - 47.5, 1)
    yy = oa_window(c, xr, y, colw, 112, "/settings/…/general", "Organization")
    text(c, "Verification", xr + 14, yy - 8, "PxM", 8, MUT)
    chip(c, xr + 14, yy - 30, "Not verified", "PxM", 7.6, C("#B4261A"), None, C("#FCE8E6"), 7, 15)
    bw = button(c, xr + 14, yy - 58, "Verify Organization", fill=OA_BLACK)
    marker(c, xr + 14 + bw + 12, yy - 47.5, 2)
    y -= 126
    y = callout(c, M, y, CW, "Без верификации модели картинок недоступны",
                "OpenAI открывает gpt-image-2 и gpt-image-1 только верифицированным организациям. Пока подтверждения "
                "нет, коннектор при подключении скажет: «Ключ рабочий, но модели картинок недоступны». Ожидание "
                "можно не терять — переходите к шагу 2.", warn=True) - 22

    text(c, "1.3  API-ключ", M, y - 8, "PxB", 10.5, INK)
    yl = numbered(c, M, y - 20, 200, [
        "Settings → <b>API keys</b> → <b>Create new secret key</b>",
        "Имя — любое, Permissions — <b>All</b>",
        "<b>Create secret key</b> → скопируйте ключ <font name='Mo' size='8.4'>sk-proj-…</font>",
    ], gap=5)
    wx, ww = M + 216, CW - 216
    yy = oa_window(c, wx, y - 14, ww, 196, "/api-keys", "Create new secret key")
    fw = ww - 28
    b1 = field(c, wx + 14, yy, fw, "Name", "claude-images")
    text(c, "Permissions", wx + 14, b1 - 14, "PxM", 7.6, MUT)
    segs = ["All", "Restricted", "Read only"]; sx = wx + 14
    for i, sgm in enumerate(segs):
        sw_ = pdfmetrics.stringWidth(sgm, "PxM", 8) + 18
        rrect(c, sx, b1 - 40, sw_, 20, 5, fill=C("#F0ECFD") if i == 0 else WHITE,
              stroke=ACC if i == 0 else C("#C9CFCB"), lw=1.3 if i == 0 else 0.8)
        text(c, sgm, sx + 9, b1 - 33, "PxM", 8, INK); sx += sw_ + 4
    marker(c, sx + 8, b1 - 30, 2)
    bw = button(c, wx + 14, b1 - 72, "Create secret key", fill=OA_BLACK)
    marker(c, wx + 14 + bw + 12, b1 - 61.5, 3)
    rrect(c, wx + 14, b1 - 110, fw, 26, 5, fill=C("#F1EFF7"))
    text(c, "sk-proj-••••••••••••••••••••", wx + 22, b1 - 100, "Mo", 8.2, INK)
    y = min(yl, y - 14 - 196) - 14
    y = callout(c, M, y, CW, "Ключ показывают один раз — и он только ваш",
                "Сохраните ключ в заметки. Никому не отправляйте и не вставляйте в чат — он понадобится только "
                "на странице коннектора в шаге 3. Совет: в Settings → Limits задайте месячный лимит расходов.", warn=True)


def page_step2(c):
    header_light(c, 4, "Шаг 2 · Cloudflare")
    y = step_header(c, H - 52, 2, "Сервер на Cloudflare", "≈ 5 минут")
    y -= para(c, "Одна кнопка делает всё сама: копирует код в ваш GitHub, создаёт хранилище и запускает сервер. "
              "Ключей и секретов здесь задавать <b>не нужно</b>.", M, y, CW, st(fontSize=10.2, leading=15, textColor=MUT)) + 14
    lw = 214
    yl = numbered(c, M, y, lw, [
        "Откройте репозиторий — QR-код на обложке или <font name='Mo' size='8.4'>github.com/deslabpro-max/"
        "openai-images-mcp</font>",
        "Нажмите кнопку <b>Deploy to Cloudflare</b> <font color='#6A46E5'>(1)</font>",
        "Войдите в Cloudflare или зарегистрируйтесь, разрешите доступ к GitHub",
        "Ничего не меняйте и нажмите <b>Create and deploy</b> <font color='#6A46E5'>(2)</font>",
        "Дождитесь зелёной сборки и скопируйте адрес сервера <font color='#6A46E5'>(3)</font>",
    ])
    wx, ww = M + lw + 20, CW - lw - 20
    yy = window(c, wx, y, ww, 112, "github.com/deslabpro-max/openai-images-mcp")
    text(c, "Картинки OpenAI → Claude и ChatGPT", wx + 14, yy - 8, "PxB", 10, INK)
    for i, wdt in enumerate([ww - 60, ww - 90]):
        rrect(c, wx + 14, yy - 22 - i * 9, wdt, 4, 2, fill=C("#E7E4DC"))
    bx = wx + 14; by = yy - 62
    rrect(c, bx, by, 138, 22, 4, fill=CF_ORANGE)
    c.saveState(); c.setFillColor(WHITE); p = c.beginPath()
    p.moveTo(bx + 9, by + 7); p.curveTo(bx + 9, by + 14, bx + 17, by + 17, bx + 20, by + 12)
    p.curveTo(bx + 26, by + 14, bx + 27, by + 7, bx + 23, by + 7); p.close(); c.drawPath(p, stroke=0, fill=1); c.restoreState()
    text(c, "Deploy to Cloudflare", bx + 33, by + 7.6, "PxB", 8.6, WHITE)
    marker(c, bx + 146, by + 11, 1)
    y2 = y - 128
    yy = window(c, wx, y2, ww, 178, "dash.cloudflare.com/…/workers/deploy", "Create a new project")
    fw = ww - 28
    b1 = field(c, wx + 14, yy, fw, "Git account", "ваш-github", dropdown=True)
    b2 = field(c, wx + 14, b1 - 6, fw, "Repository name", "openai-images-mcp", mono=True)
    b3 = field(c, wx + 14, b2 - 6, fw, "Worker name — можно оставить как есть", "imagegen-connector", mono=True, hl=True)
    bw = button(c, wx + 14, b3 - 30, "Create and deploy", fill=UI_BLUE)
    marker(c, wx + 14 + bw + 12, b3 - 19.5, 2)
    y3 = min(yl, y2 - 196) - 6
    yy = window(c, M, y3, CW, 112, "dash.cloudflare.com/…/workers/imagegen-connector/deployments")
    c.saveState(); c.setFillColor(C("#1E8E3E")); c.circle(M + 22, yy - 6, 7, stroke=0, fill=1); c.restoreState()
    check_icon(c, M + 18.5, yy - 9.5, 7, WHITE, 1.5)
    text(c, "Build · Success", M + 36, yy - 10, "PxB", 11, INK)
    stages = ["Инициализация", "Клонирование", "Установка", "Развёртывание"]
    sw = (CW - 28 - 3 * 8) / 4
    for i, s_ in enumerate(stages):
        xx = M + 14 + i * (sw + 8)
        rrect(c, xx, yy - 40, sw, 18, 4, fill=WHITE, stroke=C("#C9CFCB"))
        text(c, s_, xx + 7, yy - 34, "Px", 7.8, INK)
        c.saveState(); c.setFillColor(C("#1E8E3E")); c.circle(xx + sw - 10, yy - 31, 4.6, stroke=0, fill=1); c.restoreState()
        check_icon(c, xx + sw - 12.6, yy - 33.6, 5, WHITE, 1.2)
    rrect(c, M + 14, yy - 72, CW - 28, 22, 5, fill=DARK)
    text(c, "https://imagegen-connector.ВАШ-ПОДДОМЕН.workers.dev", M + 24, yy - 64.5, "Mo", 8.6, C("#CDBEFF"))
    marker(c, W - M - 26, yy - 61, 3)
    callout(c, M, y3 - 128, CW, "Проверьте, что сервер жив",
            "Откройте адрес в браузере — должна появиться страница «Коннектор генерации картинок → Claude». "
            "Сохраните адрес: он нужен в шаге 3. Если задали своё имя воркера — в адресе будет оно.")


def page_step3(c):
    header_light(c, 5, "Шаг 3 · подключение")
    y = step_header(c, H - 52, 3, "Подключаем к Claude и ChatGPT", "≈ 3 минуты")
    colw = (CW - 16) / 2
    rrect(c, M, y - 22, colw, 22, 6, fill=C("#F5E6DC"))
    text(c, "Claude — браузер, телефон, десктоп", M + 10, y - 14.5, "PxB", 9.2, C("#8A4B2A"))
    yc = numbered(c, M, y - 32, colw, [
        "claude.ai → <b>Settings</b> → <b>Connectors</b>",
        "<b>Add custom connector</b> → URL сервера + <font name='Mo' size='8.4'>/mcp</font> → Add",
        "<b>Connect</b> → на странице коннектора вставьте ключ <font name='Mo' size='8.4'>sk-…</font> → <b>Подключить</b>",
    ], gap=5)
    xr = M + colw + 16
    rrect(c, xr, y - 22, colw, 22, 6, fill=C("#ECE8F8"))
    text(c, "ChatGPT — планы Plus / Pro", xr + 10, y - 14.5, "PxB", 9.2, ACC_D)
    yg = numbered(c, xr, y - 32, colw, [
        "Settings → <b>Apps &amp; Connectors</b> → Advanced → <b>Developer mode</b>",
        "<b>Create</b> → имя «Картинки», URL + <font name='Mo' size='8.4'>/mcp</font>, авторизация <b>OAuth</b>",
        "Страница коннектора → ключ → <b>Подключить</b>. В чате — меню «+»",
    ], gap=5)
    y = min(yc, yg) - 10
    yy = window(c, M, y, colw, 156, "claude.ai/settings/connectors", "Add custom connector")
    fw = colw - 28
    b1 = field(c, M + 14, yy, fw, "Name", "Картинки")
    b2 = field(c, M + 14, b1 - 6, fw, "Remote MCP server URL", "https://imagegen-connector.…/mcp", mono=True, hl=True)
    bw = button(c, M + 14, b2 - 30, "Add", fill=INK)
    marker(c, M + 14 + bw + 12, b2 - 19.5, 2)
    yy = window(c, xr, y, colw, 156, "imagegen-connector.…workers.dev/authorize", "Подключение генерации картинок")
    para(c, "Нужен API-ключ OpenAI с включённым биллингом. Вставьте его сюда:", xr + 14, yy, colw - 28,
         st(fontSize=8, leading=11, textColor=MUT))
    b1 = field(c, xr + 14, yy - 30, colw - 28, "API-ключ", "sk-proj-••••••••••••", mono=True, hl=True)
    bw = button(c, xr + 14, b1 - 30, "Подключить", fill=INK)
    marker(c, xr + 14 + bw + 12, b1 - 19.5, 3)
    y -= 172
    y = callout(c, M, y, CW, "Готово! Проверьте в любом чате",
                "«Нарисуй кота-космонавта, quality low» — первая картинка за пару центов. «Покажи последние картинки» — "
                "список со ссылками. «Сколько я потратил?» — расходы за месяц.") - 16
    callout(c, M, y, CW, "Если пишет «модели картинок недоступны»",
            "Верификация организации в OpenAI ещё не завершена (шаг 1.2) или нет баланса. Дождитесь подтверждения "
            "и нажмите Connect ещё раз.", warn=True)


def page_usage(c):
    header_light(c, 6, "Как пользоваться")
    y = H - 64
    text(c, "ВОЗМОЖНОСТИ", M, y, "PxB", 8, ACC); y -= 24
    text(c, "8 инструментов в одном коннекторе", M, y, "Un", 16, INK); y -= 16
    feats = [("Генерация", "квадрат, альбом, портрет; до 4 вариантов; прозрачный фон"),
             ("Правка", "доработка по id или по ссылке, исходник цел"),
             ("Своё фото", "загрузка по ссылке, даже HEIC с айфона"),
             ("Маска", "меняется только закрашенная зона"),
             ("Совмещение", "2–6 картинок: одежда, тату, коллаж, стиль"),
             ("Галерея", "последние картинки со ссылками"),
             ("Удаление", "ссылка перестаёт работать"),
             ("Расходы", "точная сумма за месяц и всего")]
    fw4 = (CW - 3 * 9) / 4
    for i, (a, b) in enumerate(feats):
        xx = M + (i % 4) * (fw4 + 9); yy = y - (i // 4) * 68
        rrect(c, xx, yy - 60, fw4, 60, 10, fill=WHITE, stroke=LINE)
        rrect(c, xx + 10, yy - 19, 4, 10, 2, fill=ACC)
        text(c, a, xx + 20, yy - 17.5, "PxB", 9.2, INK)
        para(c, b, xx + 10, yy - 24, fw4 - 18, st(fontSize=7.8, leading=10.2, textColor=MUT))
    y -= 2 * 68 + 14

    text(c, "КАЧЕСТВО И ЦЕНА — ВЫБИРАЕТЕ ВЫ", M, y, "PxB", 8, ACC); y -= 12
    q = [("low", "$0.01–0.02", "черновики, поиск идеи"), ("medium", "$0.04–0.06", "основная работа, посты"),
         ("high", "$0.17–0.25", "финальные картинки")]
    qw = (CW - 20) / 3
    for i, (a, b, d) in enumerate(q):
        xx = M + i * (qw + 10)
        rrect(c, xx, y - 64, qw, 64, 10, fill=DARK if i == 1 else WHITE, stroke=None if i == 1 else LINE)
        fg = C("#F2EFE6") if i == 1 else INK
        text(c, a, xx + 14, y - 20, "PxB", 9.4, MINT if i == 1 else ACC)
        text(c, b, xx + 14, y - 40, "Un", 13, fg)
        text(c, d, xx + 14, y - 55, "Px", 8, SAGE if i == 1 else MUT)
    y -= 76
    para(c, "Правка фото дороже генерации: входная картинка тоже оплачивается (medium — обычно $0.06–0.15). "
            "Точная стоимость приходит в каждом ответе.", M, y, CW, S_BODY_S)
    y -= 52

    text(c, "КАК ОТРЕДАКТИРОВАТЬ СВОЁ ФОТО", M, y, "PxB", 8, ACC); y -= 12
    steps = [("1", "Скажите: «хочу отредактировать своё фото»"), ("2", "Ассистент даст ссылку для загрузки"),
             ("3", "Откройте её, выберите фото → «Загрузить»"), ("4", "Напишите «загрузил» и что сделать")]
    sw4 = (CW - 3 * 16) / 4
    for i, (n, s_) in enumerate(steps):
        xx = M + i * (sw4 + 16)
        rrect(c, xx, y - 70, sw4, 70, 10, fill=SOFT, stroke=LINE)
        rrect(c, xx + 10, y - 30, 20, 20, 6, fill=ACC)
        text(c, n, xx + 20, y - 24, "Un", 10, WHITE, "c")
        para(c, s_, xx + 10, y - 36, sw4 - 18, st(fontSize=8.4, leading=11, textColor=INK))
        if i < 3: arrow(c, xx + sw4 + 2, y - 35, xx + sw4 + 14)
    y -= 84
    y = callout(c, M, y, CW, "Почему не прикрепить фото прямо в чат",
                "Инструменты коннектора принимают только текст — файл из чата до OpenAI не доедет. Поэтому фото идёт "
                "отдельной ссылкой; можно загрузить несколько сразу — для совмещения («куртку со второго фото — на "
                "человека с первого»).") - 14
    callout(c, M, y, CW, "Точечная правка маской",
            "«Измени только фон» → ассистент даст ссылку на рисовалку маски → закрасьте зону. Всё, что вне маски, "
            "останется пиксель в пиксель.")


def page_faq(c):
    header_light(c, 7, "Частые вопросы и безопасность")
    y = H - 64
    text(c, "ЧАСТЫЕ ВОПРОСЫ", M, y, "PxB", 8, ACC); y -= 12
    faq = [("«Ключ рабочий, но модели картинок недоступны»", "Не пройдена верификация организации (шаг 1.2) или нет баланса. Дождитесь подтверждения и переподключите."),
           ("«OpenAI не принял API-ключ (401)»", "Ключ удалён или скопирован не полностью. Создайте новый и переподключите коннектор."),
           ("«Лимит запросов или исчерпан баланс»", "Пополните Billing или проверьте Settings → Limits."),
           ("Чат пишет «таймаут», картинки нет", "High рисуется дольше минуты, чат прерывает ожидание. Картинка сохраняется — «покажи последние картинки»."),
           ("«Картинка не найдена или истёк срок»", "Картинки хранятся 30 дней — скачивайте нужное."),
           ("Ассистент: «не могу загрузить фото»", "Попросите его дать ссылку для загрузки (get_upload_link)."),
           ("В ChatGPT нет кнопки Create", "Не включён Developer mode или план Free."),
           ("Как отключить или сменить ключ", "Отключите коннектор и подключите снова с новым ключом; старый удалите на platform.openai.com.")]
    qw = (CW - 12) / 2
    for row in [faq[i:i + 2] for i in range(0, len(faq), 2)]:
        hs = []
        for _, a in row:
            p = Paragraph(a, st(fontSize=8.2, leading=11.2, textColor=MUT)); _, h_ = p.wrap(qw - 24, 300); hs.append(h_)
        rh = max(hs) + 34
        for j, (qq, a) in enumerate(row):
            xx = M + j * (qw + 12)
            rrect(c, xx, y - rh, qw, rh, 10, fill=SOFT, stroke=LINE)
            text(c, qq, xx + 12, y - 17, "PxB", 8.8, INK)
            para(c, a, xx + 12, y - 23, qw - 24, st(fontSize=8.2, leading=11.2, textColor=MUT))
        y -= rh + 8
    y -= 10
    text(c, "БЕЗОПАСНОСТЬ", M, y, "PxB", 8, ACC); y -= 10
    y = callout(c, M, y, CW, "Ваш ключ — только у вас",
                "Ключ OpenAI хранится в зашифрованном виде в вашем Cloudflare, в чатах его нет. Картинки открываются "
                "по случайной ссылке без входа — у кого ссылка, тот увидит; ненужное удаляйте. Посторонний, узнавший "
                "адрес сервера, подключится только со своим ключом — ваш баланс он не тратит.") - 16

    kh = 64
    rrect(c, M, y - kh, CW, kh, 12, fill=WHITE, stroke=LINE)
    rrect(c, M + 14, y - kh / 2 - 17, 34, 34, 9, fill=DARK)
    c.saveState(); c.setStrokeColor(MINT); c.setLineWidth(1.6); c.setLineCap(1); c.setLineJoin(1)
    c.line(M + 22, y - kh / 2 + 5, M + 28, y - kh / 2); c.line(M + 28, y - kh / 2, M + 22, y - kh / 2 - 5)
    c.line(M + 31, y - kh / 2 - 6, M + 40, y - kh / 2 - 6); c.restoreState()
    text(c, "ЛЕНЬ ДЕЛАТЬ РУКАМИ?", M + 62, y - 20, "PxB", 7.8, ACC)
    text(c, "Пусть всё сделает ИИ-агент", M + 62, y - 37, "Un", 12, INK)
    text(c, "Промт для Claude Code или Codex — на следующей странице.", M + 62, y - 52, "Px", 8.4, MUT)
    button(c, W - M - 118, y - kh / 2 - 10.5, "Промт → стр. 8", fill=ACC)
    y -= kh + 14

    bh = 96
    rrect(c, M, y - bh, CW, bh, 14, fill=DARK)
    rrect(c, W - M - 86, y - bh + 12, 72, 72, 7, fill=WHITE)
    qr(c, REPO, W - M - 82, y - bh + 16, 64)
    c.linkURL(REPO, (M, y - bh, W - M, y), relative=0)
    text(c, "Код, обновления и помощь", M + 20, y - 30, "Un", 13, C("#F2EFE6"))
    para(c, "Всё открыто на GitHub: код, подробная инструкция, раздел Issues для вопросов. Новые версии "
            "подтягиваются кнопкой Sync fork в вашей копии — Cloudflare пересоберёт сам.",
         M + 20, y - 40, CW - 140, st(fontSize=8.8, leading=12.4, textColor=SAGE_T))


def page_agent(c):
    header_light(c, 8, "Установка с ИИ-агентом")
    y = H - 64
    text(c, "ВАРИАНТ БЕЗ РУЧНОЙ РАБОТЫ", M, y, "PxB", 8, ACC); y -= 24
    text(c, "Пусть всё сделает ИИ-агент", M, y, "Un", 17, INK); y -= 16
    y -= para(c, "Откройте на компьютере <b>Claude Code</b> или <b>OpenAI Codex</b> и вставьте промт ниже целиком. "
              "Агент сам выполнит терминальную часть, а браузерные шаги проведёт с вами по одному клику.",
              M, y, CW, st(fontSize=10.2, leading=15, textColor=MUT)) + 10
    cards = [("Агент делает сам", "клонирует код, ставит зависимости, разворачивает сервер, создаёт хранилище"),
             ("Вы — в браузере", "кабинет OpenAI, вход в аккаунты, подключение: по одному клику"),
             ("Ключ — только вы", "вставляете на странице коннектора; в чат и терминал он не попадает")]
    cw3 = (CW - 20) / 3
    for i, (a, b) in enumerate(cards):
        xx = M + i * (cw3 + 10)
        rrect(c, xx, y - 70, cw3, 70, 10, fill=WHITE, stroke=LINE)
        rrect(c, xx + 12, y - 20, 4, 10, 2, fill=ACC)
        text(c, a, xx + 22, y - 18.5, "PxB", 9.4, INK)
        para(c, b, xx + 12, y - 26, cw3 - 22, st(fontSize=8, leading=10.6, textColor=MUT))
    y -= 82
    from reportlab.lib.utils import simpleSplit
    lines = []
    for raw in agent_prompt_text().split("\n"):
        lines += simpleSplit(raw, "Mo", 7.1, CW - 36) if raw.strip() else [""]
    lh = 9.3
    bh = len(lines) * lh + 28
    rrect(c, M, y - bh, CW, bh, 12, fill=DARK)
    text(c, "ПРОМТ — СКОПИРУЙТЕ ЦЕЛИКОМ", M + 18, y - 16, "PxB", 7.4, MINT)
    yy = y - 30
    for ln in lines:
        text(c, ln, M + 18, yy, "Mo", 7.1, C("#E2DCF5")); yy -= lh
    y -= bh + 12
    rrect(c, W - M - 62, y - 58, 58, 58, 5, fill=WHITE, stroke=LINE)
    qr(c, PROMPT_URL, W - M - 59, y - 55, 52)
    c.linkURL(PROMPT_URL, (W - M - 62, y - 58, W - M - 4, y), relative=0)
    para(c, "Копировать текст из PDF неудобно — возьмите промт на GitHub: <font name='Mo' size='8'>docs/AGENT_PROMPT.md</font> "
            "(QR-код справа). Если агент ошибся — пусть сверится с «Частыми вопросами» на стр. 7.",
         M, y - 6, CW - 80, S_BODY_S)


def build(out):
    c = rl_canvas.Canvas(out, pagesize=A4)
    c.setTitle("Картинки OpenAI → Claude и ChatGPT: инструкция по подключению")
    c.setAuthor("deslabpro-max")
    c.setSubject("Личный MCP-коннектор OpenAI Images (gpt-image-2) для Claude и ChatGPT")
    for fn in (page_cover, page_overview, page_step1, page_step2, page_step3, page_usage, page_faq, page_agent):
        fn(c); c.showPage()
    c.save()


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "guide.pdf")
    print("OK")
