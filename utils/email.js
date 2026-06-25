const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { generateEMISchedule } = require('./loanUtils');

// Helper to format currency
const formatINR = (n) => `INR ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Helper to format date in ordinal format, e.g. 15th Jun, 2026
const getOrdinalDate = (dateVal) => {
  if (!dateVal) return '—';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);

  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();

  let suffix = 'th';
  if (day === 1 || day === 21 || day === 31) suffix = 'st';
  else if (day === 2 || day === 22) suffix = 'nd';
  else if (day === 3 || day === 23) suffix = 'rd';

  return `${day}${suffix} ${month}, ${year}`;
};

// Create a nodemailer transporter
const getTransporter = async () => {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const isConfigured = user && !user.includes('placeholder') && pass && !pass.includes('placeholder');

  if (isConfigured) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  } else {
    // Generate test SMTP service from ethereal.email
    console.log('✉️ No SMTP configured. Creating Ethereal test email account...');
    try {
      const testAccount = await nodemailer.createTestAccount();
      return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
    } catch (err) {
      console.warn('⚠️ Ethereal account creation failed, logging email details instead.', err.message);
      return null;
    }
  }
};

/**
 * Generates a loan agreement PDF and sends it via email to the user
 */
const sendLoanAgreementEmail = async ({ user, loan, bank }) => {
  try {
    const emailRecipient = user.email || 'customer@ppokket.com';
    console.log(` Generating Loan Agreement PDF for ${user.full_name} (${emailRecipient})...`);

    // Load system settings
    const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const r of settingsRows) {
      const v = r.setting_value;
      settings[r.setting_key] = v === 'true' ? true : v === 'false' ? false : (!isNaN(v) && v !== '') ? Number(v) : v;
    }

    // Generate dynamic schedule rows
    const scheduleRows = generateEMISchedule(
      {
        amount: loan.amount,
        interest_rate: loan.interest_rate,
        duration_months: loan.duration_months,
        emi_amount: loan.emi_amount,
        processing_fee: loan.processing_fee
      },
      null,
      settings
    );

    // Calculations
    const principal = parseFloat(loan.amount);
    const term = parseInt(loan.duration_months);
    const totalRepayable = scheduleRows.reduce((sum, r) => sum + parseFloat(r.emi_amount), 0);
    const interestAmount = totalRepayable - principal;
    const annualizedROI = (parseFloat(loan.interest_rate) * 12).toFixed(1);
    const effectiveROI = ((interestAmount / principal) * (12 / term) * 100).toFixed(2);
    const netDisbursal = principal - parseFloat(loan.processing_fee || 0);
    const apr = ((totalRepayable - netDisbursal) / netDisbursal * (12 / term) * 100).toFixed(1);

    const agreementDate = getOrdinalDate(loan.agreement_accepted_at || new Date());
    const borrowerName = user.full_name.toUpperCase();
    const borrowerAddress = user.full_address || "1698, j j colony, MADANPUR KHADAR, Sarita Vihar, NEW DELHI SOUTH, DELHI, 110076";

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });
    const tempDir = path.join(__dirname, '../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const pdfPath = path.join(tempDir, `Agreement_Loan_${loan.id}_${Date.now()}.pdf`);
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // --- Header ---
    doc.fontSize(16).fillColor('#1e3a8a').text('PPOKKET FINANCIAL SERVICES PRIVATE LIMITED', { align: 'center', bold: true });
    doc.fontSize(8.5).fillColor('#475569').text('Registered Office: 1698, JJ Colony, Madanpur Khadar, Sarita Vihar, New Delhi - 110076', { align: 'center' });
    doc.text('Partnered with RBI-registered NBFCs', { align: 'center' });
    doc.strokeColor('#cbd5e1').lineWidth(1).moveTo(50, 95).lineTo(562, 95).stroke();
    doc.moveDown(2);

    let y = 110;

    // --- Letter Header ---
    doc.fontSize(9.5).fillColor('#0f172a');
    doc.text(`Date: ${agreementDate}`, 50, y);
    y += 14;
    doc.text(`Name of the Borrower: ${borrowerName}`, 50, y);
    y += 14;
    doc.text(`Address of the Borrower: ${borrowerAddress}`, 50, y, { width: 512 });
    y += 28;

    doc.text('Dear Sir/Madam,', 50, y);
    y += 18;
    doc.text('Sub: Sanction Letter', 50, y, { bold: true });
    y += 18;
    doc.text(`With reference to your application dated on ${agreementDate} for availing a loan for an amount of ${formatINR(principal)}, we are pleased to sanction the same subject to the terms and conditions as mentioned below and in the loan agreement to be executed.`, 50, y, { width: 512 });
    y += 45;

    // --- KFS Table ---
    doc.fontSize(11).fillColor('#1e3a8a').text('PART-I: KEY FACT STATEMENT (KFS)', 50, y, { bold: true });
    y += 18;

    const kfsData = [
      ['Nature of Loan', 'Unsecured Personal Loan'],
      ['Principal Amount (INR)', formatINR(principal)],
      ['Annualized Rate of Interest (% Per Annum)', `${annualizedROI}%`],
      ['Annualized Effective Rate of Interest (% Per Annum)', `${effectiveROI}%`],
      ['Interest Amount (INR)', formatINR(interestAmount)],
      ['Broken Period Interest', 'The broken period interest is calculated on actual number of days. Number of days in a year is considered as 365 days.'],
      ['Loan Term', `${term} Months`],
      ['Number of Repayment Installments', `${term}`],
      ['Total Repayment Amount', `The Total Repayment Amount is ${formatINR(totalRepayable)} and the term is ${term} Months.`],
      ['Fees and Charges', ''],
      ['Processing Fee + GST (INR)', formatINR(loan.processing_fee)],
      ['Insurance charges + GST (if applicable)(INR)', 'INR 0'],
      ['Other Product/Services + GST (if applicable)(INR)', 'INR 0'],
      ['Repayment Fee (INR)', '0.1% of Repayment Amount'],
      ['Foreclosure/Prepayment fee', 'If the borrower opts to foreclose/prepay any installment after the look-up period, a charge of 4.5% of the principal amount prepaid plus GST shall be charged. Foreclosure option is available from the 2nd installment onwards, excluding the immediate next due installment.'],
      ['Repayment Convenience Charges', 'As per payment gateway charges'],
      ['Auto Pay Set Up Charge + GST (INR)', 'INR 0'],
      ['Auto Pay Maintenance Charge + GST (INR)', 'INR 0 (Charged at a rate of INR 0 + GST per financial quarter, where a repayment is due for the loan and the maintenance charge is not already paid)'],
      ['Fees for additional services (change in NACH/bounce)', 'NA'],
      ['Annualized Penal Charges for overdue loans', 'Subject to Late Payment Charges (as per matrix below) and Bounce Charges.'],
      ['Bounce Charges', 'INR 150.00/- per installment (penal in nature, applicable only once per installment, levied 2 days after due date)'],
      ['Net Disbursal Amount (INR)', formatINR(netDisbursal)],
      ['Discount Amount (INR)', 'INR 0'],
      ['Total Repayable Amount (INR)', formatINR(totalRepayable)],
      ['Annualized Percentage Rate (APR) %', `${apr}%`],
      ['Look Up Period', '24 hours from the time of loan disbursal. Within this period, the borrower can foreclose by paying only the principal and proportionate APR without any foreclosure fee.']
    ];

    // Header KFS Row
    doc.rect(50, y, 512, 16).fill('#1e3a8a');
    doc.fillColor('#ffffff').fontSize(8.5).text('Particulars', 55, y + 4, { bold: true });
    doc.text('Details', 255, y + 4, { bold: true });
    y += 16;

    kfsData.forEach(([key, val]) => {
      const isHeaderRow = val === '';
      const keyHeight = doc.heightOfString(key, { width: 195 });
      const valHeight = doc.heightOfString(val, { width: 300 });
      const rowHeight = Math.max(keyHeight, valHeight) + 6;

      if (y + rowHeight > doc.page.height - 40) {
        doc.addPage();
        y = 50;
        // Redraw Header
        doc.rect(50, y, 512, 16).fill('#1e3a8a');
        doc.fillColor('#ffffff').fontSize(8.5).text('Particulars', 55, y + 4, { bold: true });
        doc.text('Details', 255, y + 4, { bold: true });
        y += 16;
      }

      if (isHeaderRow) {
        doc.rect(50, y, 512, rowHeight).fill('#f1f5f9');
        doc.fillColor('#0f172a').fontSize(8).text(key, 55, y + 4, { bold: true, width: 500 });
      } else {
        doc.strokeColor('#e2e8f0').lineWidth(0.5);
        doc.rect(50, y, 512, rowHeight).stroke();
        doc.moveTo(250, y).lineTo(250, y + rowHeight).stroke();

        doc.fillColor('#1e293b').fontSize(7.5);
        doc.text(key, 55, y + 3, { width: 190 });
        doc.text(val, 255, y + 3, { width: 295 });
      }
      y += rowHeight;
    });

    // --- Late Payment Matrix ---
    doc.addPage();
    y = 50;

    doc.fontSize(11).fillColor('#1e3a8a').text('PART-II: LATE PAYMENT CHARGES MATRIX', 50, y, { bold: true });
    y += 18;

    doc.fontSize(8).fillColor('#475569').text('An amount payable by the borrower on repayment post due date for each installment as tabled below:', 50, y);
    y += 16;

    const matrixHeaders = ['Lower', 'Upper', 'DPD 1-10', '11-20', '21-30', '31-40', '41-50', '51-60', '61+ (10d)', 'Max Chg', 'Max Days', 'Ann%'];
    const matrixColWidths = [38, 38, 32, 32, 32, 32, 32, 32, 38, 45, 45, 46]; // Sum = 442 pt

    const latePaymentRows = [
      ['1', '100', '4', '3', '3', '2', '2', '2', '1', '40', '460', '32%'],
      ['101', '250', '10', '8', '8', '5', '5', '5', '2', '100', '460', '32%'],
      ['251', '500', '20', '15', '15', '10', '10', '10', '3', '200', '460', '32%'],
      ['501', '1000', '40', '30', '30', '20', '20', '20', '6', '400', '460', '32%'],
      ['1001', '1500', '60', '45', '45', '30', '30', '30', '9', '600', '460', '32%'],
      ['1501', '2000', '80', '60', '60', '40', '40', '40', '12', '800', '460', '32%'],
      ['2001', '2500', '100', '75', '75', '50', '50', '50', '15', '1000', '460', '32%'],
      ['2501', '3000', '120', '90', '90', '60', '60', '60', '18', '1200', '460', '32%'],
      ['3001', '3500', '140', '105', '105', '70', '70', '70', '21', '1400', '460', '32%'],
      ['3501', '5000', '200', '150', '150', '100', '100', '100', '30', '2000', '460', '32%'],
      ['5001', '7500', '300', '225', '225', '150', '150', '150', '45', '3000', '460', '32%'],
      ['7501', '10000', '400', '300', '300', '200', '200', '200', '60', '4000', '460', '32%'],
      ['10001', '12500', '500', '375', '375', '250', '250', '250', '75', '5000', '460', '32%'],
      ['12501', '15000', '600', '450', '450', '300', '300', '300', '90', '6000', '460', '32%'],
      ['15001', '17500', '700', '525', '525', '350', '350', '350', '105', '7000', '460', '32%'],
      ['17501', '20000', '800', '600', '600', '400', '400', '400', '120', '8000', '460', '32%']
    ];

    // Draw header
    doc.rect(50, y, 442, 14).fill('#1e3a8a');
    doc.fillColor('#ffffff').fontSize(6.5).text('Installment Due (Rs)', 50, y + 4, { width: 76, align: 'center', bold: true });
    doc.text('DPD Brackets & Charges (Rs)', 126, y + 4, { width: 192, align: 'center', bold: true });
    doc.text('Limits', 318, y + 4, { width: 174, align: 'center', bold: true });
    y += 14;

    doc.rect(50, y, 442, 12).fill('#2c5282');
    doc.fillColor('#ffffff').fontSize(6);
    let curX = 50;
    matrixHeaders.forEach((h, idx) => {
      doc.text(h, curX + 2, y + 3, { width: matrixColWidths[idx] - 4, align: 'center' });
      curX += matrixColWidths[idx];
    });
    y += 12;

    doc.fillColor('#334155').fontSize(5.5);
    latePaymentRows.forEach((row) => {
      doc.strokeColor('#cbd5e1').lineWidth(0.5);
      doc.rect(50, y, 442, 11).stroke();

      let cellX = 50;
      row.forEach((cell, idx) => {
        if (idx > 0) {
          doc.moveTo(cellX, y).lineTo(cellX, y + 11).stroke();
        }
        doc.text(String(cell), cellX + 1, y + 3, { width: matrixColWidths[idx] - 2, align: 'center' });
        cellX += matrixColWidths[idx];
      });
      y += 11;
    });

    y += 12;
    doc.fontSize(7.5).fillColor('#475569');
    doc.text('* The above annualized % is computed based on the maximum Penal Charges on the upper limit and considering the maximum no of days upto which it shall apply.');
    doc.text(`- In case of payment after due date, the Annualised Rate of Interest of ${annualizedROI}% shall be charged till the actual date of payment.`);
    y += 24;

    // --- Bounce & Penal Rules ---
    doc.fontSize(9.5).fillColor('#1e3a8a').text('Bounce & Overdue Charge Rules', { bold: true });
    y += 12;
    const rulesText = `Bounce Charges: Rs. 150.00/- per installment. Bounce Charges shall mean penal charges for dishonor of any payment instrument / mandate resulting into non-payment of installment on their respective due date. Bounce charge which are penal in nature will be applicable only once for each installment. If a payment is not made by the due date (or within grace period of 1 day), due to dishonor of a payment instrument / mandate, bounce charges will be levied on 2 day(s) after the due date. Penal Charge shall mean sum of Bounce Charge and Late Payment Charge. Overdue charge shall mean sum of Interest after Due Date (IADD) and Penal Charge. Overdue Amount shall mean sum of Installment amount and Overdue Charge. For any installment that is overdue, the Overdue Charge will start applying. The Overdue Charges, mentioned above, will accumulate till the Overdue Amount becomes twice the installment amount. Once the overdue Amount reaches a value of twice the installment amount, the Penal Charges will be progressively reduced to zero such that the Overdue Amount does not exceed twice the instalment amount, while IADD will continue to accrue. Once the applicable IADD becomes equal to the installment amount, the IADD will accrue at 24% per annum. Under any circumstances, the Overdue Amount shall not exceed three times the installment amount.`;
    
    doc.fontSize(7.5).fillColor('#334155').text(rulesText, 50, y, { width: 512, align: 'justify' });
    
    // --- Repayment Schedule ---
    doc.addPage();
    y = 50;

    doc.fontSize(11).fillColor('#1e3a8a').text('PART-III: LOAN REPAYMENT SCHEDULE', 50, y, { bold: true });
    y += 18;

    const scheduleHeaders = ['Sl.', 'Repayment Date', 'Instalment Amount', 'Principal', 'Interest', 'Repayment Fee'];
    const schedColWidths = [40, 110, 100, 90, 80, 92]; // Sum = 512

    doc.rect(50, y, 512, 16).fill('#1e3a8a');
    doc.fillColor('#ffffff').fontSize(8.5);
    let schedX = 50;
    scheduleHeaders.forEach((sh, idx) => {
      doc.text(sh, schedX + 4, y + 4, { width: schedColWidths[idx] - 8, align: 'center', bold: true });
      schedX += schedColWidths[idx];
    });
    y += 16;

    doc.fontSize(8).fillColor('#334155');
    scheduleRows.forEach((row) => {
      doc.strokeColor('#e2e8f0').lineWidth(0.5);
      doc.rect(50, y, 512, 14).stroke();

      const emi = parseFloat(row.emi_amount);
      const repFee = (emi * 0.001);

      const cells = [
        row.installment_no,
        getOrdinalDate(row.due_date),
        formatINR(emi),
        formatINR(row.principal_amount),
        formatINR(row.interest_amount),
        formatINR(repFee)
      ];

      let cellX = 50;
      cells.forEach((val, idx) => {
        if (idx > 0) {
          doc.moveTo(cellX, y).lineTo(cellX, y + 14).stroke();
        }
        doc.text(String(val), cellX + 4, y + 3, { width: schedColWidths[idx] - 8, align: 'center' });
        cellX += schedColWidths[idx];
      });
      y += 14;
    });

    y += 12;
    doc.fontSize(7.5).fillColor('#475569');
    doc.text('Calculation of interest is done on a monthly basis, number of days in a month being 30 and 360 days in a year.');
    y += 24;

    // Miscellaneous
    const miscData = [
      ['Charges pursuant to Addendum Agreement', 'As to be agreed in the Addendum Agreement'],
      ['Governing Law and Jurisdiction', 'Kolkata, West Bengal']
    ];

    miscData.forEach(([key, val]) => {
      doc.fontSize(8.5).fillColor('#0f172a');
      doc.text(`${key}: `, { bold: true, continued: true });
      doc.text(val, { bold: false });
      y += 14;
    });

    // --- Terms & Conditions ---
    doc.addPage();
    y = 50;

    doc.fontSize(11).fillColor('#1e3a8a').text('PART-IV: TERMS & CONDITIONS', 50, y, { bold: true });
    y += 18;

    const terms = [
      '1. These are the Most Important Terms & Conditions of the aforesaid Loan, and all other terms and conditions of the Loan shall be as specified in the Loan Agreement.',
      '2. I hereby request the Lenders to debit Rs.0 /- only from Loan and pay insurer/ vendor towards insurance premium/ sale price of product / service.',
      '3. I hereby acknowledge and agree that the autopay mandate setup for loan repayment can only be cancelled/closed upon closure of loan or if another autopay is already registered.',
      '4. I am well aware of the features and terms & conditions of the insurance/ product / service and voluntarily availed/ purchased the same on my own. Hence, I will not hold the Lenders and/or Lending Service Provider responsible for any defect/service deficiency/rejection of claim/warranty by the insurer/vendor of product/ service.',
      '5. I hereby provide my explicit consent to share my personal details/KYC information to the insurer/vendor of product/ service, as required, for granting the said insurance/service/product.',
      '6. The Lenders, at its sole discretion, shall be entitled to revoke this sanction upon occurrence of any of the following events: (a) Material change in the loan purpose. (b) Concealment of material facts. (c) Incorrect or misleading declarations. (d) Default or breach of this Sanction Letter. (e) Bankruptcy or insolvency. (f) Failure to execute documents in Lender\'s format.',
      '7. The Borrower may foreclose/prepay the outstanding amount of the facility at any time during the loan tenure, subject to a foreclosure fee of 4.5% of the principal amount prepaid plus GST. Foreclosure is available from the 2nd installment onwards, excluding the immediate next due installment.',
      '8. The Borrower understands that identical products with identical tenor and availed during the same period may attract different interest rates based on historical client performance, borrower credit profile, and indebtedness.',
      '9. The Borrower understands that the Lender has adopted risk-based pricing, which is arrived by considering parameters like the borrower\'s financial and credit risk profile. Interest rates differ for different categories of borrowers as disclosed in the Interest Rate Policy on the website.',
      '10. The Borrower declares that he/she is aware that the Sanction Letter and other incidental documents executed by him/her integrate all the conditions mentioned herein, and supersede all negotiations or prior writings.',
      '11. This Sanction Letter intends to summarize certain basic terms of the Loan and does not reflect the complete agreement between the Lender and the Borrower. The Loan Documents shall contain additional terms and conditions.',
      '12. I hereby further confirm that I understand English Language and agree that all the loan documents, T&C and future communication are to be sent in English Language.',
      '13. Disclosure: As a precondition to the Loan, the Borrower authorizes the Lender to share information with the RBI, Credit Information Companies (Experian, CIBIL, etc.), and professional advisers. In case of default, the Lender has an unqualified right to publish the name of the Borrower as a defaulter.',
      '14. The Borrower shall notify the Lender in writing no later than 7 days of all changes in the location/address of office/residence/place of studying.',
      '15. Confidentiality: The Sanction Letter and its content are intended for the exclusive use of the Borrower and shall not be disclosed to any person other than legal advisors without the prior written consent of the Lender.',
      '16. Representations and Warranties: Usual and customary for transactions of this nature, including but not limited to maintenance of existence, notices of default, compliance with applicable laws, and payment of taxes.'
    ];

    doc.fontSize(7).fillColor('#334155');
    terms.forEach(term => {
      if (y > doc.page.height - 40) {
        doc.addPage();
        y = 50;
      }
      doc.text(term, 50, y, { width: 512, align: 'justify' });
      y += doc.heightOfString(term, { width: 512 }) + 4;
    });

    // --- SMA/NPA Classification ---
    if (y > doc.page.height - 180) {
      doc.addPage();
      y = 50;
    }

    doc.moveDown(1);
    y = doc.y;
    doc.fontSize(11).fillColor('#1e3a8a').text('PART-V: SMA / NPA ASSET CLASSIFICATION', 50, y, { bold: true });
    y += 18;

    doc.fontSize(7.5).fillColor('#334155').text('Overdue loan accounts shall be classified as Special Mention Accounts (SMA) or Non-performing Assets (NPA) as per RBI regulations indicated below:', 50, y);
    y += 14;

    const smaHeaders = ['Overdue Classification', 'Period'];
    const smaColWidths = [200, 312];

    doc.rect(50, y, 512, 14).fill('#1e3a8a');
    doc.fillColor('#ffffff').fontSize(7.5);
    doc.text('Overdue Classification', 55, y + 3, { bold: true });
    doc.text('Period', 255, y + 3, { bold: true });
    y += 14;

    const smaRows = [
      ['SMA-0', 'For a period upto 30 days'],
      ['SMA-1', 'For a period more than 30 days and upto 60 days'],
      ['SMA-2', 'For a period more than 60 days and upto 90 days'],
      ['NPA*', 'For a period more than 90 days']
    ];

    doc.fillColor('#334155').fontSize(7);
    smaRows.forEach(([cl, prd]) => {
      doc.strokeColor('#e2e8f0').lineWidth(0.5);
      doc.rect(50, y, 512, 12).stroke();
      doc.moveTo(250, y).lineTo(250, y + 12).stroke();

      doc.text(cl, 55, y + 2);
      doc.text(prd, 255, y + 2);
      y += 12;
    });

    y += 8;
    doc.fontSize(7).fillColor('#475569');
    doc.text('* Upgradation of accounts classified as NPAs: Loan account once classified as NPA can be upgraded as standard only after entire arrears of principal, interest and any other amount are paid by the borrower.');
    
    y += 12;
    const illustText = 'Illustration for Classification of borrower\'s account as SMA/NPA: If Due date of a Loan account repayment is March 31, 202X, and full dues are not received by the lender on this date, the date of overdue shall be March 31, 202X. If it continues to remain overdue, then this account shall get tagged as SMA-1 upon the day-end of April 30, 202X (i.e. upon completion of 30 days). Similarly, if it remains overdue, it shall get tagged as SMA-2 upon the day-end of May 30, 202X and NPA upon the day-end of June 30, 202X.';
    doc.text(illustText, 50, y, { width: 512, align: 'justify' });
    y += doc.heightOfString(illustText, { width: 512 }) + 14;

    if (y > doc.page.height - 100) {
      doc.addPage();
      y = 50;
    }

    doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, y).lineTo(562, y).stroke();
    y += 14;

    doc.fontSize(9.5).fillColor('#1e3a8a').text('Digitally Signed by Ppokket Financial Services Private Limited', 50, y, { bold: true });
    y += 14;
    doc.fontSize(8.5).fillColor('#475569').text(`Timestamp: ${new Date().toLocaleString('en-IN')}`, 50, y);
    doc.text(`Borrower Digital Consent IP: Verified & Logged via Click-wrap`, 50, y + 12);

    // Finalize PDF
    doc.end();

    // Wait for file stream to finish writing
    await new Promise((resolve) => stream.on('finish', resolve));
    console.log(` PDF saved locally at: ${pdfPath}`);

    // Send email
    const transporter = await getTransporter();
    if (!transporter) {
      console.log('⚠️ Could not create transporter. Skipping email send (check SMTP configs).');
      return;
    }

    // --- HTML Repayment Schedule for Email ---
    let scheduleHtml = '';
    scheduleRows.forEach(row => {
      const emi = parseFloat(row.emi_amount);
      const repFee = emi * 0.001;
      scheduleHtml += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 8px 12px; text-align: center; color: #1e293b;">${row.installment_no}</td>
          <td style="padding: 8px 12px; text-align: center; color: #1e293b;">${getOrdinalDate(row.due_date)}</td>
          <td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(emi)}</td>
          <td style="padding: 8px 12px; text-align: right; color: #334155;">${formatINR(row.principal_amount)}</td>
          <td style="padding: 8px 12px; text-align: right; color: #334155;">${formatINR(row.interest_amount)}</td>
          <td style="padding: 8px 12px; text-align: right; color: #334155;">${formatINR(repFee)}</td>
        </tr>
      `;
    });

    const mailOptions = {
      from: '"Ppokket Financial Services" <ppokket.noreply@gmail.com>',
      to: emailRecipient,
      subject: `Loan Agreement & Sanction Letter - Loan Ref: LREF_${loan.id} 📄`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; line-height: 1.6;">
          <div style="text-align: center; margin-bottom: 25px;">
            <h2 style="color: #1e3a8a; margin: 0; font-size: 20px; font-weight: bold; letter-spacing: -0.5px;">PPOKKET FINANCIAL SERVICES PRIVATE LIMITED</h2>
            <p style="font-size: 12px; color: #64748b; margin: 4px 0 0 0;">Partnered with RBI-registered NBFCs</p>
          </div>

          <p style="font-size: 14px;">Date: <strong>${agreementDate}</strong></p>
          <p style="font-size: 14px; margin: 4px 0;">Borrower Name: <strong>${borrowerName}</strong></p>
          <p style="font-size: 14px; margin: 4px 0;">Borrower Address: <span style="color: #475569;">${borrowerAddress}</span></p>
          
          <p style="margin-top: 20px; font-size: 15px;">Dear Sir/Madam,</p>
          <p style="font-size: 15px; font-weight: bold; color: #1e3a8a; margin-top: 5px;">Sub: Sanction Letter</p>
          
          <p style="font-size: 14px; color: #334155;">
            With reference to your application dated on <strong>${agreementDate}</strong> for availing a loan for an amount of <strong>${formatINR(principal)}</strong>, we are pleased to sanction the same subject to the terms and conditions as mentioned below and in the loan agreement to be executed.
          </p>

          <h3 style="color: #1e3a8a; font-size: 15px; border-bottom: 1.5px solid #1e3a8a; padding-bottom: 5px; margin-top: 25px;">PART-I: KEY FACT STATEMENT (KFS)</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0;">
            <tr style="background-color: #1e3a8a; color: white;">
              <th style="padding: 8px 12px; text-align: left; border-radius: 4px 0 0 0;">Particulars</th>
              <th style="padding: 8px 12px; text-align: right; border-radius: 0 4px 0 0;">Details</th>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Nature of Loan</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">Unsecured Personal Loan</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Principal Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(principal)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Annualized Rate of Interest</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${annualizedROI}% Per Annum</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Annualized Effective Rate of Interest</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${effectiveROI}% Per Annum</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Interest Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(interestAmount)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Loan Term / Number of Repayments</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${term} Months (${term} Installments)</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Processing Fee + GST (Upfront)</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(loan.processing_fee)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Net Disbursed Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(netDisbursal)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Total Repayable Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(totalRepayable)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Annualized Percentage Rate (APR) %</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${apr}% Per Annum</td></tr>
          </table>

          <h3 style="color: #1e3a8a; font-size: 15px; border-bottom: 1.5px solid #1e3a8a; padding-bottom: 5px; margin-top: 25px;">PART-III: LOAN REPAYMENT SCHEDULE</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin: 12px 0;">
            <tr style="background-color: #1e3a8a; color: white;">
              <th style="padding: 8px 12px; text-align: center;">Sl.</th>
              <th style="padding: 8px 12px; text-align: center;">Repayment Date</th>
              <th style="padding: 8px 12px; text-align: right;">Instalment Amount</th>
              <th style="padding: 8px 12px; text-align: right;">Principal</th>
              <th style="padding: 8px 12px; text-align: right;">Interest</th>
              <th style="padding: 8px 12px; text-align: right;">Repayment Fee</th>
            </tr>
            ${scheduleHtml}
          </table>

          <p style="font-size: 13px; color: #64748b;">
            Your loan will be disbursed shortly to your registered bank account: <strong>${bank.bank_name} ending in ****${bank.account_number.slice(-4)}</strong>.
          </p>

          <p style="font-size: 13px; color: #334155; margin-top: 20px;">
            The detailed Sanction Letter and Most Important Terms & Conditions (MITC) containing the late payment charges matrix, bounce charge rules, and full terms are attached to this email as a PDF document.
          </p>

          <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 25px 0;" />

          <p style="font-size: 13px; font-weight: bold; color: #1e3a8a; margin: 0;">Digitally Signed by Ppokket Financial Services Private Limited</p>
          <p style="font-size: 12px; color: #64748b; margin: 2px 0 0 0;">Timestamp: ${new Date().toLocaleString('en-IN')}</p>
          
          <p style="font-size: 11px; color: #94a3b8; margin-top: 30px; line-height: 1.4;">
            This is an automated notification. Please do not reply directly to this email. For any queries, write to us at support@ppokket.com.
          </p>
        </div>
      `,
      attachments: [
        {
          filename: `Sanction_Letter_LREF_${loan.id}.pdf`,
          path: pdfPath
        }
      ]
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✉️ Loan Agreement Email sent successfully to ${emailRecipient}. MessageId: ${info.messageId}`);
    
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`🔗 Ethereal Email Preview Link: ${previewUrl}`);
    }

    // Delete temp file after sending
    fs.unlink(pdfPath, (err) => {
      if (err) console.error('Failed to clean up temp PDF file:', err);
    });

  } catch (err) {
    console.error('❌ Failed to generate or send loan agreement email:', err);
  }
};

module.exports = { sendLoanAgreementEmail };
