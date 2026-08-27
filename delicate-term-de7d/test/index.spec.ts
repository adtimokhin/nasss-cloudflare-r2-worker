import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("NASSS API", () => {
	it("GET /health returns ok (unit style)", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ok: true });
	});

	it("GET /health returns ok (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/health");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ok: true });
	});

	it("GET /issues/:slug/pdf without token returns 401", async () => {
		const response = await SELF.fetch("https://example.com/issues/test-slug/pdf");
		expect(response.status).toBe(401);
	});
});
