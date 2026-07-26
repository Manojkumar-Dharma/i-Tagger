# iTagger

Adds a source modification tag to selected lines in RPGLE, CLP/CLLE, and SQL source files at a fixed column, using the right comment style for each — so changes are easy to trace back to a change/PTF/ticket number.

## Usage

1. Select one or more lines in the editor (multiple selections are supported).
2. Right-click and choose **iTagger: Add Source Tag**, or run the command from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Enter a tag (max 10 characters), e.g. `0001`.
4. Optionally enter a tag column for this run only — leave it blank to use the configured default (`itagger.tagColumn`).

The extension works on any file type. RPGLE (and everything else) gets `//tag` comments; CLP and CLLE source files get `/* tag */` comments; SQL source files get `-- tag` comments.

## Placement rules

Given a 100-character line and a tag column of 90 (both configurable):

1. **Room before column 90** — the line is padded with spaces and the tag (e.g. `//0001`, `/* 0001 */`, or `-- 0001` depending on file type) is placed starting at column 90.
2. **Code already reaches column 90, but the line isn't full** — the tag is appended right after the existing text, separated by a single space.
3. **No room left on the line** — a tag-only line is inserted immediately before *and* immediately after the code line, starting at column 1 and marked `tag-begin` / `tag-end`, so the original line is left untouched.

### CL/CLLE/CLP continuation statements

A CL command that spans multiple physical lines via a trailing `+` (general continuation) or `-` (continuing a quoted character-string literal) is treated as **one logical statement**, not tagged line-by-line — a statement can mix both across its lines. Selecting any line that's part of the statement is enough — iTagger follows the continuation chain to find the statement's true start and end:

- Rules 1/2 apply to the statement's **last** physical line only.
- Rule 3, if triggered, sandwiches the **entire statement block** with `/* tag-begin */` / `/* tag-end */` at column 1, rather than wrapping just the last line.

Single-line CL commands behave exactly like RPGLE/SQL lines (rules 1-3 applied directly).

## Automatic tagging

For times you want lines tagged as you go, instead of selecting them manually each time, iTagger offers two modes:

1. Click **iTagger: OFF** in the status bar (bottom right), or run **iTagger: Toggle Auto-Tag for This File** from the Command Palette.
2. Pick a mode:
   - **Auto-tag on Enter / paste** - tags each line the moment you finish it (pressing Enter, or a multi-line paste).
   - **Tag on save** - leaves lines alone while you edit, and tags whatever changed since the last save, right before the file is saved.
3. Enter a tag, and optionally a column, same as the manual command.
4. From then on, tagging happens automatically per the mode you picked - until you toggle it off again (click the status bar item, now showing e.g. **iTagger: ON (0001) \[Enter\]** or **\[Save\]**).

Notes:
- Scoped per file - turning it on in one file doesn't affect others, and it turns off automatically when the file is closed.
- For CL/CLLE/CLP, both modes wait until a `+`/`-` continued statement is fully complete before tagging it as one unit, same as the manual command.
- **Tag on save** detects changes by comparing file content, not by tracking individual edits - so it stays correct even after several edits, insertions, or deletions between saves.
- The manual **iTagger: Add Source Tag** command (select lines, run it) works exactly the same whether automatic tagging is on or off for that file - they're independent, and never interfere with each other's edits.
- Blank lines and lines that already carry the current tag are skipped.
- Settings (including which mode) are remembered per file, per workspace. Reopening a file (or reloading the window) that previously had tagging on will ask - via a notification - whether to turn it back on; it never restores silently.

## Remembered tag

The tag prompt (manual command and auto-tag) pre-fills with whatever tag you last used, remembered separately per workspace/project. Just press Enter to reuse it, or type over it for a new one.

## Settings

| Setting | Default | Description |
|---|---|---|
| `itagger.maxLineLength` | `100` | Total usable line length. |
| `itagger.tagColumn` | `90` | 1-indexed column where the tag starts when there's room. |

## Known limitations

- Tags are plain text comments; the extension does not validate RPGLE, CL, or SQL syntax.
- Column counting is based on characters, not visual width — avoid tabs in source lines you plan to tag.
