# Report fonts

Embedded in generated PDF reports (`server/src/reports.ts`) so chat, notes and
names in English **and Tamil** render correctly. The built-in PDF fonts cover
Windows-1252 only.

| File | Covers | Source |
|---|---|---|
| `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf` | Latin, Greek, Cyrillic, common punctuation | https://github.com/notofonts/latin-greek-cyrillic |
| `NotoSansTamil-Regular.ttf`, `NotoSansTamil-Bold.ttf` | Tamil (U+0B80–U+0BFF) | https://github.com/notofonts/tamil |

Licence: SIL Open Font License 1.1 (`OFL.txt`) — redistribution and embedding
permitted. Tamil shaping (vowel-sign reordering, conjuncts) is done by fontkit's
OpenType Indic shaper, which pdfkit uses when a TrueType font is embedded.
