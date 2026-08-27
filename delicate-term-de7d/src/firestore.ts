import { SignJWT, importPKCS8 } from 'jose';
import type { Env } from './types';

// -----------------------------------------------------------------------------
// Firestore REST client for Cloudflare Workers.
//
// There is no Firebase Admin SDK that runs on Workers (it needs Node gRPC), so
// we talk to the Firestore REST API directly and authenticate with a Google
// service account: sign a short-lived JWT with the service-account private key,
// exchange it for an OAuth2 access token, and send that as a bearer token.
// -----------------------------------------------------------------------------

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

// Access tokens live ~1h. Workers have no persistent state, so this module-level
// cache is best-effort — it survives while the isolate is warm and is re-minted
// after a recycle. One service account, so a single shared slot is fine.
let cachedToken: { value: string; expiresAt: number } | null = null;

// A filter is always an equality check: [fieldPath, value]. Equality-only
// queries with no server-side ordering need no composite index in Firestore.
export type Filter = [string, unknown];

export class Firestore {
	constructor(private readonly env: Env) {}

	private get base(): string {
		return `https://firestore.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
	}

	private async accessToken(): Promise<string> {
		const now = Date.now();
		if (cachedToken && cachedToken.expiresAt > now + 60_000) {
			return cachedToken.value;
		}

		const pem = this.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
		const key = await importPKCS8(pem, 'RS256');
		const iat = Math.floor(now / 1000);

		const assertion = await new SignJWT({ scope: DATASTORE_SCOPE })
			.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
			.setIssuer(this.env.FIREBASE_CLIENT_EMAIL)
			.setSubject(this.env.FIREBASE_CLIENT_EMAIL)
			.setAudience(TOKEN_ENDPOINT)
			.setIssuedAt(iat)
			.setExpirationTime(iat + 3600)
			.sign(key);

		const res = await fetch(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion,
			}),
		});

		if (!res.ok) {
			throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
		}

		const json = (await res.json()) as { access_token: string; expires_in: number };
		cachedToken = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
		return json.access_token;
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const token = await this.accessToken();
		const url = path.startsWith(':') ? `${this.base}${path}` : `${this.base}/${path}`;
		return fetch(url, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				...(init.headers ?? {}),
			},
		});
	}

	/** GET a single document by path, e.g. `members/<uid>`. Returns null on 404. */
	async getDoc(path: string): Promise<FirestoreDoc | null> {
		const res = await this.request(path);
		if (res.status === 404) return null;
		if (!res.ok) {
			throw new Error(`Firestore GET ${path} failed: ${res.status} ${await res.text()}`);
		}
		return mapDocument(await res.json());
	}

	/** Run an equality query and return every matching document. */
	async queryAll(collectionId: string, filters: Filter[], limit?: number): Promise<FirestoreDoc[]> {
		const structuredQuery: Record<string, unknown> = { from: [{ collectionId }] };
		if (filters.length) structuredQuery.where = buildWhere(filters);
		if (limit) structuredQuery.limit = limit;

		const res = await this.request(':runQuery', {
			method: 'POST',
			body: JSON.stringify({ structuredQuery }),
		});
		if (!res.ok) {
			throw new Error(`Firestore query on ${collectionId} failed: ${res.status} ${await res.text()}`);
		}

		const rows = (await res.json()) as Array<{ document?: unknown }>;
		return rows.filter((r) => r.document).map((r) => mapDocument(r.document));
	}

	/** Run an equality query and return the first match, or null. */
	async queryFirst(collectionId: string, filters: Filter[]): Promise<FirestoreDoc | null> {
		const rows = await this.queryAll(collectionId, filters, 1);
		return rows[0] ?? null;
	}

	/** PATCH the given fields on a document, e.g. `issues/<id>`. */
	async patchDoc(path: string, fields: Record<string, unknown>): Promise<void> {
		const mask = Object.keys(fields)
			.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
			.join('&');
		const res = await this.request(`${path}?${mask}`, {
			method: 'PATCH',
			body: JSON.stringify({ fields: toFields(fields) }),
		});
		if (!res.ok) {
			throw new Error(`Firestore PATCH ${path} failed: ${res.status} ${await res.text()}`);
		}
	}
}

export function getFirestore(env: Env): Firestore {
	return new Firestore(env);
}

// -----------------------------------------------------------------------------
// Value / document mapping between Firestore's typed JSON and plain objects.
// -----------------------------------------------------------------------------

// Plain object plus the document id/name, kept under `_id` / `_name` to avoid
// colliding with a real `id` field on the document.
export type FirestoreDoc = Record<string, any> & { _id: string; _name: string };

function mapDocument(doc: any): FirestoreDoc {
	const name: string = doc?.name ?? '';
	const _id = name.slice(name.lastIndexOf('/') + 1);
	return { _id, _name: name, ...fromFields(doc?.fields ?? {}) };
}

function fromFields(fields: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
	return out;
}

function fromValue(v: any): any {
	if (v == null || 'nullValue' in v) return null;
	if ('booleanValue' in v) return v.booleanValue;
	if ('stringValue' in v) return v.stringValue;
	if ('integerValue' in v) return Number(v.integerValue);
	if ('doubleValue' in v) return v.doubleValue;
	if ('timestampValue' in v) return v.timestampValue;
	if ('bytesValue' in v) return v.bytesValue;
	if ('referenceValue' in v) return v.referenceValue;
	if ('geoPointValue' in v) return v.geoPointValue;
	if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromValue);
	if ('mapValue' in v) return fromFields(v.mapValue.fields ?? {});
	return null;
}

function toFields(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) out[k] = toValue(v);
	return out;
}

function toValue(v: unknown): Record<string, unknown> {
	if (v === null || v === undefined) return { nullValue: null };
	switch (typeof v) {
		case 'boolean':
			return { booleanValue: v };
		case 'string':
			return { stringValue: v };
		case 'number':
			return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
		default:
			if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
			return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
	}
}

function buildWhere(filters: Filter[]): Record<string, unknown> {
	const fieldFilters = filters.map(([field, value]) => ({
		fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) },
	}));
	return fieldFilters.length === 1
		? fieldFilters[0]
		: { compositeFilter: { op: 'AND', filters: fieldFilters } };
}
