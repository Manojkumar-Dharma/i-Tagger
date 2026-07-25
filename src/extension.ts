import * as vscode from 'vscode';

const DEFAULT_MAX_LINE_LENGTH = 100;
const DEFAULT_TAG_COLUMN = 90; // 1-indexed column where the tag starts when there's room
const MAX_TAG_LENGTH = 10;

// Language ids and file extensions that indicate a CL (CLP/CLLE) source member,
// which uses /* ... */ comments instead of RPGLE's // comments.
const CL_LANGUAGE_IDS = ['cl', 'clle', 'clp'];
const CL_FILE_EXTENSIONS = ['clp', 'clle', 'cl'];

// Language ids and file extensions for SQL source members, which use -- comments.
const SQL_LANGUAGE_IDS = ['sql'];
const SQL_FILE_EXTENSIONS = ['sql'];

function isClSource(document: vscode.TextDocument): boolean {
	if (CL_LANGUAGE_IDS.includes(document.languageId.toLowerCase())) {
		return true;
	}
	const ext = document.fileName.split('.').pop()?.toLowerCase() ?? '';
	return CL_FILE_EXTENSIONS.includes(ext);
}

function isSqlSource(document: vscode.TextDocument): boolean {
	if (SQL_LANGUAGE_IDS.includes(document.languageId.toLowerCase())) {
		return true;
	}
	const ext = document.fileName.split('.').pop()?.toLowerCase() ?? '';
	return SQL_FILE_EXTENSIONS.includes(ext);
}

function buildTagText(tag: string, document: vscode.TextDocument): string {
	if (isClSource(document)) {
		return `/* ${tag} */`;
	}
	if (isSqlSource(document)) {
		return `-- ${tag}`;
	}
	return `//${tag}`;
}

/**
 * True if this CL line continues onto the next line. CL uses a trailing '+'
 * for general statement continuation, and a trailing '-' specifically to
 * continue a quoted character-string literal across lines.
 */
function continuesToNextLine(document: vscode.TextDocument, lineNum: number): boolean {
	const trimmed = document.lineAt(lineNum).text.replace(/\s+$/, '');
	return trimmed.endsWith('+') || trimmed.endsWith('-');
}

/**
 * Given any line that's part of a CL statement, walks backward/forward across
 * '+' continuations to find the full logical statement's start and end lines.
 * For a non-continued (single-line) command, start === end === lineNum.
 */
function findClStatementRange(document: vscode.TextDocument, lineNum: number): { start: number; end: number } {
	let start = lineNum;
	while (start > 0 && continuesToNextLine(document, start - 1)) {
		start--;
	}
	let end = lineNum;
	while (end < document.lineCount - 1 && continuesToNextLine(document, end)) {
		end++;
	}
	return { start, end };
}

const LAST_TAG_KEY = 'itagger.lastTag';

let workspaceState: vscode.Memento;

function getLastTag(): string | undefined {
	return workspaceState?.get<string>(LAST_TAG_KEY);
}

function saveLastTag(tag: string): void {
	workspaceState?.update(LAST_TAG_KEY, tag);
}

export function activate(context: vscode.ExtensionContext) {
	workspaceState = context.workspaceState;

	const disposable = vscode.commands.registerCommand('itagger.addTag', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}

		if (editor.selections.every(s => s.isEmpty)) {
			vscode.window.showWarningMessage('Select one or more lines first.');
			return;
		}

		const tag = await promptForTag();
		if (!tag) {
			return; // user cancelled
		}
		saveLastTag(tag);

		const config = vscode.workspace.getConfiguration('itagger');
		const maxLineLength = config.get<number>('maxLineLength', DEFAULT_MAX_LINE_LENGTH);
		const defaultTagColumn = config.get<number>('tagColumn', DEFAULT_TAG_COLUMN);
		const tagColumn = await promptForTagColumn(defaultTagColumn, maxLineLength);

		applyTags(editor, tag, editor.document, maxLineLength, tagColumn);
	});
	context.subscriptions.push(disposable);

	context.subscriptions.push(...registerAutoTag(context));
}

async function promptForTag(): Promise<string | undefined> {
	const lastTag = getLastTag();
	return vscode.window.showInputBox({
		prompt: `Enter source tag (max ${MAX_TAG_LENGTH} characters)`,
		placeHolder: 'Add your tag',
		value: lastTag,
		valueSelection: lastTag ? [0, lastTag.length] : undefined,
		validateInput: (value) => {
			if (!value || value.trim().length === 0) {
				return 'Tag cannot be empty';
			}
			if (value.length > MAX_TAG_LENGTH) {
				return `Tag must be ${MAX_TAG_LENGTH} characters or fewer`;
			}
			if (/\s/.test(value)) {
				return 'Tag cannot contain spaces';
			}
			return null;
		}
	});
}

