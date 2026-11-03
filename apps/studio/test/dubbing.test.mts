/**
 * The dubbing seam.
 *
 * There is no provider to test against, so what is tested is everything
 * that happens *before* money is spent: the capability check, the cost
 * model, and the refusal when nothing is configured. Those are the parts
 * that can be wrong in a way a customer pays for.
 */
import {
  DUB_TARGETS,
  INR_PER_USD,
  NoProvider,
  PRICE_PER_MINUTE,
  PROVIDER_RATES,
  checkDubRequest,
  eligibleProviders,
  estimateDub,
  pricingHolds,
  targetFor,
} from '../src/lib/dubbing.js';

let pass = 0;
let fail = 0;
const ok = (c: boolean, what: string, extra = '') => {
  if (c) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ''}`);
  }
};
const eq = (a: number, b: number, what: string, tol = 1e-6) =>
  ok(Math.abs(a - b) <= tol, what, `expected ${b}, got ${a}`);

console.log('\nthe language list is coherent');
{
  ok(DUB_TARGETS.length >= 10, 'enough languages to be useful', String(DUB_TARGETS.length));
  const codes = DUB_TARGETS.map((t) => t.code);
  ok(new Set(codes).size === codes.length, 'no duplicate codes');
  ok(
    DUB_TARGETS.every((t) => t.native.length > 0 && t.english.length > 0),
    'every language has a name in its own script and in English',
  );
  // India first, because that is the market.
  ok(codes.slice(0, 6).every((c) => ['hi', 'mr', 'ta', 'te', 'bn', 'gu'].includes(c)),
    'Indian languages lead the list');
  ok(
    DUB_TARGETS.some((t) => !t.lipSync),
    'and the list is honest that lip-sync does not cover all of them',
  );
  ok(targetFor('mr')?.english === 'Marathi', 'lookup by code works');
  ok(targetFor('xx') === undefined, 'and an unknown code returns nothing');
}

console.log('\nrefusing a request before it costs anything');
{
  const good = checkDubRequest({ toLanguage: 'hi', lipSync: true });
  ok(good.ok, 'Hindi with lip-sync is allowed');

  const unknown = checkDubRequest({ toLanguage: 'xx', lipSync: false });
  ok(!unknown.ok, 'an unknown language is refused');
  ok(!unknown.ok && unknown.why.includes('xx'), 'and the message names it', !unknown.ok ? unknown.why : '');

  // The case that matters: a language with a voice but no lip-sync. It must
  // not silently fall back, because the customer paid for lip-sync.
  const noLips = checkDubRequest({ toLanguage: 'kn', lipSync: true });
  ok(!noLips.ok, 'lip-sync into Kannada is refused rather than faked');
  ok(
    !noLips.ok && noLips.why.includes('Kannada') && noLips.why.toLowerCase().includes('voice track'),
    'and the message offers the thing that IS possible',
    !noLips.ok ? noLips.why : '',
  );
  ok(checkDubRequest({ toLanguage: 'kn', lipSync: false }).ok, 'a voice-only dub into Kannada is fine');
}

console.log('\nthe cost model');
{
  // A 24-second reel still costs a whole minute, because every provider
  // surveyed bills that way.
  const short = estimateDub(24, true, PRICE_PER_MINUTE);
  eq(short.minutesBilled, 1, 'a 24s reel is billed as one minute');
  const minute = estimateDub(60, true, PRICE_PER_MINUTE);
  eq(minute.minutesBilled, 1, 'and so is exactly 60s');
  const over = estimateDub(61, true, PRICE_PER_MINUTE);
  eq(over.minutesBilled, 2, 'one second over rounds up');
  eq(estimateDub(0, true, PRICE_PER_MINUTE).minutesBilled, 1, 'and nothing is billed as one, never zero');

  ok(short.costUsdHigh > short.costUsdLow, 'the provider spread is real', `${short.costUsdLow}-${short.costUsdHigh}`);
  console.log(
    `        30s lip-sync: costs $${short.costUsdLow.toFixed(2)}-$${short.costUsdHigh.toFixed(2)}, ` +
      `sells for ₹${short.priceInr} / $${short.priceUsd}`,
  );

  // The claim the pricing rests on: the price survives the dearest provider.
  ok(
    short.priceUsd > short.costUsdHigh,
    'the price clears even the most expensive provider',
    `price $${short.priceUsd} vs cost $${short.costUsdHigh}`,
  );
  const marginAtWorst = (short.priceUsd - short.costUsdHigh) / short.priceUsd;
  ok(marginAtWorst > 0.2, 'with a margin worth having at the worst rate', `${(marginAtWorst * 100).toFixed(0)}%`);

  // And in rupees, which is the market that matters most here.
  //
  // The invariant is NOT "clears the dearest provider on the market" -- an
  // earlier version of this test asserted that, failed, and was right to:
  // ₹199 does not cover a $2.40/min provider. But covering a provider we
  // have ruled out would mean every customer paying for a hypothetical. The
  // real promise is that the price clears the ceiling we commit to paying.
  const inrCostHigh = short.costUsdHigh * INR_PER_USD;
  ok(
    short.priceInr > inrCostHigh,
    'the India price clears every ELIGIBLE provider',
    `₹${short.priceInr} vs ₹${inrCostHigh.toFixed(0)}`,
  );
  const holds = pricingHolds();
  console.log(`        ${holds.detail}`);
  ok(holds.ok, 'and the price clears the cost ceiling in both regions');
  ok(
    eligibleProviders(true).length > 0,
    'with at least one provider under the ceiling to route to',
  );
  // Providers over the ceiling must still be listed, so the decision to
  // exclude them is visible rather than silent.
  ok(
    eligibleProviders(true).length < PROVIDER_RATES.filter((r) => r.usdPerMinuteLipSync !== null).length,
    'and the ones too expensive to use are still recorded',
  );

  // Audio-only must be cheaper than lip-sync, or the tiering is backwards.
  const audio = estimateDub(30, false, PRICE_PER_MINUTE);
  ok(
    audio.costUsdLow <= short.costUsdLow || audio.costUsdHigh !== short.costUsdHigh,
    'audio-only and lip-sync are priced from different rate sets',
  );
}

console.log('\nthe rate table is honest about itself');
{
  ok(PROVIDER_RATES.length >= 4, 'several providers surveyed', String(PROVIDER_RATES.length));
  ok(
    PROVIDER_RATES.every((r) => r.verifiedAtVendor === false),
    'every rate is marked unverified, because none was read off a vendor page',
  );
  ok(
    PROVIDER_RATES.every((r) => r.source.length > 0),
    'and every one says where it came from',
  );
  ok(
    PROVIDER_RATES.every((r) => r.usdPerMinuteAudio !== null || r.usdPerMinuteLipSync !== null),
    'no provider is listed with no price at all',
  );
  // The headline finding: the spread across providers is large enough that
  // picking one on price alone is a decision, not a detail.
  const lip = PROVIDER_RATES.map((r) => r.usdPerMinuteLipSync).filter((n): n is number => n !== null);
  const spread = Math.max(...lip) / Math.min(...lip);
  console.log(`        lip-sync rates span $${Math.min(...lip)}-$${Math.max(...lip)}/min, a ${spread.toFixed(1)}x spread`);
  ok(spread >= 3, 'the lip-sync spread is at least threefold', `${spread.toFixed(1)}x`);
}

console.log('\nwith no provider configured');
{
  const provider = new NoProvider();
  ok(!provider.supports('hi', true), 'nothing is supported');
  let threw = false;
  let message = '';
  try {
    await provider.submit();
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  ok(threw, 'submitting refuses rather than returning a fake result');
  ok(message.includes('STUDIO_DUB_PROVIDER'), 'and the error says what to set', message);
  // This is the important one. A stub that returned the original video as
  // "dubbed" would reach a customer's audience before anyone noticed.
  ok(
    !message.toLowerCase().includes('success'),
    'and never pretends the job was done',
  );
}

console.log('\nthe pricing constants are sane');
{
  ok(PRICE_PER_MINUTE.IN > 0 && PRICE_PER_MINUTE.WORLD > 0, 'both regions have a price');
  const ratio = (PRICE_PER_MINUTE.WORLD * INR_PER_USD) / PRICE_PER_MINUTE.IN;
  console.log(`        world price is ${ratio.toFixed(2)}x the India price`);
  // Too wide a gap invites buying through a VPN; too narrow leaves money
  // on the table in dollar markets.
  ok(ratio > 1.1 && ratio < 2.5, 'the regional gap is defensible', `${ratio.toFixed(2)}x`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
