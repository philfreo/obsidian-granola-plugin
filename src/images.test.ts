import { describe, it, expect } from "vitest";
import { imageExtension, indexSyncedImages, isAttachmentId, resolveImageFolder } from "./images";

const ID = "11111111-1111-4111-8111-111111111111";

function file(path: string) {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return { path, basename: name.slice(0, dot), extension: name.slice(dot + 1) };
}

describe("resolveImageFolder", () => {
	it("files a meeting's images in its own subfolder inside the note's folder", () => {
		expect(resolveImageFolder("./Attachments", "Meetings", "2026-03-03 Weekly Sync")).toBe(
			"Meetings/Attachments/2026-03-03 Weekly Sync",
		);
	});

	it("follows a note into a dated folder", () => {
		expect(resolveImageFolder("./Attachments", "Meetings/2026/03", "Weekly Sync")).toBe(
			"Meetings/2026/03/Attachments/Weekly Sync",
		);
	});

	it("puts the subfolder right beside the note for ./ or .", () => {
		expect(resolveImageFolder("./", "Meetings", "Weekly Sync")).toBe("Meetings/Weekly Sync");
		expect(resolveImageFolder(".", "Meetings", "Weekly Sync")).toBe("Meetings/Weekly Sync");
	});

	it("reads any other value as a path from the vault root", () => {
		expect(resolveImageFolder("Attachments/Granola", "Meetings", "Weekly Sync")).toBe(
			"Attachments/Granola/Weekly Sync",
		);
		expect(resolveImageFolder(" Attachments/ ", "Meetings", "Weekly Sync")).toBe(
			"Attachments/Weekly Sync",
		);
	});

	it("does not treat a folder that merely starts with a dot as relative", () => {
		expect(resolveImageFolder(".images", "Meetings", "Weekly Sync")).toBe(".images/Weekly Sync");
	});

	it("handles a note at the vault root", () => {
		expect(resolveImageFolder("./Attachments", "/", "Weekly Sync")).toBe("Attachments/Weekly Sync");
	});
});

describe("indexSyncedImages", () => {
	it("finds images by attachment id wherever they were moved", () => {
		const moved = file(`Somewhere/Else/${ID}.png`);
		const index = indexSyncedImages([file("Meetings/Weekly Sync.md"), moved, file("Pictures/cat.png")]);
		expect([...index.keys()]).toEqual([ID]);
		expect(index.get(ID)).toBe(moved);
	});

	it("matches ids case-insensitively", () => {
		const upper = file(`A/${ID.toUpperCase()}.jpg`);
		expect(indexSyncedImages([upper]).get(ID)).toBe(upper);
	});

	it("ignores a file named like an id that is not an image", () => {
		expect(indexSyncedImages([file(`A/${ID}.md`)]).size).toBe(0);
	});
});

describe("imageExtension", () => {
	it("maps the image types Granola sends", () => {
		expect(imageExtension("image/png")).toBe("png");
		expect(imageExtension("image/jpeg")).toBe("jpg");
		expect(imageExtension("IMAGE/WEBP")).toBe("webp");
	});

	it("falls back to png", () => {
		expect(imageExtension("")).toBe("png");
		expect(imageExtension("application/octet-stream")).toBe("png");
	});
});

describe("isAttachmentId", () => {
	it("accepts a UUID and rejects anything that could escape a folder", () => {
		expect(isAttachmentId(ID)).toBe(true);
		expect(isAttachmentId("../../etc/passwd")).toBe(false);
		expect(isAttachmentId(`${ID}/x`)).toBe(false);
	});
});
