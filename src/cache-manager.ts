import { normalizePath } from "obsidian";
import type { ParsedParticipant } from "./response-parser";

export interface CachedMeetingRecord {
	id: string;
	title: string;
	date: string; // ISO date "2026-03-03"
	startTime: string; // e.g. "3:00 PM"
	startMinutes?: number | null;
	endMinutes?: number | null;
	durationMinutes?: string;
	created: string; // ISO datetime
	url: string;
	folder?: string;
	folders?: string[];
	participants: ParsedParticipant[];
	privateNotes: string;
	enhancedNotes: string;
	lastSyncedAt: string;
}

export interface CachedTranscriptRecord {
	id: string;
	transcript: string;
	fetchedAt: string;
}

export interface CacheAdapter {
	exists(normalizedPath: string): Promise<boolean>;
	read(normalizedPath: string): Promise<string>;
	write(normalizedPath: string, data: string): Promise<void>;
	mkdir(normalizedPath: string): Promise<void>;
	list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
	remove(normalizedPath: string): Promise<void>;
}

export class GranolaCacheStore {
	private readonly adapter: CacheAdapter;
	private readonly meetingsDir: string;
	private readonly transcriptsDir: string;
	private initialized = false;

	constructor(adapter: CacheAdapter, cacheBasePath: string) {
		this.adapter = adapter;
		const normalizedBase = normalizePath(cacheBasePath);
		this.meetingsDir = normalizePath(`${normalizedBase}/meetings`);
		this.transcriptsDir = normalizePath(`${normalizedBase}/transcripts`);
	}

	private safeId(id: string): string {
		return encodeURIComponent(id).replace(/%/g, "_");
	}

	private meetingFilePath(id: string): string {
		return normalizePath(`${this.meetingsDir}/${this.safeId(id)}.json`);
	}

	private transcriptFilePath(id: string): string {
		return normalizePath(`${this.transcriptsDir}/${this.safeId(id)}.json`);
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await this.ensureDirectory(this.meetingsDir);
		await this.ensureDirectory(this.transcriptsDir);
		this.initialized = true;
	}

	private async ensureDirectory(dirPath: string): Promise<void> {
		const exists = await this.adapter.exists(dirPath);
		if (!exists) {
			await this.adapter.mkdir(dirPath);
		}
	}

	async saveMeeting(record: CachedMeetingRecord): Promise<void> {
		await this.init();
		const path = this.meetingFilePath(record.id);
		await this.adapter.write(path, JSON.stringify(record, null, 2));
	}

	async getMeeting(id: string): Promise<CachedMeetingRecord | null> {
		await this.init();
		const path = this.meetingFilePath(id);
		const exists = await this.adapter.exists(path);
		if (!exists) return null;
		try {
			const data = await this.adapter.read(path);
			return JSON.parse(data) as CachedMeetingRecord;
		} catch (e) {
			console.error(`Granola: failed to read cached meeting ${id}`, e);
			return null;
		}
	}

	async hasMeeting(id: string): Promise<boolean> {
		await this.init();
		return this.adapter.exists(this.meetingFilePath(id));
	}

	async listMeetings(): Promise<CachedMeetingRecord[]> {
		await this.init();
		try {
			const list = await this.adapter.list(this.meetingsDir);
			const records: CachedMeetingRecord[] = [];
			for (const filePath of list.files) {
				if (!filePath.endsWith(".json")) continue;
				try {
					const data = await this.adapter.read(filePath);
					const record = JSON.parse(data) as CachedMeetingRecord;
					if (record && record.id) {
						records.push(record);
					}
				} catch (e) {
					console.error(`Granola: failed to parse cached file ${filePath}`, e);
				}
			}
			return records;
		} catch (e) {
			console.error("Granola: failed to list cached meetings", e);
			return [];
		}
	}

	async saveTranscript(id: string, transcript: string): Promise<void> {
		await this.init();
		const path = this.transcriptFilePath(id);
		const record: CachedTranscriptRecord = {
			id,
			transcript,
			fetchedAt: new Date().toISOString(),
		};
		await this.adapter.write(path, JSON.stringify(record, null, 2));
	}

	async getTranscript(id: string): Promise<string | null> {
		await this.init();
		const path = this.transcriptFilePath(id);
		const exists = await this.adapter.exists(path);
		if (!exists) return null;
		try {
			const data = await this.adapter.read(path);
			const record = JSON.parse(data) as CachedTranscriptRecord;
			return record.transcript;
		} catch (e) {
			console.error(`Granola: failed to read cached transcript ${id}`, e);
			return null;
		}
	}

	async hasTranscript(id: string): Promise<boolean> {
		await this.init();
		return this.adapter.exists(this.transcriptFilePath(id));
	}

	async listTranscriptIds(): Promise<Set<string>> {
		await this.init();
		const ids = new Set<string>();
		try {
			const list = await this.adapter.list(this.transcriptsDir);
			for (const filePath of list.files) {
				if (!filePath.endsWith(".json")) continue;
				try {
					const data = await this.adapter.read(filePath);
					const record = JSON.parse(data) as CachedTranscriptRecord;
					if (record && record.id) {
						ids.add(record.id);
					}
				} catch {
					// Ignore invalid transcript files
				}
			}
		} catch (e) {
			console.error("Granola: failed to list cached transcripts", e);
		}
		return ids;
	}

	async getStats(): Promise<{ meetingCount: number; transcriptCount: number }> {
		await this.init();
		let meetingCount = 0;
		let transcriptCount = 0;
		try {
			const meetingsList = await this.adapter.list(this.meetingsDir);
			meetingCount = meetingsList.files.filter((f) => f.endsWith(".json")).length;
		} catch {
			// ignore
		}
		try {
			const transcriptsList = await this.adapter.list(this.transcriptsDir);
			transcriptCount = transcriptsList.files.filter((f) => f.endsWith(".json")).length;
		} catch {
			// ignore
		}
		return { meetingCount, transcriptCount };
	}

	async clear(): Promise<void> {
		await this.init();
		try {
			const meetingsList = await this.adapter.list(this.meetingsDir);
			for (const f of meetingsList.files) {
				await this.adapter.remove(f);
			}
		} catch {
			// ignore
		}
		try {
			const transcriptsList = await this.adapter.list(this.transcriptsDir);
			for (const f of transcriptsList.files) {
				await this.adapter.remove(f);
			}
		} catch {
			// ignore
		}
	}
}
