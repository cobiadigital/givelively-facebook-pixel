import { handleRequest, log } from "./admin";
import { loadConfig, type Env } from "./config";
import { D1Store } from "./db";
import { runPoll } from "./poll";

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runPoll(
        loadConfig(env),
        { store: new D1Store(env.DB), fetch: (...a) => fetch(...a), now: Date.now, log },
        { trigger: "cron", dryRun: false },
      ).then(() => undefined),
    );
  },

  async fetch(req, env) {
    try {
      return await handleRequest(req, env);
    } catch (e) {
      log("request_error", { name: e instanceof Error ? e.name : typeof e });
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
