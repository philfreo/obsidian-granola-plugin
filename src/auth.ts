import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientMetadata,
	OAuthClientInformationMixed,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface AuthStorage {
	getTokens(): OAuthTokens | undefined;
	saveTokens(tokens: OAuthTokens): Promise<void>;
	clearTokens(): Promise<void>;
	getClientInfo(): OAuthClientInformationMixed | undefined;
	saveClientInfo(info: OAuthClientInformationMixed): Promise<void>;
}

export class GranolaAuthProvider implements OAuthClientProvider {
	private _codeVerifier = "";

	constructor(private storage: AuthStorage) {}

	get redirectUrl(): string {
		return "obsidian://granola-auth";
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Obsidian Granola Sync",
			redirect_uris: ["obsidian://granola-auth"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		return this.storage.getTokens();
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.storage.saveTokens(tokens);
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return this.storage.getClientInfo();
	}

	async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
		await this.storage.saveClientInfo(info);
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		window.open(url.toString());
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
		this._codeVerifier = verifier;
	}

	async codeVerifier(): Promise<string> {
		return this._codeVerifier;
	}
}
