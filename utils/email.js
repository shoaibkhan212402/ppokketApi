const nodemailer = require('nodemailer');
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

// Corporate Header Helper for PDFs
const drawHeader = (doc, titleText) => {
  doc.fontSize(15).fillColor('#1e3a8a').text('PPOKKET PRIVATE LIMITED', { align: 'center', bold: true });
  doc.fontSize(8.5).fillColor('#475569').text('Registered Office: 1698, JJ Colony, Madanpur Khadar, Sarita Vihar, New Delhi - 110076', { align: 'center' });
  doc.text('Partnered with RBI-registered NBFCs', { align: 'center' });
  doc.strokeColor('#cbd5e1').lineWidth(1).moveTo(50, 95).lineTo(562, 95).stroke();
  doc.moveDown(1.5);
  doc.fontSize(12).fillColor('#0f172a').text(titleText, 50, 105, { align: 'center', underline: true, bold: true });
  doc.moveDown(1.5);
};

// Corporate Footer Helper for PDFs
const drawFooter = (doc) => {
  doc.strokeColor('#cbd5e1').lineWidth(0.5).moveTo(50, doc.page.height - 65).lineTo(562, doc.page.height - 65).stroke();
  doc.fontSize(6.5).fillColor('#64748b').text('CIN: U66190DL2026PTC467837 | GSTIN: 07AAMCP1234A1Z1 | Registered Office: 1698, JJ Colony, Madanpur Khadar, Sarita Vihar, New Delhi - 110076', 50, doc.page.height - 58, { align: 'center' });
  doc.text('Phone: +91 81780 31447 | Email: support@ppokket.com | Website: www.ppokket.com', { align: 'center' });
};

// Late Payment matrix rows data
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

// Late Payment Charges matrix rendering logic
const drawLatePaymentMatrix = (doc, startY) => {
  let y = startY;
  const matrixHeaders = ['Lower', 'Upper', 'DPD 1-10', '11-20', '21-30', '31-40', '41-50', '51-60', '61+ (10d)', 'Max Chg', 'Max Days', 'Ann%'];
  const matrixColWidths = [38, 38, 32, 32, 32, 32, 32, 32, 38, 45, 45, 46];

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
    if (y + 11 > doc.page.height - 80) {
      doc.addPage();
      y = 50;
      doc.rect(50, y, 442, 14).fill('#1e3a8a');
      doc.fillColor('#ffffff').fontSize(6.5).text('Installment Due (Rs)', 50, y + 4, { width: 76, align: 'center', bold: true });
      doc.text('DPD Brackets & Charges (Rs)', 126, y + 4, { width: 192, align: 'center', bold: true });
      doc.text('Limits', 318, y + 4, { width: 174, align: 'center', bold: true });
      y += 14;

      doc.rect(50, y, 442, 12).fill('#2c5282');
      doc.fillColor('#ffffff').fontSize(6);
      let tempX = 50;
      matrixHeaders.forEach((h, idx) => {
        doc.text(h, tempX + 2, y + 3, { width: matrixColWidths[idx] - 4, align: 'center' });
        tempX += matrixColWidths[idx];
      });
      y += 12;
    }

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

  return y;
};

// Bounce charges text block
const bounceChargesText = `Bounce Charges shall mean penal charges for dishonor of any payment instrument / mandate resulting into non-payment of installment on their respective due date. Bounce charge which are penal in nature will be applicable only once for each installment. If a payment is not made by the due date (or within grace period of 1 day), due to dishonor of a payment instrument / mandate, bounce charges will be levied on 2 day(s) after the due date. Penal Charge shall mean sum of Bounce Charge and Late Payment Charge. Overdue charge shall mean sum of Interest after Due Date (IADD) and Penal Charge. Overdue Amount shall mean sum of Installment amount and Overdue Charge. For any installment that is overdue, the Overdue Charge will start applying. The Overdue Charges, mentioned above, will accumulate till the Overdue Amount becomes twice the installment amount. Once the overdue Amount reaches a value of twice the installment amount, the Penal Charges will be progressively reduced to zero such that the Overdue Amount does not exceed twice the instalment amount, while IADD will continue to accrue. Once the applicable IADD becomes equal to the installment amount, the IADD will accrue at 24% per annum. Under any circumstances, the Overdue Amount shall not exceed three times the installment amount.`;

/**
 * Generates a loan agreement PDF and sends it via email to the user
 */