async function promptForTagColumn(defaultTagColumn: number, maxLineLength: number): Promise<number> {
	// Optional per-run override of the tag column. Leave blank to use the
	// configured default (itagger.tagColumn).
	const columnInput = await vscode.window.showInputBox({
		prompt: `Tag column (optional - press Enter to use default: ${defaultTagColumn})`,
		placeHolder: `${defaultTagColumn}`,
		validateInput: (value) => {
			if (!value || value.trim().length === 0) {
				return null; // empty is fine - falls back to the default
			}
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1 || n > maxLineLength) {
				return `Enter a whole number between 1 and ${maxLineLength}`;
			}
			return null;
		}
	});
	return (columnInput !== undefined && columnInput.trim().length > 0)
		? Number(columnInput.trim())
		: defaultTagColumn;
}

// ---------------------------------------------------------------------------
// Auto-tag mode: once turned on for a file, every line finished with Enter
// gets tagged automatically (using the tag chosen when turning it on), until
// turned off for that same file. State is per-document and in-memory only -
// it resets if the file is closed or the window reloads.
// ---------------------------------------------------------------------------

interface AutoTagState {
	tag: string;
	tagColumn: number;
	maxLineLength: number;
}

const autoTagByDocument = new Map<string, AutoTagState>();

// Auto-tag settings persisted per file so they survive closing/reopening a
// file or reloading the window - but restoring them always asks for
// confirmation first (see maybeOfferRestore) rather than silently turning
// back on, since picking up an old tag without the person noticing could tag
// lines they didn't mean to.
const AUTO_TAG_PERSIST_KEY = 'itagger.autoTagPersisted';

function getPersistedAutoTag(): Record<string, AutoTagState> {
	return workspaceState?.get<Record<string, AutoTagState>>(AUTO_TAG_PERSIST_KEY) ?? {};
}

function setPersistedAutoTag(key: string, state: AutoTagState): void {
	const all = getPersistedAutoTag();
	all[key] = state;
	workspaceState?.update(AUTO_TAG_PERSIST_KEY, all);
}

function removePersistedAutoTag(key: string): void {
	const all = getPersistedAutoTag();
	if (key in all) {
		delete all[key];
		workspaceState?.update(AUTO_TAG_PERSIST_KEY, all);
	}
}

// Document URIs currently being edited programmatically by this extension
// (either the manual command or auto-tag itself). The change listener skips
// these so it never mistakes our own tag-insertion edits for user typing or
// pasting - which matters now that paste detection also looks for inserted
// newlines, since case-3 tag-sandwiching inserts newlines too.
const programmaticEditInProgress = new Set<string>();

async function runProgrammaticEdit(editor: vscode.TextEditor, run: (editBuilder: vscode.TextEditorEdit) => void): Promise<void> {
	const key = editor.document.uri.toString();
	programmaticEditInProgress.add(key);
	try {
		await editor.edit(run);
	} finally {
		programmaticEditInProgress.delete(key);
	}
}

