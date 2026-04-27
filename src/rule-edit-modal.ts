import { App, Modal, Setting } from "obsidian";
import type { RoutingRule } from "./settings";
import { validateRulePattern } from "./routing";

export type RuleEditMode = "create" | "edit";

interface StackedRowOptions {
	name: string;
	description?: string;
}

function createStackedRow(parent: HTMLElement, opts: StackedRowOptions): HTMLElement {
	const row = parent.createDiv({ cls: "granola-rule-row" });
	row.createDiv({ cls: "setting-item-name", text: opts.name });
	if (opts.description) {
		row.createDiv({ cls: "setting-item-description", text: opts.description });
	}
	return row;
}

export class RoutingRuleEditModal extends Modal {
	private readonly draft: RoutingRule;

	constructor(
		app: App,
		initial: RoutingRule,
		private readonly mode: RuleEditMode,
		private readonly onSave: (rule: RoutingRule) => void | Promise<void>,
	) {
		super(app);
		this.draft = { ...initial };
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: this.mode === "create" ? "Add routing rule" : "Edit routing rule",
		});

		// Label
		const labelRow = createStackedRow(contentEl, {
			name: "Label",
			description: "Optional name shown in the rules list",
		});
		const labelInput = labelRow.createEl("input", { type: "text" });
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		labelInput.placeholder = "e.g. client work";
		labelInput.value = this.draft.label ?? "";
		labelInput.addEventListener("input", () => {
			this.draft.label = labelInput.value;
		});

		// Patterns
		const patternsRow = createStackedRow(contentEl, {
			name: "Patterns",
			description:
				"One regex per line. The rule matches if any line matches. Wrap with /pattern/flags to override flags. Default flags: i (case-insensitive).",
		});
		const patternsInput = patternsRow.createEl("textarea");
		patternsInput.rows = 6;
		patternsInput.placeholder = "@example\\.com\nfirstname";
		patternsInput.value = this.draft.pattern;
		patternsInput.addEventListener("input", () => {
			this.draft.pattern = patternsInput.value;
			renderErrors();
		});

		const errorEl = patternsRow.createDiv({ cls: "granola-rule-errors" });
		const renderErrors = () => {
			const { errors } = validateRulePattern(this.draft.pattern);
			if (errors.length === 0) {
				errorEl.setText("");
				errorEl.toggleClass("mod-warning", false);
			} else {
				errorEl.setText(
					errors.map((e) => `Line ${e.line}: ${e.message}`).join("\n"),
				);
				errorEl.toggleClass("mod-warning", true);
			}
		};
		renderErrors();

		const hint = patternsRow.createDiv({ cls: "granola-rule-hint" });
		hint.setText(
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			"Tested against a multi-line haystack with TITLE / ORG / EMAIL / NAME prefixes. Use anchors like ^TITLE: with the m flag to scope to one line.",
		);

		// Destination folder
		const destRow = createStackedRow(contentEl, {
			name: "Destination folder",
			description: "Vault-relative path. The folder is created if it doesn't exist.",
		});
		const destInput = destRow.createEl("input", { type: "text" });
		destInput.placeholder = "e.g. Clients/Acme";
		destInput.value = this.draft.destinationFolder;
		destInput.addEventListener("input", () => {
			this.draft.destinationFolder = destInput.value;
		});

		// Action buttons
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						await this.onSave(this.draft);
						this.close();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
