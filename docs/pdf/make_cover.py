#!/usr/bin/env python3
"""Собирает фон обложки A4 (cover-full.jpg) из иллюстрации cover.(jpg|png|webp):
цвет фона берётся с верхней кромки картинки, края плавно растворяются."""
import os, statistics, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
src = next((os.path.join(HERE, f) for f in ("cover.jpg", "cover.png", "cover.webp")
            if os.path.exists(os.path.join(HERE, f))), None)
if not src:
    sys.exit("нет cover.jpg/png/webp рядом со скриптом")
PW, PH = 1654, 2339                                   # A4 @ 200 dpi
img = Image.open(src).convert("RGB")
iw, ih = img.size
BG = tuple(int(statistics.median(ch)) for ch in zip(*[img.getpixel((x, 3)) for x in range(0, iw, 16)]))
nh = round(ih * PW / iw)
img = img.resize((PW, nh), Image.LANCZOS)
canvas = Image.new("RGB", (PW, PH), BG)
y0 = PH - nh - round(176 / 842 * PH)                  # низ картинки — над плашкой статистики
mask = Image.new("L", (PW, nh), 255); md = ImageDraw.Draw(mask)
feather = round(nh * 0.25)
for i in range(feather):
    md.line((0, i, PW, i), fill=round(255 * (i / feather) ** 1.6))
bfeather = round(nh * 0.16)                           # и нижний край
for i in range(bfeather):
    md.line((0, nh - 1 - i, PW, nh - 1 - i), fill=round(255 * (i / bfeather) ** 1.2))
canvas.paste(img, (0, y0), mask)
bot = Image.new("L", (PW, PH), 0); bd = ImageDraw.Draw(bot)
band = round(PH * 0.22)
for i in range(band):
    bd.line((0, PH - band + i, PW, PH - band + i), fill=round(245 * (i / band) ** 1.3))
canvas.paste(Image.new("RGB", (PW, PH), BG), (0, 0), bot)
canvas.save(os.path.join(HERE, "cover-full.jpg"), quality=88)
print("cover-full.jpg, фон", BG)
