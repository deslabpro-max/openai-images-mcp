# Сборка PDF-инструкции

```bash
pip install reportlab pillow
python3 docs/pdf/make_cover.py
python3 docs/pdf/make_guide.py "docs/Инструкция-Картинки-OpenAI.pdf"
```

Шрифты (OFL): IBM Plex Sans / Mono и Unbounded, статические начертания
получены из вариативных файлов google/fonts.

Обложка: иллюстрацию `cover.jpg` (сгенерирована этим же коннектором)
скрипт `make_cover.py` превращает в фон A4 `cover-full.jpg`; без него
собирается векторная обложка.
