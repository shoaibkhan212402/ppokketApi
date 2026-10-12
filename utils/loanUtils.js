const { emiCharges } = require('./loanCharges');

// ── EMI due dates ────────────────────────────────────────────────────────────
// Dates here are plain 'YYYY-MM-DD' text, and "today" is today in India —
// whatever time zone the server itself runs in.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
// The India date at a moment given in epoch seconds (e.g. UNIX_TIMESTAMP(approved_at))
const istDateOf = (epochSeconds) => new Date(Number(epochSeconds) * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
// Whole days from one 'YYYY-MM-DD' to another (negative when `to` is earlier)
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const pad2 = (n) => String(n).padStart(2, '0');

// A numeric system setting. The fallback is for a setting that was never
// saved (or is unreadable) — a saved 0 stays 0.
const settingNumber = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const isDateText = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// `months` later on the same day of the month — or on that month's last day
// when it has no such day (31 Jan → 28 Feb → 31 Mar).
const addMonths = (dateText, months) => {
  const [y, m, d] = dateText.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(Math.min(d, lastDay))}`;
};

// How a loan's due dates are chosen when the admin picks no date at approval
// (Admin → Settings → EMI due date):
//   'fixed_day'  the same day of every month (emi_due_day, 1–28)
//   'loan_date'  the day of the month the loan was approved on
// Either way the first EMI is in the month after the loan. With nothing saved
// it is the 3rd, as it always was.
const emiDueRule = (settings = {}) => {
  const day = parseInt(settings.emi_due_day, 10);
  return {
    mode: settings.emi_due_mode === 'loan_date' ? 'loan_date' : 'fixed_day',
    day: day >= 1 && day <= 28 ? day : 3,
  };
};

// The first due date of a loan approved on `loanDate` (default: today).
const defaultFirstEmiDate = (settings = {}, loanDate = istToday()) => {
  const { mode, day } = emiDueRule(settings);
  const nextMonth = addMonths(loanDate, 1);
  return mode === 'loan_date' ? nextMonth : `${nextMonth.slice(0, 8)}${pad2(day)}`;
};

// Standard reducing-balance EMI formula
const calculateEMI = (principal, monthlyRate, months) => {
  const r = monthlyRate / 100;
  if (r === 0) return Math.round((principal / months) * 100) / 100;
  const emi = (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  return Math.round(emi * 100) / 100;
};

/**
 * Generate full EMI schedule with optional step-down first EMI.
 *
 * Two modes:
 *
 * A) first_emi_principal_pct = 0  (standard)
 *    All EMIs are equal reducing-balance. Processing fee added to EMI #1 if configured.
 *
 * B) first_emi_principal_pct > 0  (step-down, e.g. 40%)
 *    EMI #1 = (pct × principal) + interest on full principal + processing fee + GST
 *    EMI #2…n = equal reducing-balance on remaining principal for (months - 1) months
 *    This gives a big first payment then lower equal instalments.
 *
 * @param {object} loan     { amount, interest_rate, duration_months, emi_amount, processing_fee }
 * @param {string} firstEmiDate  YYYY-MM-DD, or null for the default (defaultFirstEmiDate)
 * @param {object} settings system_settings row
 * @param {Array}  charges  the loan's admin-defined charges (utils/loanCharges.js);
 *                          the 'emi' ones are added to every instalment
 *
 * Returned rows: { installment_no, due_date, emi_amount, principal_amount, interest_amount, first_emi_charges, emi_charges, emi_charge_items, balance_after }
 * emi_amount is what the customer pays for that instalment, everything included.
 */
const generateEMISchedule = (loan, firstEmiDate = null, settings = {}, charges = []) => {
  // Admin-defined per-EMI charges, priced on an instalment's principal + interest.
  const withCharges = (row) => {
    const extra = emiCharges(charges, row.principal_amount + row.interest_amount);
    return {
      ...row,
      emi_amount: Math.round((row.emi_amount + extra.total) * 100) / 100,
      emi_charges: extra.total,
      emi_charge_items: extra.items,
    };
  };

  const principal   = parseFloat(loan.amount);
  const monthlyRate = parseFloat(loan.interest_rate) / 100;
  const months      = parseInt(loan.duration_months);
  const procFee     = parseFloat(loan.processing_fee || 0);
  const firstEmiPct = parseFloat(settings.first_emi_principal_pct || 0);

  // ── One-time fee charges for EMI #1 ───────────────────────────────────────
  let feeCharges = 0;
  if (settings.processing_fee_in_first_emi && procFee > 0) {
    const gstPct = parseFloat(settings.gst_on_processing_fee || 0);
    feeCharges   = Math.round(procFee * (1 + gstPct / 100) * 100) / 100;
  }

  const schedule  = [];
  let balance     = principal;
  
  // Instalment i is due i - 1 months after the first one
  const firstDue = isDateText(firstEmiDate) ? firstEmiDate : defaultFirstEmiDate(settings);
  const dueOn = (i) => addMonths(firstDue, i - 1);

  // ── Mode B: step-down first EMI ────────────────────────────────────────────
  if (firstEmiPct > 0 && months > 1) {
    const firstPrincipal = Math.round(principal * firstEmiPct / 100 * 100) / 100;
    const firstInterest  = Math.round(balance * monthlyRate * 100) / 100;
    const firstEmiTotal  = Math.round((firstPrincipal + firstInterest + feeCharges) * 100) / 100;
    balance              = Math.round((balance - firstPrincipal) * 100) / 100;

    schedule.push(withCharges({
      installment_no:    1,
      due_date:          dueOn(1),
      emi_amount:        firstEmiTotal,
      principal_amount:  firstPrincipal,
      interest_amount:   firstInterest,
      first_emi_charges: feeCharges,
      balance_after:     balance,
    }));

    // Remaining EMIs on reduced balance
    const remMonths = months - 1;
    const remEMI    = calculateEMI(balance, parseFloat(loan.interest_rate), remMonths);
    let   remBal    = balance;

    for (let i = 2; i <= months; i++) {
      const interest  = Math.round(remBal * monthlyRate * 100) / 100;
      let   principal_i = Math.round((remEMI - interest) * 100) / 100;
      if (i === months) principal_i = remBal; // clear remaining on last
      remBal = Math.round((remBal - principal_i) * 100) / 100;

      schedule.push(withCharges({
        installment_no:    i,
        due_date:          dueOn(i),
        emi_amount:        i === months ? Math.round((principal_i + interest) * 100) / 100 : remEMI,
        principal_amount:  principal_i,
        interest_amount:   interest,
        first_emi_charges: 0,
        balance_after:     remBal < 0.01 ? 0 : remBal,
      }));
    }
    return schedule;
  }

  // ── Mode A: standard equal EMIs ────────────────────────────────────────────
  const emiAmt = parseFloat(loan.emi_amount) || calculateEMI(principal, parseFloat(loan.interest_rate), months);

  for (let i = 1; i <= months; i++) {
    const interest  = Math.round(balance * monthlyRate * 100) / 100;
    let   prin      = Math.round((emiAmt - interest) * 100) / 100;
    if (i === months) prin = balance;
    balance         = Math.round((balance - prin) * 100) / 100;
    const feeInThisEmi = i === 1 ? feeCharges : 0;
    const totalAmt  = Math.round((emiAmt + feeInThisEmi) * 100) / 100;

    schedule.push(withCharges({
      installment_no:    i,
      due_date:          dueOn(i),
      emi_amount:        i === months ? Math.round((prin + interest) * 100) / 100 : totalAmt,
      principal_amount:  prin,
      interest_amount:   interest,
      first_emi_charges: feeInThisEmi,
      balance_after:     balance < 0.01 ? 0 : balance,
    }));
  }
  return schedule;
};

/**
 * The late penalty on one overdue instalment as of `today` ('YYYY-MM-DD', India).
 * This is what the nightly job writes to emi_schedule.penalty_amount, i.e.
 * what the customer is asked to pay on top of the EMI.
 *
 * The rules are the ones in Admin → Settings → Late payment:
 *   - nothing for the first `penalty_grace_days` days after the due date
 *   - then a charge for every further day: a percentage of the instalment
 *     (the rate the loan was approved with, emi.penalty_rate) or, with
 *     penalty_type 'flat', a fixed amount
 *   - never more than `penalty_max_pct_of_emi` % of the instalment
 * A setting that was never saved means 3 days' grace, 1% a day, at most 50%.
 * No GST is added to a penalty.
 *
 * @param {object} emi  { due_date, emi_amount, penalty_waived, penalty_rate }
 * @returns {{ penalty: number, overdueDays: number, chargedDays: number }}
 */
const calculatePenalty = (emi, settings = {}, today = istToday()) => {
  const overdueDays = Math.max(0, daysBetween(String(emi.due_date).slice(0, 10), today));
  if (emi.penalty_waived) return { penalty: 0, overdueDays, chargedDays: 0 };

  const graceDays   = Math.max(0, Math.floor(settingNumber(settings.penalty_grace_days, 3)));
  const chargedDays = Math.max(0, overdueDays - graceDays);
  const emiAmt      = parseFloat(emi.emi_amount) || 0;

  const perDay = settings.penalty_type === 'flat'
    ? settingNumber(settings.penalty_flat_per_day, 50)
    : (parseFloat(emi.penalty_rate) || settingNumber(settings.penalty_rate_per_day, 1)) / 100 * emiAmt;
  const maxPenalty = emiAmt * settingNumber(settings.penalty_max_pct_of_emi, 50) / 100;

  const penalty = Math.round(Math.min(perDay * chargedDays, maxPenalty) * 100) / 100;
  return { penalty: Math.max(0, penalty), overdueDays, chargedDays };
};

module.exports = {
  calculateEMI, generateEMISchedule, calculatePenalty,
  emiDueRule, defaultFirstEmiDate, addMonths, istToday, istDateOf, daysBetween, settingNumber,
};
