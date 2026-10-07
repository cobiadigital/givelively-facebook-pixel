import { describe, expect, it } from "vitest";
import { authorized, handleRequest } from "../src/admin";
import type { Env } from "../src/config";

const req = (path: string, token?: string, method = "GET") =>
  new Request(`https://worker.example${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("admin auth", () => {
  it("accepts only the exact bearer token", async () => {
    expect(await authorized(req("/status", "s3cret"), "s3cret")).toBe(true);
    expect(await authorized(req("/status", "s3cre"), "s3cret")).toBe(false);
    expect(await authorized(req("/status"), "s3cret")).toBe(false);
    expect(await authorized(req("/status", "anything"), "")).toBe(false);
  });

  it("returns 401 without a token and 503 when ADMIN_TOKEN is unset", async () => {
    const env = { ADMIN_TOKEN: "s3cret" } as unknown as Env;
    expect((await handleRequest(req("/status"), env)).status).toBe(401);
    expect((await handleRequest(req("/sample", "wrong"), env)).status).toBe(401);
    expect((await handleRequest(req("/status"), {} as Env)).status).toBe(503);
  });

  it("serves the console page without auth and 404s unknown paths", async () => {
    const env = {} as Env;
    const page = await handleRequest(req("/"), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Admin token");
    expect((await handleRequest(req("/nope"), env)).status).toBe(404);
  });
});
