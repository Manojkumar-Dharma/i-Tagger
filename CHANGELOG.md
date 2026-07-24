# Change Log

## 0.1.0

- New: **auto-tag mode**, toggled per file via the status bar item (or "iTagger: Toggle Auto-Tag for This File"). Once turned on, every line you finish with Enter is tagged automatically using the tag you entered when turning it on - until you turn it off again for that file. For CL/CLLE/CLP, it correctly waits until a `+`/`-` continued statement is actually complete before tagging it as one unit. State is per-file and in-memory (resets if the file is closed).

## 0.0.9

- CL statement detection now also follows trailing `-` continuation lines (used to continue a quoted character-string literal), in addition to `+`. A statement can mix both across its lines and is still tagged as one logical unit.

## 0.0.8

- Updated the icon/logo.
- Generalized the description and README wording that referenced `//0084` as if it were the only comment style — now reflects that the marker varies by file type (`//`, `/* */`, `--`).

## 0.0.7

- CL/CLLE/CLP statements spanning multiple lines via `+` continuation are now tagged as a single logical statement instead of per-line: the tag lands once on the statement's last physical line (or, if there's no room, sandwiches the whole statement block with `-begin`/`-end` markers at column 1). Single-line CL commands are unaffected. RPGLE and SQL still tag every selected line individually.

## 0.0.6

- When a line has no room left for an inline tag, the inserted before/after lines now start at column 1 (instead of the tag column) and are marked `tag-begin` / `tag-end` so the pair is distinguishable. Applies to all supported comment styles (`//`, `/* */`, `--`).

## 0.0.5

- Renamed the extension from "RPGLE Line Tagger" to **iTagger**. Command id changed to `itagger.addTag`, and settings moved from `rpgleTagger.*` to `itagger.*`.

## 0.0.4

- SQL source files now get `-- tag` style comments. Detected by file language id (`sql`) or file extension (`.sql`).

## 0.0.3

- CLP/CLLE source files now get `/* tag */` style comments instead of `//tag`. Detected by file language id (`cl`/`clle`/`clp`) or file extension (`.clp`/`.clle`/`.cl`); all other files still use `//tag`.

## 0.0.2

- Prompt placeholder now reads "Add your tag" instead of showing a sample value.
- Added an optional second prompt to override the tag column for a single run (leave blank to use the configured default).
- Roadmap: explicit CLP/CLLE source type support planned for a future version (the extension already works on any file type today, since it doesn't check file language).

## 0.0.1

- Initial release: add source tags to selected RPGLE lines with column-90 placement, overflow append, and sandwich-line fallback.
