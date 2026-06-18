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
 * @param {string} firstEmiDate  YYYY-MM-DD or null
 * @param {object} settings system_settings row
 *
 * Returned rows: { installment_no, due_date, emi_amount, principal_amount, interest_amount, first_emi_charges, balance_after }
 */
const parseLocalDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const formatLocalDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const addMonthsLocal = (baseDate, monthsToAdd) => {
  return new Date(baseDate.getFullYear(), baseDate.getMonth() + monthsToAdd, baseDate.getDate());
};

const generateEMISchedule = (loan, firstEmiDate = null, settings = {}) => {
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
  
  let dueDate;
  if (firstEmiDate) {
    dueDate = parseLocalDate(firstEmiDate);
  } else {
    const today = new Date();
    dueDate = new Date(today.getFullYear(), today.getMonth() + 1, 3);
  }

  // ── Mode B: step-down first EMI ────────────────────────────────────────────
  if (firstEmiPct > 0 && months > 1) {
    const firstPrincipal = Math.round(principal * firstEmiPct / 100 * 100) / 100;
    const firstInterest  = Math.round(balance * monthlyRate * 100) / 100;
    const firstEmiTotal  = Math.round((firstPrincipal + firstInterest + feeCharges) * 100) / 100;
    balance              = Math.round((balance - firstPrincipal) * 100) / 100;

    schedule.push({
      installment_no:    1,
      due_date:          formatLocalDate(dueDate),
      emi_amount:        firstEmiTotal,
      principal_amount:  firstPrincipal,
      interest_amount:   firstInterest,
      first_emi_charges: feeCharges,
      balance_after:     balance,
    });

    // Remaining EMIs on reduced balance
    const remMonths = months - 1;
    const remEMI    = calculateEMI(balance, parseFloat(loan.interest_rate), remMonths);
    let   remBal    = balance;

    for (let i = 2; i <= months; i++) {
      const next = addMonthsLocal(dueDate, i - 1);
      const interest  = Math.round(remBal * monthlyRate * 100) / 100;
      let   principal_i = Math.round((remEMI - interest) * 100) / 100;
      if (i === months) principal_i = remBal; // clear remaining on last
      remBal = Math.round((remBal - principal_i) * 100) / 100;

      schedule.push({
        installment_no:    i,
        due_date:          formatLocalDate(next),
        emi_amount:        i === months ? Math.round((principal_i + interest) * 100) / 100 : remEMI,
        principal_amount:  principal_i,
        interest_amount:   interest,
        first_emi_charges: 0,
        balance_after:     remBal < 0.01 ? 0 : remBal,
      });
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
    const charges   = i === 1 ? feeCharges : 0;
    const totalAmt  = Math.round((emiAmt + charges) * 100) / 100;

    schedule.push({
      installment_no:    i,
      due_date:          formatLocalDate(dueDate),
      emi_amount:        i === months ? Math.round((prin + interest) * 100) / 100 : totalAmt,
      principal_amount:  prin,
      interest_amount:   interest,
      first_emi_charges: charges,
      balance_after:     balance < 0.01 ? 0 : balance,
    });

    dueDate = addMonthsLocal(dueDate, 1);
  }
  return schedule;
};

/**
 * Calculate penalty for an overdue EMI.
 */
const calculatePenalty = (emi, settings = {}) => {
  if (emi.penalty_waived) return { penalty: 0, days: 0, gst: 0, total: 0 };

  const graceDays   = parseInt(settings.penalty_grace_days || 3);
  const rawDays     = Math.floor((new Date() - new Date(emi.due_date)) / 86400000);
  const chargedDays = Math.max(0, rawDays - graceDays);

  if (chargedDays === 0) return { penalty: 0, days: 0, gst: 0, total: 0 };

  const emiAmt     = parseFloat(emi.emi_amount);
  const maxPenalty = Math.round(emiAmt * (parseFloat(settings.penalty_max_pct_of_emi || 50)) / 100 * 100) / 100;

  const rawPenalty = settings.penalty_type === 'flat'
    ? parseFloat(settings.penalty_flat_per_day || 50) * chargedDays
    : (parseFloat(settings.penalty_rate_per_day || 1) / 100) * emiAmt * chargedDays;

  const penalty = Math.min(Math.round(rawPenalty * 100) / 100, maxPenalty);
  const gst     = Math.round(penalty * (parseFloat(settings.gst_on_penalty || 18)) / 100 * 100) / 100;

  return { penalty, days: chargedDays, gst, total: Math.round((penalty + gst) * 100) / 100 };
};

module.exports = { calculateEMI, generateEMISchedule, calculatePenalty };
