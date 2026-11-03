import { normalizePath } from "obsidian";

/**
 * Granola's attachment ids are UUIDs. Each image is saved under its id, which
 * makes the filename unique across the vault: an `![[id.png]]` embed resolves
 * wherever the file ends up, and a later sync finds it again by name alone.
 * Ids are checked against this before they reach a path.
 */
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

export function isAttachmentId(id: string): boolean {
	return ATTACHMENT_ID.test(id);
}

/** The extension to save an image under. Screenshots are PNG, so that is the fallback. */
export function imageExtension(mimeType: string): string {
	return EXTENSIONS[mimeType.toLowerCase()] ?? "png";
}

/**
 * Images synced on an earlier run, keyed by attachment id.
 *
 * Built from the whole vault rather than the image folder, the way notes are
 * matched by `granola_id`: an image the user moved is still found, so a
 * meeting that syncs again neither downloads it twice nor loses its embed.
 */
export function indexSyncedImages<T extends { basename: string; extension: string }>(
	files: T[],
): Map<string, T> {
	const extensions = new Set(Object.values(EXTENSIONS));
	const index = new Map<string, T>();
	for (const file of files) {
		if (extensions.has(file.extension) && ATTACHMENT_ID.test(file.basename)) {
			index.set(file.basename.toLowerCase(), file);
		}
	}
	return index;
}

/**
 * The folder a meeting's images are saved into: a subfolder named after the
 * meeting's note, inside the image folder setting.
 *
 * A setting starting with `./` is relative to the note's folder, the same
 * convention Obsidian uses for its own attachment location, so meetings filed
 * into dated folders keep their images beside them. Anything else is a path
 * from the vault root.
 */
export function resolveImageFolder(setting: string, noteFolder: string, noteName: string): string {
	const relative = setting.trim().match(/^\.(?:\/(.*))?$/);
	const base = relative ? `${noteFolder}/${relative[1] ?? ""}` : setting.trim();
	return normalizePath(`${base}/${noteName}`);
}