const sendLoanAgreementEmail = async ({ user, loan, bank }) => {
  const PDFDocument = require('pdfkit');
  try {
    const emailRecipient = user.email || 'customer@ppokket.com';
    console.log(` Generating Agreement PDFs for ${user.full_name} (${emailRecipient})...`);

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

    // Common variables
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

    const tempDir = path.join(__dirname, '../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const pdf1Path = path.join(tempDir, `Acknowledgement_Loan_${loan.id}_${timestamp}.pdf`);
    const pdf2Path = path.join(tempDir, `Key_Facts_Statement_Loan_${loan.id}_${timestamp}.pdf`);
    const pdf3Path = path.join(tempDir, `Sanction_Letter_Loan_${loan.id}_${timestamp}.pdf`);

    // ==========================================
    // PDF 1: Acknowledgement of Loan Application
    // ==========================================
    const doc1 = new PDFDocument({ margin: 50, bufferPages: true });
    const stream1 = fs.createWriteStream(pdf1Path);
    doc1.pipe(stream1);

    drawHeader(doc1, 'Acknowledgement of Loan Application');
    
    // Borrower Details Table
    let y1 = doc1.y + 10;
    const details1 = [
      ['Name of Applicant', borrowerName],
      ['Address of Applicant', borrowerAddress],
      ['Mobile Number', `+91 ${user.mobile}`],
      ['Email Address', user.email],
      ['Proof of ID submitted', 'PAN'],
      ['Proof of Address submitted', 'Other Identification number'],
      ['Preferred Language', 'English']
    ];

    doc1.rect(50, y1, 512, 14).fill('#1e3a8a');
    doc1.fillColor('#ffffff').fontSize(8.5).text('Details', 55, y1 + 3, { bold: true });
    doc1.text('Applicant', 255, y1 + 3, { bold: true });
    y1 += 14;

    details1.forEach(([key, val]) => {
      const keyHeight = doc1.heightOfString(key, { width: 195 });
      const valHeight = doc1.heightOfString(val, { width: 300 });
      const rowHeight = Math.max(keyHeight, valHeight) + 6;

      doc1.strokeColor('#e2e8f0').lineWidth(0.5);
      doc1.rect(50, y1, 512, rowHeight).stroke();
      doc1.moveTo(250, y1).lineTo(250, y1 + rowHeight).stroke();

      doc1.fillColor('#1e293b').fontSize(7.5);
      doc1.text(key, 55, y1 + 3, { width: 190 });
      doc1.text(val, 255, y1 + 3, { width: 295 });
      y1 += rowHeight;
    });

    y1 += 16;
    doc1.fontSize(9.5).fillColor('#1e3a8a').text('Declaration', 50, y1, { bold: true });
    y1 += 14;

    const declarationText = `I the undersigned wish to apply to Ppokket Private Limited for a loan of ${formatINR(principal)} for ${term} Months at the Annualized Percentage Rate of Interest ${apr}%, Annualised Rate of Interest ${annualizedROI}% and Annualised Effective Rate of Interest ${effectiveROI}%.

I agree and acknowledge that the lender is entitled to deduct processing fee of Rs. ${loan.processing_fee}, autopay setup charge of Rs ₹0 and autopay maintenance charge of Rs ₹0, which includes applicable taxes, from the Principal Amount. The lender is further entitled to charge penal Charges* on repayment post due date for each repayment instalment. In case of payment after due date, the Annualised Rate of Interest ${annualizedROI}% shall be charged till the actual date of payment.

I hereby request the Lenders to debit Rs. 0/- only from Loan and pay insurer/ vendor towards insurance premium/ sale price of product / services.

I hereby acknowledge and agree that the autopay mandate setup for loan repayment can only be cancelled/closed upon closure of loan or if another autopay is already registered.

A look up period of 24 hours from the time of loan disbursal will be provided to me, during which I can exit from the loan by paying off the principal amount and the proportionate APR along with processing fee and autopay set up charge.

I declare that the information given in this application form is true & correct, complete and updated in all respects and I have not withheld / suppressed any information. I hereby agree that it shall be my sole responsibility to advise the lender in the event of any changes in of any of the above details/information. I have read the T&C applicable to this loan, privacy policy of the lender, DLA and its LSPs, as mentioned on the lender’s website and understand its content. I further agree that my loan shall be governed by the T&C of the Lender that are in force and as may be amended by the lender from time to time. I confirm that I am aware of the features and terms & conditions of the insurance/ product / service and voluntarily availed/ purchased the same on my own. Hence, I will not hold the Lender and/or Lending Service Provider responsible for any defect/service deficiency/rejection of claim/warranty by the insurer/vendor of product/ service. I hereby provide my consent to share my personal details/KYC information to the insurer/vendor of product/ service, as required, for granting the said insurance/service/product. I certify that I am a citizen of India. I authorise the lender and or its associates/subsidiaries/affiliates to verify this information with any parties as deemed necessary.

I understand that the lender has adopted risk-based pricing, which is arrived by considering, broad parameters like the borrowers financial and credit risk profile. Hence the rates of Interest will be different for different categories of borrowers based on the Interest rate model disclosed in the Interest Rate Policy on the lender's website available at "Interest Rate Policy".

I confirm that the loan is not being used for any anti-social activities, investment in stock and shares, speculative activities or any purpose linked to capital market activities. I further confirm that there are no litigation/insolvency proceeding filed / pending against me by financiers/bank nor have I have ever been adjudicated insolvent.

I hereby further confirm that I understand English Language and agree that all the loan documents, T&C and other related documents and future communication are to be sent in English Language. If I have specified a preferred language other than English, I understand that all documents will be sent to me in the preferred language as well.`;

    doc1.fontSize(7.5).fillColor('#334155');
    doc1.text(declarationText, 50, y1, { width: 512, align: 'justify' });
    y1 = doc1.y + 20;

    if (y1 > doc1.page.height - 180) {
      doc1.addPage();
      y1 = 50;
    }

    doc1.fontSize(9.5).fillColor('#1e3a8a').text('Annualized Penal Charges for Overdue Loans', 50, y1, { bold: true });
    y1 += 14;
    doc1.fontSize(7.5).fillColor('#334155').text('An amount to be payable by borrower on repayment post due date for each installment as tabled below:');
    y1 += 14;

    y1 = drawLatePaymentMatrix(doc1, y1);
    y1 += 12;

    doc1.fontSize(7).fillColor('#475569').text(`* The above annualized % is computed based on the maximum Penal Charges on the upper limit and considering the maximum no of days upto which it shall apply.\n- In case of payment after due date, the Annualised Rate of Interest ${annualizedROI}% shall be charged till the actual date of payment.`);
    y1 = doc1.y + 14;

    if (y1 > doc1.page.height - 180) {
      doc1.addPage();
      y1 = 50;
    }

    doc1.fontSize(9.5).fillColor('#1e3a8a').text('(b). Bounce Charges', 50, y1, { bold: true });
    y1 += 14;
    doc1.fontSize(7.5).fillColor('#334155').text(`Rs. 150.00/- per instalment\n${bounceChargesText}`, 50, y1, { width: 512, align: 'justify' });
    y1 = doc1.y + 24;

    if (y1 > doc1.page.height - 180) {
      doc1.addPage();
      y1 = 50;
    }

    doc1.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, y1).lineTo(562, y1).stroke();
    y1 += 14;

    doc1.fontSize(9.5).fillColor('#1e3a8a').text('Acknowledgement for Receipt of Application Form', 50, y1, { bold: true });
    y1 += 14;
    doc1.fontSize(8.5).fillColor('#0f172a').text(`Loan Reference No. (Order ID): LREF_${loan.id}`, 50, y1);
    doc1.text(`Date: ${agreementDate}`, 350, y1);
    y1 += 16;
    doc1.fontSize(7.5).fillColor('#334155').text(`We (PPOKKET PRIVATE LIMITED) have received your application for a personal loan of ${formatINR(principal)}. The company will require a processing time of approximately 48 hours from date of receipt of completed application.`, 50, y1, { width: 512 });
    y1 = doc1.y + 24;

    if (y1 > doc1.page.height - 100) {
      doc1.addPage();
      y1 = 50;
    }

    doc1.fontSize(8.5).fillColor('#0f172a').text('For: PPOKKET PRIVATE LIMITED', 50, y1, { bold: true });
    y1 += 14;
    doc1.fillColor('#22c55e').text('Digitally Signed', 50, y1);
    y1 += 12;
    doc1.fillColor('#64748b').fontSize(7.5).text(`Digitally Signed by Ppokket Private Limited\nTimestamp: ${new Date(loan.agreement_accepted_at || new Date()).toLocaleString('en-IN')}`, 50, y1);

    // Draw footers on all pages for PDF 1
    const pages1 = doc1._pageBuffer;
    pages1.forEach((_, idx) => {
      doc1.switchToPage(idx);
      drawFooter(doc1);
    });

    doc1.end();
    await new Promise((resolve) => stream1.on('finish', resolve));

    // ==========================================
    // PDF 2: Key Facts Statement (KFS)
    // ==========================================
    const doc2 = new PDFDocument({ margin: 50, bufferPages: true });
    const stream2 = fs.createWriteStream(pdf2Path);
    doc2.pipe(stream2);

    drawHeader(doc2, 'Key Facts Statement');

    let y2 = doc2.y + 10;
    doc2.fontSize(8.5).fillColor('#0f172a');
    doc2.text(`Date: ${agreementDate}`, 50, y2);
    doc2.text(`Name of the lender: Ppokket Private Limited`, 250, y2);
    y2 += 14;
    doc2.text(`Loan ref no.: LREF_${loan.id}`, 50, y2);
    doc2.text(`Name of digital lending app: Ppokket`, 250, y2);
    y2 += 14;
    doc2.text(`Borrower Name: ${borrowerName}`, 50, y2);
    y2 += 24;

    doc2.fontSize(10).fillColor('#1e3a8a').text('Part 1 (Interest rate and fees/charges)', 50, y2, { bold: true });
    y2 += 16;

    const part1Data = [
      ['1', 'Loan proposal/ account No.', `LREF_${loan.id}`, 'Type of Loan', 'Unsecured Personal Loan'],
      ['2', 'Sanctioned Loan amount (in Rupees)', formatINR(principal), '', ''],
      ['3', 'Disbursal schedule\n(i) Disbursement in stages or 100% upfront.\n(ii) If it is stage wise, mention the clause of loan agreement having relevant details', '100% upfront', '', ''],
      ['4', 'Loan term (Months)', `${term}`, '', ''],
      ['5', 'Instalment details', 'Refer Repayment Schedule', '', ''],
      ['', 'Type of instalments', 'Number of EPIs', 'EPI (INR)', 'Commencement of repayment, post sanction'],
      ['', 'Non Equated Periodic Instalment', 'N/A', 'N/A', 'Refer the repayment schedule'],
      ['6', 'Interest rate (%) and type (fixed or floating or hybrid)', `${annualizedROI}% Fixed`, '', ''],
      ['7', 'Additional Information in case of Floating rate of interest', 'N/A', '', ''],
      ['8', 'Fee/ Charges', 'Payable to the RE (A)', 'Payable to a third party through RE (B)', '']
    ];

    // Sub fee charges
    const feeSubData = [
      ['(i)', 'Processing fees', 'One-time', formatINR(loan.processing_fee), '', ''],
      ['(ii)', 'Valuation fees', 'N/A', 'N/A', 'N/A', 'N/A'],
      ['(iii)', 'Any other (please specify)', '', '', '', ''],
      ['', '(a) Repayment Fee', '', '', 'Recurring', '0.1% of Repayment Amount'],
      ['', '(b) Repayment Convenience Charges', '', '', 'Recurring', 'As per PG charges'],
      ['', '(c) Autopay setup Charge', '', '', 'One-time', 'INR 0'],
      ['', '(d) Autopay Maintenance Charge*', '', '', 'One-time', 'INR 0']
    ];

    doc2.rect(50, y2, 512, 14).fill('#1e3a8a');
    doc2.fillColor('#ffffff').fontSize(7.5).text('No.', 52, y2 + 3, { width: 18, align: 'center', bold: true });
    doc2.text('Parameter', 75, y2 + 3, { width: 140, bold: true });
    doc2.text('Details', 220, y2 + 3, { width: 290, bold: true });
    y2 += 14;

    const drawKfsRows = (rowsList) => {
      rowsList.forEach((row) => {
        const isHeaderRow = row[2] === '' && row[3] === '' && row[4] === '';
        
        let col1Text = row[0];
        let col2Text = row[1];
        let col3Text = row.slice(2).filter(v => v !== '').join(' | ');

        if (row[1] === 'Type of instalments' || row[1] === 'Fee/ Charges') {
          col3Text = row.slice(2).filter(v => v !== '').join(' | ');
        }

        const h1 = doc2.heightOfString(col2Text, { width: 140 });
        const h2 = doc2.heightOfString(col3Text, { width: 290 });
        const rowHeight = Math.max(h1, h2, 12) + 6;

        if (y2 + rowHeight > doc2.page.height - 80) {
          doc2.addPage();
          y2 = 50;
          doc2.rect(50, y2, 512, 14).fill('#1e3a8a');
          doc2.fillColor('#ffffff').fontSize(7.5).text('No.', 52, y2 + 3, { width: 18, align: 'center', bold: true });
          doc2.text('Parameter', 75, y2 + 3, { width: 140, bold: true });
          doc2.text('Details', 220, y2 + 3, { width: 290, bold: true });
          y2 += 14;
        }

        doc2.strokeColor('#e2e8f0').lineWidth(0.5);
        doc2.rect(50, y2, 512, rowHeight).stroke();
        doc2.moveTo(70, y2).lineTo(70, y2 + rowHeight).stroke();
        doc2.moveTo(215, y2).lineTo(215, y2 + rowHeight).stroke();

        doc2.fillColor('#1e293b').fontSize(6.5);
        doc2.text(col1Text, 52, y2 + 3, { width: 18, align: 'center' });
        doc2.text(col2Text, 75, y2 + 3, { width: 135 });
        doc2.text(col3Text, 220, y2 + 3, { width: 285 });
        y2 += rowHeight;
      });
    };

    drawKfsRows(part1Data);
    
    // Draw fee headers
    doc2.rect(50, y2, 512, 12).fill('#2c5282');
    doc2.fillColor('#ffffff').fontSize(6.5).text('Fees Breakdown', 55, y2 + 3, { bold: true });
    y2 += 12;

    feeSubData.forEach((row) => {
      let col1Text = row[0] || row[1];
      let col2Text = row[2] ? `${row[2]}: ${row[3]}` : '';
      let col3Text = row[4] ? `${row[4]}: ${row[5]}` : '';
      if (!col2Text && !col3Text) {
        col2Text = row[1] || '';
      }

      const h1 = doc2.heightOfString(col1Text, { width: 150 });
      const h2 = doc2.heightOfString(col2Text + col3Text, { width: 340 });
      const rowHeight = Math.max(h1, h2, 11) + 4;

      if (y2 + rowHeight > doc2.page.height - 80) {
        doc2.addPage();
        y2 = 50;
      }

      doc2.strokeColor('#e2e8f0').lineWidth(0.5);
      doc2.rect(50, y2, 512, rowHeight).stroke();
      doc2.moveTo(215, y2).lineTo(215, y2 + rowHeight).stroke();

      doc2.fillColor('#334155').fontSize(6);
      doc2.text(col1Text, 55, y2 + 2, { width: 155 });
      doc2.text(col2Text ? `${col2Text}   ${col3Text}` : row[5] || '', 220, y2 + 2, { width: 285 });
      y2 += rowHeight;
    });

    const part1Cont = [
      ['9', 'Discount (INR)', 'INR 0.00'],
      ['10', 'Annual Percentage Rate (APR) (%)', `${apr}%`],
      ['11', 'Details of Contingent Charges (in INR or %, as applicable)', ''],
      ['(i)', 'Penal charges, if any, in case of delayed payment', 'Refer to Annexure A'],
      ['(ii)', 'Foreclosure / prepayment charge, if applicable', 'If the borrower opts to foreclose/prepay any installment after the look-up period, a charge of 4.5% of the principal amount prepaid plus GST shall be charged. Foreclosure option is available from the 2nd installment onwards.'],
      ['(iii)', 'Charges for switching of loans from floating to fixed rate and vice versa', 'N/A'],
      ['(iv)', 'Any other charges (please specify)', 'N/A']
    ];

    drawKfsRows(part1Cont);

    y2 += 8;
    doc2.fontSize(6).fillColor('#475569').text('*Autopay Maintenance Charge: Charged at a rate of INR 0 + GST per financial quarter, where a repayment is due for the loan and the maintenance charge is not already paid');
    y2 = doc2.y + 14;

    if (y2 > doc2.page.height - 180) {
      doc2.addPage();
      y2 = 50;
    }

    // Part 2
    doc2.fontSize(10).fillColor('#1e3a8a').text('Part 2 (Other qualitative information)', 50, y2, { bold: true });
    y2 += 14;

    const part2Data = [
      ['1', 'Clause of Loan agreement relating to engagement of recovery agents', 'Clause 4.4(d) of the loan agreement'],
      ['2', 'Clause of Loan agreement which details grievance redressal mechanism', 'Clause 10.13 of the loan agreement'],
      ['3', 'Phone number and email id of the nodal grievance redressal officer', 'Email: support@ppokket.com | Contact: +91 81780 31447'],
      ['4', 'Whether the loan is, or in future maybe, subject to transfer to other REs or securitisation (Yes/ No)', 'yes'],
      ['5', 'In case of lending under collaborative lending arrangements (co-lending/outsourcing):', 'N/A'],
      ['6', 'In case of digital loans, following specific disclosures may be furnished:', ''],
      ['(i)', 'Cooling off / look-up period, in terms of RE’s board approved policy', '24 hours from the time of loan disbursal. In case of prepayment during look up period the principal and proportionate APR without penalty shall be payable.'],
      ['(ii)', 'Details of LSP acting as recovery agent and authorized to approach the borrower', 'For details of service provider and its agents etc. please refer to https://www.ppokket.com/lsp-dla'],
      ['(iii)', 'Usage of payment instrument / mandate', 'It is hereby acknowledged by the Borrower that the payment instrument / mandate can be used by the Lender to collect all outstanding loan dues in full or part.']
    ];

    drawKfsRows(part2Data);
    
    // APR Computation Table
    doc2.addPage();
    y2 = 50;

    doc2.fontSize(10).fillColor('#1e3a8a').text('APR Computation', 50, y2, { bold: true });
    y2 += 16;

    const firstDueDate = scheduleRows[0] ? getOrdinalDate(scheduleRows[0].due_date) : getOrdinalDate(new Date());

    const aprData = [
      ['1', 'Sanctioned Loan amount (in Rupees) (Sl no. 2 of the KFS template - Part 1)', formatINR(principal)],
      ['2', 'Loan Term (in Months) (Sl No.4 of the KFS template - Part 1)', `${term}`],
      ['a.', 'No. of instalments for payment of principal, in case of non-equated periodic loans', `${term}`],
      ['b.', 'Type of EPI', 'N/A'],
      ['', 'Amount of each EPI (in Rupees)', 'N/A'],
      ['', 'Nos. of EPIs (e.g., no. of EMIs in case of monthly instalments)', 'N/A'],
      ['c.', 'No. of instalments for payment of capitalised interest, if any', '—'],
      ['d.', 'Commencement of repayments, post sanction (Sl No. 5 of the KFS template - Part 1)', 'Refer the repayment schedule'],
      ['3', 'Interest rate type (fixed or floating or hybrid) (Sl No. 6 of the KFS template - Part 1)', 'Fixed'],
      ['4', 'Rate of Interest (Sl No. 6 of the KFS template - Part 1)', `${annualizedROI}%`],
      ['5', 'Total Interest Amount to be charged during the entire tenor of the loan', formatINR(interestAmount)],
      ['6', 'Fee/ Charges payable (in Rupees)', formatINR(loan.processing_fee)],
      ['a.', 'Payable to the RE (Sl No.8A of the KFS template-Part 1)', formatINR(loan.processing_fee)],
      ['b.', 'Payable to third-party routed through RE (Sl No.8B of the KFS template - Part 1)', 'INR 0.00'],
      ['7', 'Net disbursed amount (in Rupees)', formatINR(netDisbursal)],
      ['8', 'Discount Amount (INR)', 'INR 0.00'],
      ['9', 'Total amount to be paid by the borrower (sum of 1 and 5 minus 8)', formatINR(totalRepayable)],
      ['10', 'Annual Percentage rate- Effective annualized interest rate (in percentage)', `${apr}%`],
      ['11', 'Schedule of disbursement as per terms and conditions', '100% upfront'],
      ['12', 'Due date of payment of instalment and interest', firstDueDate]
    ];

    drawKfsRows(aprData);
    
    // Repayment Schedule
    doc2.addPage();
    y2 = 50;

    doc2.fontSize(10).fillColor('#1e3a8a').text('Repayment Schedule', 50, y2, { bold: true });
    y2 += 16;

    const repSchedHeaders = ['Instalment No.', 'Outstanding Principal', 'Principal (INR)', 'Interest (INR)', 'Discount (INR)', 'Instalment (INR)'];
    const repSchedWidths = [60, 110, 85, 80, 75, 102];

    doc2.rect(50, y2, 512, 14).fill('#1e3a8a');
    doc2.fillColor('#ffffff').fontSize(7.5);
    let schedX2 = 50;
    repSchedHeaders.forEach((sh, idx) => {
      doc2.text(sh, schedX2 + 4, y2 + 3, { width: repSchedWidths[idx] - 8, align: 'center', bold: true });
      schedX2 += repSchedWidths[idx];
    });
    y2 += 14;

    let outstandingBal = principal;
    doc2.fillColor('#334155').fontSize(7);

    scheduleRows.forEach((row) => {
      doc2.strokeColor('#cbd5e1').lineWidth(0.5);
      doc2.rect(50, y2, 512, 13).stroke();

      const emiVal = parseFloat(row.emi_amount);
      const prinVal = parseFloat(row.principal_amount);
      const intVal = parseFloat(row.interest_amount);

      const cells = [
        row.installment_no,
        formatINR(outstandingBal),
        formatINR(prinVal),
        formatINR(intVal),
        'INR 0.00',
        formatINR(emiVal)
      ];

      let cellX = 50;
      cells.forEach((val, idx) => {
        if (idx > 0) {
          doc2.moveTo(cellX, y2).lineTo(cellX, y2 + 13).stroke();
        }
        doc2.text(String(val), cellX + 4, y2 + 3, { width: repSchedWidths[idx] - 8, align: 'center' });
        cellX += repSchedWidths[idx];
      });

      outstandingBal = Math.max(0, outstandingBal - prinVal);
      y2 += 13;
    });

    y2 += 10;
    doc2.fontSize(7).fillColor('#475569').text('Calculation of interest is done on a monthly basis, number of days in a month being 30 and 360 days in a year.');
    y2 = doc2.y + 14;

    if (y2 > doc2.page.height - 200) {
      doc2.addPage();
      y2 = 50;
    }

    doc2.fontSize(10).fillColor('#1e3a8a').text('Annexure A: Annualized Penal Charge for Overdue Loans', 50, y2, { bold: true });
    y2 += 14;

    y2 = drawLatePaymentMatrix(doc2, y2);
    y2 += 12;

    doc2.fontSize(7).fillColor('#475569').text(`* The above annualized % is computed based on the maximum Late Payment Charges on the upper limit and considering the maximum no of days up to which it shall apply.\nIn case of payment after due date, the Annualised Rate of Interest of ${annualizedROI}% shall be charged till the actual date of payment.`);
    y2 = doc2.y + 14;

    if (y2 > doc2.page.height - 180) {
      doc2.addPage();
      y2 = 50;
    }

    doc2.fontSize(9.5).fillColor('#1e3a8a').text('(b). Bounce Charges', 50, y2, { bold: true });
    y2 += 14;
    doc2.fontSize(7.5).fillColor('#334155').text(`Rs. 150.00/- per installment\n${bounceChargesText}`, 50, y2, { width: 512, align: 'justify' });
    y2 = doc2.y + 20;

    if (y2 > doc2.page.height - 100) {
      doc2.addPage();
      y2 = 50;
    }

    doc2.fontSize(8.5).fillColor('#0f172a').text('Thanking You,\nFor PPOKKET PRIVATE LIMITED', 50, y2, { bold: true });
    y2 += 28;
    doc2.fillColor('#22c55e').text('Digitally Signed', 50, y2);
    y2 += 12;
    doc2.fillColor('#64748b').fontSize(7.5).text(`Digitally Signed by Ppokket Private Limited\nTimestamp: ${new Date(loan.agreement_accepted_at || new Date()).toLocaleString('en-IN')}`, 50, y2);

    // Draw footers on KFS
    const pages2 = doc2._pageBuffer;
    pages2.forEach((_, idx) => {
      doc2.switchToPage(idx);
      drawFooter(doc2);
    });

    doc2.end();
    await new Promise((resolve) => stream2.on('finish', resolve));

    // ==========================================
    // PDF 3: Sanction Letter & MITC
    // ==========================================
    const doc3 = new PDFDocument({ margin: 50, bufferPages: true });
    const stream3 = fs.createWriteStream(pdf3Path);
    doc3.pipe(stream3);

    drawHeader(doc3, 'Sanction Letter & Most Important Terms & Conditions (MITC)');

    let y3 = doc3.y + 10;
    doc3.fontSize(9.5).fillColor('#0f172a');
    doc3.text(`Date: ${agreementDate}`, 50, y3);
    y3 += 14;
    doc3.text(`Name of the Borrower: ${borrowerName}`, 50, y3);
    y3 += 14;
    doc3.text(`Address of the Borrower: ${borrowerAddress}`, 50, y3, { width: 512 });
    y3 += 28;

    doc3.text('Dear Sir/Madam,', 50, y3);
    y3 += 18;
    doc3.text('Sub: Sanction Letter', 50, y3, { bold: true });
    y3 += 18;
    doc3.text(`With reference to your application dated on ${agreementDate} for availing a loan for an amount of ${formatINR(principal)}, we are pleased to sanction the same subject to the terms and conditions as mentioned below and in the loan agreement to be executed.`, 50, y3, { width: 512 });
    y3 += 45;

    doc3.fontSize(11).fillColor('#1e3a8a').text('Particulars & Details', 50, y3, { bold: true });
    y3 += 16;

    const particularsRows = [
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
      ['Insurance charges + GST (if applicable)', 'INR 0'],
      ['Other Product/Services + GST (if applicable)', 'INR 0'],
      ['Repayment Fee', '0.1% of Repayment Amount'],
      ['Foreclosure/Prepayment fee', 'If the borrower opts to foreclose/prepay any installment after the look-up period, a charge of 4.5% of the principal amount prepaid plus GST shall be charged. Foreclosure option is available from the 2nd installment onwards.'],
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

    doc3.rect(50, y3, 512, 16).fill('#1e3a8a');
    doc3.fillColor('#ffffff').fontSize(8.5).text('Particulars', 55, y3 + 4, { bold: true });
    doc3.text('Details', 255, y3 + 4, { bold: true });
    y3 += 16;

    particularsRows.forEach(([key, val]) => {
      const isHeaderRow = val === '';
      const keyHeight = doc3.heightOfString(key, { width: 195 });
      const valHeight = doc3.heightOfString(val, { width: 300 });
      const rowHeight = Math.max(keyHeight, valHeight) + 6;

      if (y3 + rowHeight > doc3.page.height - 80) {
        doc3.addPage();
        y3 = 50;
        doc3.rect(50, y3, 512, 16).fill('#1e3a8a');
        doc3.fillColor('#ffffff').fontSize(8.5).text('Particulars', 55, y3 + 4, { bold: true });
        doc3.text('Details', 255, y3 + 4, { bold: true });
        y3 += 16;
      }

      if (isHeaderRow) {
        doc3.rect(50, y3, 512, rowHeight).fill('#f1f5f9');
        doc3.fillColor('#0f172a').fontSize(8).text(key, 55, y3 + 4, { bold: true, width: 500 });
      } else {
        doc3.strokeColor('#e2e8f0').lineWidth(0.5);
        doc3.rect(50, y3, 512, rowHeight).stroke();
        doc3.moveTo(250, y3).lineTo(250, y3 + rowHeight).stroke();

        doc3.fillColor('#1e293b').fontSize(7.5);
        doc3.text(key, 55, y3 + 3, { width: 190 });
        doc3.text(val, 255, y3 + 3, { width: 295 });
      }
      y3 += rowHeight;
    });

    // Penal Charges table on next page
    doc3.addPage();
    y3 = 50;

    doc3.fontSize(10).fillColor('#1e3a8a').text('Annualized Penal Charges Matrix', 50, y3, { bold: true });
    y3 += 16;
    y3 = drawLatePaymentMatrix(doc3, y3);
    y3 += 12;

    doc3.fontSize(7).fillColor('#475569').text(`* The above annualized % is computed based on the maximum Late Payment Charges on the upper limit and considering the maximum no of days up to which it shall apply.\nIn case of payment after due date, the Annualised Rate of Interest of ${annualizedROI}% shall be charged till the actual date of payment.`);
    y3 = doc3.y + 14;

    if (y3 > doc3.page.height - 180) {
      doc3.addPage();
      y3 = 50;
    }

    doc3.fontSize(9.5).fillColor('#1e3a8a').text('(b). Bounce Charges', 50, y3, { bold: true });
    y3 += 14;
    doc3.fontSize(7.5).fillColor('#334155').text(`Rs. 150.00/- per installment\n${bounceChargesText}`, 50, y3, { width: 512, align: 'justify' });
    y3 = doc3.y + 16;

    // Repayment Schedule
    if (y3 > doc3.page.height - 160) {
      doc3.addPage();
      y3 = 50;
    }

    doc3.fontSize(10).fillColor('#1e3a8a').text('Repayment Schedule', 50, y3, { bold: true });
    y3 += 16;

    const repSchedHeaders3 = ['Sl.', 'Repayment Date', 'Instalment Amount', 'Principal', 'Interest', 'Repayment Fee'];
    const repSchedWidths3 = [40, 110, 100, 90, 80, 92];

    doc3.rect(50, y3, 512, 16).fill('#1e3a8a');
    doc3.fillColor('#ffffff').fontSize(8.5);
    let schedX3 = 50;
    repSchedHeaders3.forEach((sh, idx) => {
      doc3.text(sh, schedX3 + 4, y3 + 4, { width: repSchedWidths3[idx] - 8, align: 'center', bold: true });
      schedX3 += repSchedWidths3[idx];
    });
    y3 += 16;

    doc3.fontSize(8).fillColor('#334155');
    scheduleRows.forEach((row) => {
      doc3.strokeColor('#e2e8f0').lineWidth(0.5);
      doc3.rect(50, y3, 512, 14).stroke();

      const emi = parseFloat(row.emi_amount);
      const repFee = emi * 0.001;

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
          doc3.moveTo(cellX, y3).lineTo(cellX, y3 + 14).stroke();
        }
        doc3.text(String(val), cellX + 4, y3 + 3, { width: repSchedWidths3[idx] - 8, align: 'center' });
        cellX += repSchedWidths3[idx];
      });
      y3 += 14;
    });

    y3 += 10;
    doc3.fontSize(7.5).fillColor('#475569');
    doc3.text('Calculation of interest is done on a monthly basis, number of days in a month being 30 and 360 days in a year.');
    y3 += 14;

    const miscData = [
      ['Charges pursuant to Addendum Agreement', 'As to be agreed in the Addendum Agreement'],
      ['Governing Law and Jurisdiction', 'Kolkata, West Bengal']
    ];

    miscData.forEach(([key, val]) => {
      doc3.fontSize(8.5).fillColor('#0f172a');
      doc3.text(`${key}: `, { bold: true, continued: true });
      doc3.text(val, { bold: false });
      y3 += 14;
    });

    // Terms and Conditions on next page
    doc3.addPage();
    y3 = 50;

    doc3.fontSize(11).fillColor('#1e3a8a').text('Terms & Conditions:', 50, y3, { bold: true });
    y3 += 18;

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

    doc3.fontSize(7).fillColor('#334155');
    terms.forEach(term => {
      if (y3 > doc3.page.height - 40) {
        doc3.addPage();
        y3 = 50;
      }
      doc3.text(term, 50, y3, { width: 512, align: 'justify' });
      y3 += doc3.heightOfString(term, { width: 512 }) + 4;
    });

    // SMA/NPA Classification
    if (y3 > doc3.page.height - 180) {
      doc3.addPage();
      y3 = 50;
    }

    doc3.moveDown(1);
    y3 = doc3.y;
    doc3.fontSize(11).fillColor('#1e3a8a').text('SMA / NPA ASSET CLASSIFICATION', 50, y3, { bold: true });
    y3 += 16;

    doc3.fontSize(7.5).fillColor('#334155').text('Overdue loan accounts shall be classified as Special Mention Accounts (SMA) or Non-performing Assets (NPA) as per RBI regulations indicated below:', 50, y3);
    y3 += 14;

    doc3.rect(50, y3, 512, 14).fill('#1e3a8a');
    doc3.fillColor('#ffffff').fontSize(7.5);
    doc3.text('Overdue Classification', 55, y3 + 3, { bold: true });
    doc3.text('Period', 255, y3 + 3, { bold: true });
    y3 += 14;

    const smaRows = [
      ['SMA-0', 'For a period upto 30 days'],
      ['SMA-1', 'For a period more than 30 days and upto 60 days'],
      ['SMA-2', 'For a period more than 60 days and upto 90 days'],
      ['NPA*', 'For a period more than 90 days']
    ];

    doc3.fillColor('#334155').fontSize(7);
    smaRows.forEach(([cl, prd]) => {
      doc3.strokeColor('#e2e8f0').lineWidth(0.5);
      doc3.rect(50, y3, 512, 12).stroke();
      doc3.moveTo(250, y3).lineTo(250, y3 + 12).stroke();

      doc3.text(cl, 55, y3 + 2);
      doc3.text(prd, 255, y3 + 2);
      y3 += 12;
    });

    y3 += 8;
    doc3.fontSize(7).fillColor('#475569');
    doc3.text('* Upgradation of accounts classified as NPAs: Loan account once classified as NPA can be upgraded as standard only after entire arrears of principal, interest and any other amount are paid by the borrower.');
    
    y3 += 12;
    const illustText = 'Illustration for Classification of borrower\'s account as SMA/NPA: If Due date of a Loan account repayment is March 31, 202X, and full dues are not received by the lender on this date, the date of overdue shall be March 31, 202X. If it continues to remain overdue, then this account shall get tagged as SMA-1 upon the day-end of April 30, 202X (i.e. upon completion of 30 days). Similarly, if it remains overdue, it shall get tagged as SMA-2 upon the day-end of May 30, 202X and NPA upon the day-end of June 30, 202X.';
    doc3.text(illustText, 50, y3, { width: 512, align: 'justify' });
    y3 += doc3.heightOfString(illustText, { width: 512 }) + 14;

    if (y3 > doc3.page.height - 100) {
      doc3.addPage();
      y3 = 50;
    }

    doc3.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, y3).lineTo(562, y3).stroke();
    y3 += 14;

    doc3.fontSize(9.5).fillColor('#1e3a8a').text('Digitally Signed by Ppokket Private Limited', 50, y3, { bold: true });
    y3 += 14;
    doc3.fontSize(8.5).fillColor('#475569').text(`Timestamp: ${new Date(loan.agreement_accepted_at || new Date()).toLocaleString('en-IN')}`, 50, y3);
    doc3.text(`Borrower Digital Consent IP: Verified & Logged via Click-wrap`, 50, y3 + 12);

    // Draw footers on Sanction Letter
    const pages3 = doc3._pageBuffer;
    pages3.forEach((_, idx) => {
      doc3.switchToPage(idx);
      drawFooter(doc3);
    });

    doc3.end();
    await new Promise((resolve) => stream3.on('finish', resolve));

    // ==========================================
    // Send Email with 3 Attachments
    // ==========================================
    const transporter = await getTransporter();
    if (!transporter) {
      console.log('⚠️ Could not create transporter. Skipping email send.');
      return;
    }

    // HTML Repayment Schedule for Email
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
      from: `"Ppokket Private Limited" <${process.env.SMTP_USER || 'support@ppokket.com'}>`,
      replyTo: 'support@ppokket.com',
      to: emailRecipient,
      subject: `Your Loan Documents are Ready — Ppokket (Ref: ${loan.id})`,
      text: `Dear ${borrowerName},\n\nThank you for choosing Ppokket. Your loan documents for Ref ${loan.id} (${formatINR(principal)}, ${term} months) are attached to this email.\n\nKey Details:\n- Principal: ${formatINR(principal)}\n- Interest Rate: ${annualizedROI}% p.a.\n- Processing Fee: ${formatINR(loan.processing_fee)}\n- Total Repayable: ${formatINR(totalRepayable)}\n- APR: ${apr}%\n\nPlease review all three attached PDFs:\n1. Acknowledgement of Loan Application\n2. Key Facts Statement (KFS)\n3. Sanction Letter & MITC\n\nFor support: support@ppokket.com | +91 81780 31447\n\nPpokket Private Limited`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 650px; margin: auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; line-height: 1.6;">
          <div style="text-align: center; margin-bottom: 25px;">
            <h2 style="color: #1e3a8a; margin: 0; font-size: 20px; font-weight: bold; letter-spacing: -0.5px;">PPOKKET PRIVATE LIMITED</h2>
            <p style="font-size: 12px; color: #64748b; margin: 4px 0 0 0;">Partnered with RBI-registered NBFCs</p>
          </div>

          <p style="font-size: 14px;">Date: <strong>${agreementDate}</strong></p>
          <p style="font-size: 14px; margin: 4px 0;">Borrower Name: <strong>${borrowerName}</strong></p>
          <p style="font-size: 14px; margin: 4px 0;">Borrower Address: <span style="color: #475569;">${borrowerAddress}</span></p>
          
          <p style="margin-top: 20px; font-size: 15px;">Dear Sir/Madam,</p>
          <p style="font-size: 15px; font-weight: bold; color: #1e3a8a; margin-top: 5px;">Sub: Digital Loan Documents & Sanction Letter</p>
          
          <p style="font-size: 14px; color: #334155;">
            Thank you for choosing Ppokket. Your withdrawal request for <strong>${formatINR(principal)}</strong> has been successfully registered. In compliance with RBI guidelines, your digitally signed loan agreements have been generated. We have attached the following three critical documents to this email:
          </p>
          
          <ol style="font-size: 13.5px; color: #1e293b; padding-left: 20px;">
            <li><strong>Acknowledgement of Loan Application</strong>: Contains your formal application details and borrower declaration.</li>
            <li><strong>Key Facts Statement (KFS)</strong>: Standardized sheet detailing all interest rates, processing fees, APR, and qualitative disclosures.</li>
            <li><strong>Sanction Letter & MITC</strong>: The official credit approval sheet with complete terms, conditions, and SMA/NPA asset classification guidelines.</li>
          </ol>

          <h3 style="color: #1e3a8a; font-size: 15px; border-bottom: 1.5px solid #1e3a8a; padding-bottom: 5px; margin-top: 25px;">PART-I: KEY FACT STATEMENT (KFS) OVERVIEW</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0;">
            <tr style="background-color: #1e3a8a; color: white;">
              <th style="padding: 8px 12px; text-align: left; border-radius: 4px 0 0 0;">Particulars</th>
              <th style="padding: 8px 12px; text-align: right; border-radius: 0 4px 0 0;">Details</th>
            </tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Principal Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(principal)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Annualized Rate of Interest</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${annualizedROI}% Per Annum</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Annualized Effective Rate of Interest</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${effectiveROI}% Per Annum</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Interest Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(interestAmount)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Loan Term / Repayments</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${term} Months (${term} Installments)</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Processing Fee + GST</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(loan.processing_fee)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Net Disbursed Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(netDisbursal)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;"><td style="padding: 8px 12px; color: #475569;">Total Repayable Amount</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${formatINR(totalRepayable)}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 12px; color: #475569;">Annualized Percentage Rate (APR) %</td><td style="padding: 8px 12px; text-align: right; font-weight: bold; color: #0f172a;">${apr}% Per Annum</td></tr>
          </table>

          <h3 style="color: #1e3a8a; font-size: 15px; border-bottom: 1.5px solid #1e3a8a; padding-bottom: 5px; margin-top: 25px;">LOAN REPAYMENT SCHEDULE</h3>
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

          <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 25px 0;" />

          <p style="font-size: 13px; font-weight: bold; color: #1e3a8a; margin: 0;">Digitally Signed by Ppokket Private Limited</p>
          <p style="font-size: 12px; color: #64748b; margin: 2px 0 0 0;">Timestamp: ${new Date(loan.agreement_accepted_at || new Date()).toLocaleString('en-IN')}</p>
          
          <p style="font-size: 11px; color: #94a3b8; margin-top: 30px; line-height: 1.4;">
            This is an automated notification. Please do not reply directly to this email. For any queries, write to us at support@ppokket.com.
          </p>
        </div>
      `,
      attachments: [
        {
          filename: `1_Acknowledgement_Loan_Ref_${loan.id}.pdf`,
          path: pdf1Path
        },
        {
          filename: `2_Key_Facts_Statement_Loan_Ref_${loan.id}.pdf`,
          path: pdf2Path
        },
        {
          filename: `3_Sanction_Letter_Loan_Ref_${loan.id}.pdf`,
          path: pdf3Path
        }
      ]
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✉️ Loan Agreement Email sent successfully to ${emailRecipient}. MessageId: ${info.messageId}`);
    
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`🔗 Ethereal Email Preview Link: ${previewUrl}`);
    }

    // Delete temp files after sending
    const paths = [pdf1Path, pdf2Path, pdf3Path];
    paths.forEach(p => {
      fs.unlink(p, (err) => {
        if (err) console.error(`Failed to clean up temp PDF file ${p}:`, err);
      });
    });

  } catch (err) {
    console.error('❌ Failed to generate or send loan agreement email:', err);
  }
};

