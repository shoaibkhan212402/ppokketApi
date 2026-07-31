// Mirrors loanUtils.js's local-date parsing, needed because the DB pool is
// configured with dateStrings: ['DATE'] + timezone '+05:30' — naive
// `new Date(dateString)` parsing would introduce an off-by-one-day error.
const parseLocalDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const AVG_DAYS_PER_MONTH = 30.4368;

// Simple monthly interest — no plans, no compounding: a flat admin-configured
// monthly rate applied for the user-chosen tenure (in months).
// e.g. 1%/month for 6 months = 6% total, exactly matching principal + principal*0.01*6.
// Locked in once at investment creation time and stored in investments.maturity_amount;
// the maturity cron / withdrawal endpoint always credit this exact value, never a
// recomputed one.
const calculateMaturityAmount = (principal, monthlyRatePct, tenureMonths) => {
  const P = parseFloat(principal);
  const r = parseFloat(monthlyRatePct) / 100;
  return Math.round((P + P * r * tenureMonths) * 100) / 100;
};

// For display only — never persisted, never used to credit money. Recomputed
// on every read. Converges exactly to maturity_amount once the full tenure
// has elapsed.
const calculateCurrentValue = (investment, asOfDate = new Date()) => {
  if (!investment.start_date) return parseFloat(investment.principal_amount); // pending, not yet funded

  const start = parseLocalDate(investment.start_date);
  const elapsedMonths = Math.max(0, (asOfDate - start) / (AVG_DAYS_PER_MONTH * 86400000));
  const effectiveMonths = Math.min(elapsedMonths, investment.tenure_months);

  const P = parseFloat(investment.principal_amount);
  const r = parseFloat(investment.interest_rate) / 100;
  return Math.round((P + P * r * effectiveMonths) * 100) / 100;
};

module.exports = { calculateMaturityAmount, calculateCurrentValue };