function registerAutoTag(context: vscode.ExtensionContext): vscode.Disposable[] {
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'itagger.toggleAutoTag';

	const updateStatusBar = (editor: vscode.TextEditor | undefined) => {
		if (!editor) {
			statusBarItem.hide();
			return;
		}
		const key = editor.document.uri.toString();
		const state = autoTagByDocument.get(key);
		if (state) {
			statusBarItem.text = `$(tag) iTagger: ON (${state.tag})`;
			statusBarItem.tooltip = `Auto-tagging new lines with "${state.tag}" in this file. Click to turn off.`;
		} else {
			statusBarItem.text = '$(tag) iTagger: OFF';
			statusBarItem.tooltip = 'Click to auto-tag every new line in this file until turned off.';
		}
		statusBarItem.show();
	};

	// Tracks which documents we've already asked about restoring auto-tag
	// this session, so switching back to the same tab doesn't ask again.
	const askedThisSession = new Set<string>();

	const maybeOfferRestore = (editor: vscode.TextEditor | undefined) => {
		if (!editor) {
			return;
		}
		const key = editor.document.uri.toString();
		if (autoTagByDocument.has(key) || askedThisSession.has(key)) {
			return;
		}
		const persisted = getPersistedAutoTag()[key];
		if (!persisted) {
			return;
		}
		askedThisSession.add(key);

		vscode.window.showInformationMessage(
			`iTagger: this file previously had auto-tag ON with tag "${persisted.tag}". Turn it back on?`,
			'Turn On',
			"Don't Ask Again"
		).then(choice => {
			if (choice === 'Turn On') {
				autoTagByDocument.set(key, persisted);
				vscode.window.showInformationMessage(`iTagger: auto-tagging new lines with "${persisted.tag}" until you turn it off.`);
				updateStatusBar(vscode.window.activeTextEditor);
			} else if (choice === "Don't Ask Again") {
				removePersistedAutoTag(key);
			}
			// Dismissed without a choice: leave it persisted, ask again next time.
		});
	};

	const toggleCommand = vscode.commands.registerCommand('itagger.toggleAutoTag', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const key = editor.document.uri.toString();

		if (autoTagByDocument.has(key)) {
			autoTagByDocument.delete(key);
			removePersistedAutoTag(key);
			vscode.window.showInformationMessage('iTagger: auto-tag turned off for this file.');
			updateStatusBar(editor);
			return;
		}

		const tag = await promptForTag();
		if (!tag) {
			return; // user cancelled - stay off
		}
		saveLastTag(tag);
		const config = vscode.workspace.getConfiguration('itagger');
		const maxLineLength = config.get<number>('maxLineLength', DEFAULT_MAX_LINE_LENGTH);
		const defaultTagColumn = config.get<number>('tagColumn', DEFAULT_TAG_COLUMN);
		const tagColumn = await promptForTagColumn(defaultTagColumn, maxLineLength);

		const state: AutoTagState = { tag, tagColumn, maxLineLength };
		autoTagByDocument.set(key, state);
		setPersistedAutoTag(key, state);
		askedThisSession.add(key); // no need to offer-restore what's already on
		vscode.window.showInformationMessage(`iTagger: auto-tagging new lines with "${tag}" until you turn it off.`);
		updateStatusBar(editor);
	});

	const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
		const document = event.document;
		const key = document.uri.toString();
		const state = autoTagByDocument.get(key);
		if (!state || programmaticEditInProgress.has(key)) {
			return; // no auto-tag here, or this change is our own edit - ignore it
		}

		const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

		// A line counts as "completed" when a newline was just inserted right
		// after it - whether that's a single Enter keypress or a multi-line
		// paste. change.text.split on any newline gives one fragment per
		// resulting line; every fragment boundary except the last one marks a
		// newly completed line (the last fragment is still being edited, same
		// as the fresh empty line after a plain Enter, so it's left alone).
		const completedLines = new Set<number>();
		for (const change of event.contentChanges) {
			const fragments = change.text.split(/\r\n|\r|\n/);
			const newlineCount = fragments.length - 1;
			for (let i = 0; i < newlineCount; i++) {
				const lineNum = change.range.start.line + i;
				if (lineNum < document.lineCount) {
					completedLines.add(lineNum);
				}
			}
		}

		if (completedLines.size > 0) {
			autoTagLines(document, Array.from(completedLines).sort((a, b) => a - b), state, eol, key);
		}
	});

	const closeListener = vscode.workspace.onDidCloseTextDocument(document => {
		autoTagByDocument.delete(document.uri.toString());
		askedThisSession.delete(document.uri.toString());
	});

	const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
		updateStatusBar(editor);
		maybeOfferRestore(editor);
	});
	const openListener = vscode.workspace.onDidOpenTextDocument(document => {
		const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
		maybeOfferRestore(editor);
	});

	updateStatusBar(vscode.window.activeTextEditor);
	maybeOfferRestore(vscode.window.activeTextEditor);

	return [statusBarItem, toggleCommand, changeListener, closeListener, activeEditorListener, openListener];
}

function autoTagLines(document: vscode.TextDocument, completedLines: number[], state: AutoTagState, eol: string, key: string) {
	const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
	if (!editor) {
		return;
	}

	const tagText = buildTagText(state.tag, document);
	const colIndex = state.tagColumn - 1;

	// Resolve each candidate line to its actual tagging target: for CL, a
	// completed line that's still mid-continuation defers to whichever later
	// line finally completes the statement, and every line belonging to the
	// same statement collapses to a single target (dedupe by statement end).
	const targets = new Map<number, { start: number; end: number }>();
	for (const lineNum of completedLines) {
		const lineText = document.lineAt(lineNum).text.replace(/\s+$/, '');
		if (lineText.length === 0) {
			continue; // blank line - nothing to tag
		}

		if (isClSource(document)) {
			if (continuesToNextLine(document, lineNum)) {
				continue; // statement isn't finished yet
			}
			const range = findClStatementRange(document, lineNum);
			targets.set(range.end, range);
		} else {
			targets.set(lineNum, { start: lineNum, end: lineNum });
		}
	}

	if (targets.size === 0) {
		return;
	}

	runProgrammaticEdit(editor, editBuilder => {
		for (const range of targets.values()) {
			const lastLineTrimmed = document.lineAt(range.end).text.replace(/\s+$/, '');
			if (lastLineTrimmed.endsWith(tagText)) {
				continue; // already tagged - avoid double-tagging
			}
			tagReferenceLine(editBuilder, document, range.end, range.start, range.end, state.tag, tagText, state.maxLineLength, colIndex, eol);
		}
	});
}