// ==========================================
// Welcome / Registration Email
// ==========================================
const sendWelcomeEmail = async ({ user }) => {
  try {
    if (!user?.email) return;

    const transporter = await getTransporter();
    if (!transporter) {
      console.log('⚠️ No transporter. Skipping welcome email.');
      return;
    }

    const name = user.full_name && user.full_name !== 'Ppokket User' ? user.full_name : 'Valued Customer';
    const from = `"Ppokket Private Limited" <${process.env.SMTP_USER || 'support@ppokket.com'}>`;

    const info = await transporter.sendMail({
      from,
      replyTo: 'support@ppokket.com',
      to: user.email,
      subject: 'Welcome to Ppokket — Your Account is Ready',
      text: `Dear ${name},\n\nWelcome to Ppokket! Your account has been successfully registered.\n\nNext Steps:\n1. Complete Your KYC — Upload PAN, Aadhaar, and bank details to unlock your credit limit.\n2. Check Your Credit Score — Get your free Experian credit score instantly after KYC.\n3. Apply for a Loan — Once your credit limit is assigned, withdraw funds in minutes.\n\nYour login: +91 ${user.mobile} (OTP-based, no password needed)\nReferral Code: ${user.referral_code || '—'}\n\nFor support: support@ppokket.com | WhatsApp: +91 81780 31447\n\nPpokket Private Limited`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; line-height: 1.6;">
          <div style="text-align: center; margin-bottom: 28px;">
            <h2 style="color: #1e3a8a; margin: 0; font-size: 22px; font-weight: bold;">PPOKKET PRIVATE LIMITED</h2>
            <p style="font-size: 12px; color: #64748b; margin: 4px 0 0 0;">Partnered with RBI-registered NBFCs</p>
          </div>

          <p style="font-size: 15px;">Dear <strong>${name}</strong>,</p>

          <p style="font-size: 14px; color: #334155;">
            Welcome to <strong>Ppokket</strong>! Your account has been successfully registered. We are excited to have you on board.
          </p>

          <div style="background: #f0f7ff; border-left: 4px solid #2563eb; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
            <p style="font-size: 14px; font-weight: bold; color: #1e3a8a; margin: 0 0 8px 0;">Getting Started — Next Steps</p>
            <ol style="font-size: 13.5px; color: #334155; padding-left: 18px; margin: 0;">
              <li style="margin-bottom: 6px;"><strong>Complete Your KYC</strong> — Upload PAN, Aadhaar, and bank details to unlock your credit limit.</li>
              <li style="margin-bottom: 6px;"><strong>Check Your Credit Score</strong> — Get your free Experian credit score instantly after KYC.</li>
              <li style="margin-bottom: 6px;"><strong>Apply for a Loan</strong> — Once your credit limit is assigned, withdraw funds in minutes.</li>
            </ol>
          </div>

          <p style="font-size: 14px; color: #334155;">
            Your mobile number <strong>+91 ${user.mobile}</strong> is your Ppokket login. No passwords needed — just verify with OTP anytime.
          </p>

          <div style="background: #f8fafc; border-radius: 8px; padding: 14px 18px; margin: 20px 0; font-size: 13px; color: #475569;">
            <p style="margin: 0 0 4px 0;"><strong>Registered Mobile:</strong> +91 ${user.mobile}</p>
            <p style="margin: 0 0 4px 0;"><strong>Referral Code:</strong> ${user.referral_code || '—'}</p>
            <p style="margin: 0;">Share your referral code with friends to earn credit limit bonuses!</p>
          </div>

          <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 25px 0;" />
          <p style="font-size: 12px; color: #94a3b8;">
            For any queries, reach us at <a href="mailto:support@ppokket.com" style="color: #2563eb;">support@ppokket.com</a> or WhatsApp us at +91 81780 31447.<br/>
            This is an automated email — please do not reply directly.
          </p>
        </div>
      `,
    });

    console.log(`✉️ Welcome email sent to ${user.email}. MessageId: ${info.messageId}`);
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log(`🔗 Ethereal preview: ${previewUrl}`);
  } catch (err) {
    console.error('❌ Failed to send welcome email:', err.message);
  }
};

/**
 * Sends an acknowledgement email to a user who submitted the public contact form.
 */
const sendContactAcknowledgementEmail = async ({ name, email }) => {
  try {
    const transporter = await getTransporter();
    if (!transporter) {
      console.log('⚠️ No transporter. Skipping contact acknowledgement email.');
      return;
    }

    const from = `"Ppokket Private Limited" <${process.env.SMTP_USER || 'support@ppokket.com'}>`;

    const info = await transporter.sendMail({
      from,
      replyTo: 'support@ppokket.com',
      to: email,
      subject: 'We have received your request — Ppokket',
      text: `Dear ${name || 'Customer'},\n\nThank you for reaching out to Ppokket. We have received your request and our team is connecting soon.\n\nFor urgent queries, reach us at support@ppokket.com or WhatsApp us at +91 81780 31447.\n\nPpokket Private Limited`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; line-height: 1.6;">
          <div style="text-align: center; margin-bottom: 28px;">
            <h2 style="color: #1e3a8a; margin: 0; font-size: 22px; font-weight: bold;">PPOKKET PRIVATE LIMITED</h2>
            <p style="font-size: 12px; color: #64748b; margin: 4px 0 0 0;">Partnered with RBI-registered NBFCs</p>
          </div>

          <p style="font-size: 15px;">Dear <strong>${name || 'Customer'}</strong>,</p>

          <p style="font-size: 14px; color: #334155;">
            Thank you for reaching out to <strong>Ppokket</strong>. We have received your request and our team is connecting soon.
          </p>

          <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 25px 0;" />
          <p style="font-size: 12px; color: #94a3b8;">
            For urgent queries, reach us at <a href="mailto:support@ppokket.com" style="color: #2563eb;">support@ppokket.com</a> or WhatsApp us at +91 81780 31447.<br/>
            This is an automated email — please do not reply directly.
          </p>
        </div>
      `,
    });

    console.log(`✉️ Contact acknowledgement email sent to ${email}. MessageId: ${info.messageId}`);
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log(`🔗 Ethereal preview: ${previewUrl}`);
  } catch (err) {
    console.error('❌ Failed to send contact acknowledgement email:', err.message);
  }
};

module.exports = { sendLoanAgreementEmail, sendWelcomeEmail, sendContactAcknowledgementEmail };
