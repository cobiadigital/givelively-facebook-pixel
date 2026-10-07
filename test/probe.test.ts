import { describe, expect, it } from "vitest";
import { WORKER_UA, runProbe } from "../src/probe";

const cfg = { glOrgId: "org-test", glApiKey: "SECRETKEY123" };

function fake(handler: (url: string, headers: Record<string, string>) => Response) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    if (url.includes("cdn-cgi/trace")) return new Response("ip=203.0.113.7\ncolo=ATL\nloc=US\n");
    return handler(url, headers);
  }) as typeof fetch;
  return { fn, seen };
}

const datadome = () =>
  Response.json(
    { url: "https://geo.captcha-delivery.com/captcha/?initialCid=abc" },
    { status: 403, headers: { "x-datadome": "protected", server: "CloudFront" } },
  );

describe("runProbe", () => {
  it("reports a DataDome block without leaking the key", async () => {
    const f = fake(() => datadome());
    const r = await runProbe(cfg, "worker", f.fn);
    expect(r.verdict).toBe("JSON feed: blocked by DataDome bot protection.");
    expect(r.probes.every((p) => p.status === 403 && p.datadome)).toBe(true);
    expect(r.probes[1]!.body).toBe("DataDome CAPTCHA challenge (no Give Lively response)");
    expect(r.worker_egress).toEqual({ ip: "203.0.113.7", colo: "ATL", loc: "US" });
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRETKEY123");
    expect(text).not.toContain("org-test");
  });

  it("describes the feed without returning its records", async () => {
    const f = fake((url) =>
      url.includes("/validate/")
        ? Response.json({ success: true })
        : url.endsWith("/")
          ? new Response("<html>ok</html>")
          : Response.json([{ email: "jane@example.com" }, { email: "john@example.com" }]),
    );
    const r = await runProbe(cfg, "worker", f.fn);
    expect(r.verdict).toMatch(/^JSON feed: not blocked/);
    expect(r.probes[1]!.body).toBe('{"success":true}');
    expect(r.probes[2]!.body).toBe("JSON array with 2 record(s) from the last hour");
    expect(JSON.stringify(r)).not.toContain("example.com");
  });

  it("recognizes a wrong key", async () => {
    const f = fake((url) => (url.endsWith("/") ? new Response("ok") : new Response("Not Found", { status: 404 })));
    expect((await runProbe(cfg, "worker", f.fn)).verdict).toMatch(/wrong \(404\)/);
  });

  it("sends the Worker User-Agent, or none", async () => {
    const a = fake(() => datadome());
    await runProbe(cfg, "worker", a.fn);
    expect(a.seen[0]!.headers["user-agent"]).toBe(WORKER_UA);
    const b = fake(() => datadome());
    await runProbe(cfg, "none", b.fn);
    expect(b.seen[0]!.headers["user-agent"]).toBeUndefined();
  });

  it("redacts the key from error bodies and network errors", async () => {
    const f = fake((url) => {
      if (url.includes("/validate/")) throw new TypeError(`failed ${url}`);
      return new Response(`bad key SECRETKEY123`, { status: 500 });
    });
    const r = await runProbe(cfg, "worker", f.fn);
    expect(JSON.stringify(r)).not.toContain("SECRETKEY123");
    expect(r.probes[1]!.error).toContain("[redacted]");
  });
});

describe("runProbe with a CSV link", () => {
  it("reports rows and columns but not the link or data", async () => {
    const csvUrl = "https://secure.givelively.org/x/dataclips/SECRET-CSV-ID.csv";
    const f = fake((url) =>
      url.endsWith(".csv")
        ? new Response('"First Name","Email"\r\n"Jane","jane@example.com"\r\n', { headers: { "content-type": "text/csv" } })
        : new Response("<html></html>"),
    );
    const r = await runProbe({ glOrgId: "", glApiKey: "", csvUrl }, "worker", f.fn);
    expect(r.verdict).toBe("CSV link: works.");
    expect(r.probes.map((p) => p.name)).toEqual(["home page (no key)", "CSV link (GL_CSV_URL)"]);
    expect(r.probes[1]!.body).toBe('CSV with about 1 row(s). Columns: "First Name","Email"');
    expect(JSON.stringify(r)).not.toMatch(/SECRET-CSV-ID|jane@example/);
  });
});