/**
 * Collects the set of line numbers touched by the current selections.
 */
function collectTouchedLines(editor: vscode.TextEditor): Set<number> {
	const lineNumbers = new Set<number>();
	for (const sel of editor.selections) {
		if (sel.isEmpty) {
			continue;
		}
		const startLine = sel.start.line;
		const endLine = sel.end.line;
		for (let ln = startLine; ln <= endLine; ln++) {
			// A selection that ends exactly at column 0 of endLine doesn't
			// really "include" that line's content (e.g. triple-click a line).
			if (ln === endLine && sel.end.character === 0 && startLine !== endLine) {
				continue;
			}
			lineNumbers.add(ln);
		}
	}
	return lineNumbers;
}

/**
 * Applies case 1/2/3 placement to a single reference line (the line the tag
 * should attach to) and, for case 3, sandwiches a wider block (blockStart..blockEnd)
 * with begin/end tag lines instead of just the reference line itself.
 */
function tagReferenceLine(
	editBuilder: vscode.TextEditorEdit,
	document: vscode.TextDocument,
	referenceLine: number,
	blockStart: number,
	blockEnd: number,
	tag: string,
	tagText: string,
	maxLineLength: number,
	colIndex: number,
	eol: string
) {
	const line = document.lineAt(referenceLine);
	const trimmedText = line.text.replace(/\s+$/, '');
	const trimmedLen = trimmedText.length;

	if (trimmedLen <= colIndex) {
		// Case 1: code hasn't reached the tag column yet -> pad and place tag there
		const padded = trimmedText.padEnd(colIndex, ' ');
		editBuilder.replace(line.range, padded + tagText);
		return;
	}

	const spaceNeeded = 1 + tagText.length; // separating space + tag
	if (trimmedLen + spaceNeeded <= maxLineLength) {
		// Case 2: code already passes the tag column, but there's still room
		editBuilder.replace(line.range, trimmedText + ' ' + tagText);
		return;
	}

	// Case 3: no room left - sandwich the whole block with tag-only lines at
	// column 1, marked -begin / -end so the pair is distinguishable.
	const beginTagLine = buildTagText(`${tag}-begin`, document);
	const endTagLine = buildTagText(`${tag}-end`, document);
	const firstLine = document.lineAt(blockStart);
	const lastLine = document.lineAt(blockEnd);
	editBuilder.insert(lastLine.range.end, eol + endTagLine);
	editBuilder.insert(firstLine.range.start, beginTagLine + eol);
}

function applyTags(editor: vscode.TextEditor, tag: string, document: vscode.TextDocument, maxLineLength: number, tagColumn: number) {
	const colIndex = tagColumn - 1; // 0-indexed string position where the tag starts
	const tagText = buildTagText(tag, document);
	const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const touchedLines = collectTouchedLines(editor);

	if (isClSource(document)) {
		// CL statements can span multiple physical lines via a trailing '+'.
		// Tag the logical statement once, at its last line - not each selected
		// line individually. Group touched lines by the statement they belong to.
		const statementsByStart = new Map<number, { start: number; end: number }>();
		for (const ln of touchedLines) {
			const range = findClStatementRange(document, ln);
			statementsByStart.set(range.start, range);
		}
		const statements = Array.from(statementsByStart.values()).sort((a, b) => b.start - a.start);

		runProgrammaticEdit(editor, editBuilder => {
			for (const stmt of statements) {
				tagReferenceLine(editBuilder, document, stmt.end, stmt.start, stmt.end, tag, tagText, maxLineLength, colIndex, eol);
			}
		});
		return;
	}

	// RPGLE, SQL, and everything else: tag every selected line individually.
	const sortedDesc = Array.from(touchedLines).sort((a, b) => b - a);

	runProgrammaticEdit(editor, editBuilder => {
		for (const lineNum of sortedDesc) {
			tagReferenceLine(editBuilder, document, lineNum, lineNum, lineNum, tag, tagText, maxLineLength, colIndex, eol);
		}
	});
}

export function deactivate() {}
