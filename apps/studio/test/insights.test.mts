/**
 * The Insights report against a history whose answers are known.
 *
 * Twelve posts over six weeks: four about "chai" that open with a question
 * and get three times the views, eight ordinary ones. A report that does
 * not find "chai" and the question opener, or that finds a pattern in two
 * posts, is wrong.
 */
import {
  MIN_GROUP,
  buildReport,
  engagementOf,
  hashtagsOf,
  hookOf,
  keywordsOf,
  median,
  type SocialPost,
} from "../src/lib/insights.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, what: string, extra = ""): void => {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ""}`);
  }
};
const eq = <T,>(a: T, b: T, what: string) => ok(a === b, what, `expected ${String(b)}, got ${String(a)}`);

const NOW = new Date("2026-11-03T12:00:00.000Z");
const daysAgo = (n: number, hour = 12) => new Date(NOW.getTime() - n * 86_400_000 + (hour - 12) * 3_600_000).toISOString();

const post = (i: number, over: Partial<SocialPost>): SocialPost => ({
  platform: "instagram",
  id: "p" + i,
  publishedAt: daysAgo(i * 3),
  caption: "A day in the city. Morning walk and work.",
  url: null,
  thumbnail: null,
  format: "reel",
  durationSec: 20,
  views: 1000,
  reach: null,
  likes: 50,
  comments: 5,
  shares: 3,
  saves: 2,
  ...over,
});

const history: SocialPost[] = [];
for (let i = 0; i < 12; i += 1) {
  const chai = i % 3 === 0;
  history.push(
    post(i, chai
      ? { caption: "Why does every corner have a chai stall? #chai #mumbai", views: 3000 + i * 10, durationSec: 25 }
      : { views: 1000 + i * 10, durationSec: i % 2 === 0 ? 45 : 12 }),
  );
}

console.log("\nhelpers");
eq(median([3, 1, 2]), 2, "median of an odd list");
eq(median([4, 1, 2, 3]), 2.5, "median of an even list");
eq(median([]), null, "median of nothing is nothing");
eq(engagementOf(post(0, { views: 1000, likes: 50, comments: 5, shares: 3, saves: 2 })), 0.06, "engagement is interactions over views");
eq(engagementOf(post(0, { views: null, reach: 500, likes: 50, comments: 0, shares: null, saves: null })), 0.1, "or over reach when views are not reported");
eq(engagementOf(post(0, { views: null, reach: null })), null, "and unknown without either");
ok(JSON.stringify(hashtagsOf("Hi #Chai and #chai #मुंबई")) === JSON.stringify(["#chai", "#मुंबई"]), "hashtags are lower-cased, deduplicated and keep Indian scripts");
ok(!keywordsOf("Follow for more #chai @riya").includes("follow"), "call-to-action words are not topics");
ok(!keywordsOf("Follow for more #chai @riya").includes("chai"), "hashtags and handles are not counted twice as words");
eq(hookOf("Why chai?\nBecause."), "Why chai?", "the hook is the first line");
eq(hookOf("मुंबई जागती है। फिर चाय।"), "मुंबई जागती है।", "a danda ends a Hindi hook");

console.log("\nthe report");
const r = buildReport(history, { now: NOW });
eq(r.posts, 12, "every post in the window is counted");
eq(r.medianViews, 1090,"the median is the creator's usual, not the mean the outliers would drag");
ok(r.top[0]!.hook.startsWith("Why does every corner"), "the top post is a chai post", r.top[0]!.hook);
ok((r.top[0]!.index ?? 0) > 2.5, "and is shown against their usual", String(r.top[0]!.index));
const chai = r.topics.find((t) => t.label === "#chai");
ok(chai !== undefined && chai.lift > 2.5, "#chai is found as a topic that lifts views", JSON.stringify(chai));
eq(chai?.posts, 4, "on the four posts that carry it");
ok(r.topics.every((t) => t.posts >= MIN_GROUP), "no topic is reported on fewer than " + MIN_GROUP + " posts");
const question = r.hooks.find((h) => h.label === "Opens with a question");
ok(question !== undefined && question.lift > 2.5, "opening with a question is found to work", JSON.stringify(question));
ok(r.findings.some((f) => f.kind === "topic" && f.text.includes("#chai")), "and the findings say so in words");
ok(r.findings.every((f) => f.evidence.length > 0), "every finding carries its evidence");
ok(r.lengths.length >= 2, "lengths are compared when there are posts at several lengths");
eq(r.postsPerWeek, 2.5, "ten posts in 28 days is 2.5 a week");
ok(r.weekly.length >= 5, "weekly totals cover the history", String(r.weekly.length));
ok(r.weekly.every((w, i, all) => i === 0 || all[i - 1]!.weekStart < w.weekStart), "oldest week first");

console.log("\nthin and empty data");
const thin = buildReport(history.slice(0, 2), { now: NOW });
eq(thin.topics.length, 0, "two posts support no topic");
eq(thin.hooks.length, 0, "and no hook pattern");
eq(thin.trend, null, "and no trend");
const empty = buildReport([], { now: NOW });
eq(empty.posts, 0, "no posts is a report of no posts");
eq(empty.medianViews, null, "with no median rather than zero");
ok(empty.findings.length === 1 && empty.findings[0]!.kind === "cadence", "and only the cadence finding");
const old = buildReport([post(1, { publishedAt: daysAgo(200) })], { now: NOW });
eq(old.posts, 0, "posts outside the window are left out");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
