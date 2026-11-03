import type { FastifyInstance } from "fastify";
import { authorize } from "../lib/access.js";
import { listAiUsage } from "../lib/store.js";

/**
 * Operator views. Every route here is behind `authorize(..., "admin")`,
 * which answers 404 to anyone else, so their existence is not confirmed.
 */
export async function adminRoutes(app: FastifyInstance) {
  /**
   * AI usage over the last N days (default 30): requests, failures, tokens
   * and time, by day and by kind. Counts and sums only -- no prompts, and
   * no per-account breakdown beyond the number of accounts involved.
   */
  app.get("/api/admin/ai-usage", async (request, reply) => {
    if (!authorize(request, reply, "admin")) return;
    const days = Math.min(90, Math.max(1, Number((request.query as { days?: string }).days ?? 30) || 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const usage = await listAiUsage(since);

    const byDay = new Map<string, { requests: number; failed: number; inputTokens: number; outputTokens: number }>();
    const byKind = new Map<string, { requests: number; failed: number; ms: number }>();
    for (const u of usage) {
      const day = u.at.slice(0, 10);
      const d = byDay.get(day) ?? { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
      d.requests += 1;
      d.failed += u.ok ? 0 : 1;
      d.inputTokens += u.inputTokens;
      d.outputTokens += u.outputTokens;
      byDay.set(day, d);
      const k = byKind.get(u.kind) ?? { requests: 0, failed: 0, ms: 0 };
      k.requests += 1;
      k.failed += u.ok ? 0 : 1;
      k.ms += u.ms;
      byKind.set(u.kind, k);
    }
    return {
      days,
      requests: usage.length,
      failed: usage.filter((u) => !u.ok).length,
      accounts: new Set(usage.map((u) => u.accountId)).size,
      inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
      byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, requests: v.requests, failed: v.failed, avgMs: Math.round(v.ms / v.requests) })),
    };
  });
}
