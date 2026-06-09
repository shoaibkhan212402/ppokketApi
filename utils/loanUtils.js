// EMI Calculation: P * r * (1+r)^n / ((1+r)^n - 1)
const calculateEMI = (principal, annualInterestRate, months) => {
  const monthlyRate = annualInterestRate / 100;
  if (monthlyRate === 0) return principal / months;
  const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, months)) /
              (Math.pow(1 + monthlyRate, months) - 1);
  return Math.round(emi * 100) / 100;
};

const generateEMISchedule = (loan) => {
  const { id: loan_id, amount, interest_rate, duration_months, emi_amount } = loan;
  const schedule = [];
  let balance = parseFloat(amount);
  const monthlyRate = parseFloat(interest_rate) / 100;
  let dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + 1);

  for (let i = 1; i <= duration_months; i++) {
    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((emi_amount - interest) * 100) / 100;
    balance = Math.round((balance - principal) * 100) / 100;

    schedule.push({
      installment_no: i,
      due_date: dueDate.toISOString().split('T')[0],
      emi_amount: parseFloat(emi_amount),
      interest,
      principal: i === duration_months ? balance + principal : principal,
    });

    dueDate = new Date(dueDate);
    dueDate.setMonth(dueDate.getMonth() + 1);
  }
  return schedule;
};

module.exports = { calculateEMI, generateEMISchedule };
