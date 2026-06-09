const axios = require('axios');

const INSIGHT_BASE_URL = 'https://api.insightapi.in/api/v1';

/**
 * Fetch CIBIL report from InsightAPI
 * @param {Object} params - { name, pan, mobile, consent }
 * @returns {Promise<Object>} - Raw API response
 */
const fetchCibilReport = async ({ name, pan, mobile, consent = 'Y' }) => {
    const token = process.env.INSIGHT_API_TOKEN;

    if (!token) {
        throw new Error('InsightAPI token not configured. Set INSIGHT_API_TOKEN in .env');
    }

    if (!name || !pan || !mobile) {
        throw new Error('name, pan, and mobile are required for CIBIL report');
    }

    const payload = {
        type: 'json',
        name: name.trim(),
        pan: pan.trim().toUpperCase(),
        mobile: mobile.replace(/\D/g, '').slice(-10), // normalize to 10 digits
        consent: consent || 'Y'
    };

    const response = await axios.post(
        `${INSIGHT_BASE_URL}/cibil`,
        payload,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 second timeout for CIBIL
        }
    );

    return response.data;
};

/**
 * Parse and flatten the raw CIBIL response into a clean summary object
 * @param {Object} rawResponse - Raw response from InsightAPI
 * @returns {Object} - Cleaned summary
 */
const parseCibilReport = (rawResponse) => {
    try {
        let dataObj = rawResponse;
        if (typeof dataObj === 'string') {
            try {
                dataObj = JSON.parse(dataObj);
            } catch (jsonErr) {
                console.error('[InsightAPI] Failed to parse rawResponse string:', jsonErr.message);
                return { score: null, status: 'Invalid JSON String', htmlUrl: null };
            }
        }

        const report = dataObj?.response?.data?.cibilData
            ?.GetCustomerAssetsResponse
            ?.GetCustomerAssetsSuccess
            ?.Asset
            ?.TrueLinkCreditReport;

        if (!report) {
            return {
                score: null,
                status: 'No Data',
                htmlUrl: rawResponse?.response?.data?.htmlUrl || null,
                raw: rawResponse
            };
        }

        const borrower = report?.Borrower || {};
        const creditScore = borrower?.CreditScore || {};
        const borrowerName = borrower?.BorrowerName?.Name?.Forename || '';
        const gender = borrower?.Gender || '';
        const dob = borrower?.Birth?.BirthDate
            ? `${borrower.Birth.BirthDate.year}-${String(borrower.Birth.BirthDate.month).padStart(2,'0')}-${String(borrower.Birth.BirthDate.day).padStart(2,'0')}`
            : null;

        // Score
        const score = parseInt(creditScore?.riskScore) || null;
        const populationRank = parseInt(creditScore?.populationRank) || null;
        const scoreName = creditScore?.scoreName || 'CIBILTransUnionScore3';

        // Helper to handle XML-to-JSON single-element object conversion
        const ensureArray = (val) => {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            return [val];
        };

        // Score factors
        const scoreFactors = ensureArray(creditScore?.CreditScoreFactor)
            .map(f => {
                const factorText = f?.FactorText;
                let text = Array.isArray(factorText) ? factorText[0] : (typeof factorText === 'string' ? factorText : '');
                // Clean prefixes like 'explain: ' or 'factor: '
                text = text.replace(/^(explain:\s*|factor:\s*)/i, '').trim();
                return {
                    code: f?.bureauCode || '',
                    text: text || ''
                };
            })
            // Filter out empty or "No Valid Factors" entries
            .filter(item => item.text && !item.text.toLowerCase().includes('no valid factors'));

        // Addresses
        const addresses = ensureArray(borrower?.BorrowerAddress).map(addr => {
            let rDate = addr?.dateReported || '';
            // Strip timezone offsets like +05:30
            if (rDate && rDate.includes('+')) {
                rDate = rDate.split('+')[0];
            }
            return {
                street: addr?.CreditAddress?.StreetAddress || '',
                postalCode: addr?.CreditAddress?.PostalCode || '',
                region: addr?.CreditAddress?.Region || '',
                reportedDate: rDate,
                source: addr?.Origin?.symbol || ''
            };
        });

        // Phones
        const phones = ensureArray(borrower?.BorrowerTelephone).map(p => ({
            number: p?.PhoneNumber?.Number || '',
            type: p?.PhoneType?.symbol || ''
        }));

        // Emails
        const emails = ensureArray(borrower?.EmailAddress).map(e => e?.Email || (typeof e === 'string' ? e : ''));

        // Employer
        const employer = borrower?.Employer || {};

        // Helper to clean -1 values
        const cleanVal = (val, defaultValue = '-') => {
            if (val === undefined || val === null || val === '-1' || val === -1 || val === '-1.00') {
                return defaultValue;
            }
            return val;
        };

        // Helper to format date strings to DD/MM/YYYY
        const formatDateStr = (dateStr) => {
            if (!dateStr || dateStr === '-') return '-';
            // Handle format YYYYMMDD (e.g., 20210826)
            if (/^\d{8}$/.test(dateStr)) {
                return `${dateStr.slice(6, 8)}/${dateStr.slice(4, 6)}/${dateStr.slice(0, 4)}`;
            }
            // Strip timezone if present (e.g., +05:30)
            let clean = dateStr;
            if (clean.includes('+')) {
                clean = clean.split('+')[0];
            }
            // Handle format YYYY-MM-DD (e.g., 2021-08-26)
            if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
                const parts = clean.split('-');
                return `${parts[2]}/${parts[1]}/${parts[0]}`;
            }
            return clean;
        };

        // Helper to map account type symbols to names
        const getAccountTypeName = (symbol) => {
            const types = {
                '10': 'Credit Card',
                '05': 'Personal Loan',
                '06': 'Consumer Durable Loan',
                '69': 'Short Term Personal Loan',
                '07': 'Home Loan',
                '08': 'Loan Against Property',
                '02': 'Housing Loan',
                '03': 'Property Loan',
                '01': 'Auto/Car Loan',
                '04': 'Business Loan',
                '12': 'Overdraft',
                '52': 'Overdraft'
            };
            return types[symbol] || 'Credit Account';
        };

        let accounts = [];

        if (borrower?.account) {
            accounts = ensureArray(borrower.account).map(item => {
                const isCreditCard = (getAccountTypeName(item.accountType) || '').toLowerCase().includes('card') || item.accountType === '10';
                
                const openDate = formatDateStr(item.dateOpened);
                const closeDate = item.dateClosed ? formatDateStr(item.dateClosed) : null;
                const dateLastPayment = formatDateStr(item.dateOfLastPayment);
                const dateReported = formatDateStr(item.reportedDate);

                return {
                    institutionName: item.memberShortName || 'Unknown Bank',
                    accountType: getAccountTypeName(item.accountType) || 'Credit Account',
                    accountNumber: item.accountNumber || '',
                    ownership: item.ownershipIndicator === '1' ? 'Individual' : (item.ownershipIndicator === '4' ? 'Joint' : 'Individual'),
                    status: item.dateClosed ? 'Closed' : 'Open',
                    openDate,
                    closeDate,
                    currentBalance: parseFloat(item.currentBalance) || 0,
                    highBalance: parseFloat(item.highCreditAmount) || 0,
                    
                    // Detailed CIBIL fields
                    creditLimit: isCreditCard ? (parseFloat(item.creditLimit) >= 0 ? parseFloat(item.creditLimit) : 0) : null,
                    sanctionedAmount: !isCreditCard ? (parseFloat(item.highCreditAmount) >= 0 ? parseFloat(item.highCreditAmount) : 0) : null,
                    cashLimit: parseFloat(item.cashLimit) >= 0 ? parseFloat(item.cashLimit) : 0,
                    amountOverdue: parseFloat(item.amountOverdue) >= 0 ? parseFloat(item.amountOverdue) : 0,
                    rateOfInterest: cleanVal(item.rateOfInterest),
                    repaymentTenure: cleanVal(item.repaymentTenure),
                    emiAmount: cleanVal(item.emiAmount),
                    paymentFrequency: item.paymentFrequency === '03' ? 'Monthly' : (item.paymentFrequency || '-'),
                    actualPaymentAmount: parseFloat(item.actualPaymentAmount) >= 0 ? parseFloat(item.actualPaymentAmount) : 0,
                    dateOfLastPayment: dateLastPayment || '-',
                    dateReported: dateReported || '-',
                    valueofCollateral: cleanVal(item.valueOfCollateral),
                    typeofCollateral: item.collateralType || '-',
                    suitFiled: item.suitFiled || '-',
                    writtenOffAmount: cleanVal(item.writtenOffAmtTotal),
                    writtenOffPrincipal: cleanVal(item.writtenOffAmtPrincipal),
                    settlementAmount: cleanVal(item.settlementAmount),
                    // Payment history (real data)
                    paymentHistory: Array.isArray(item.paymentHistory) ? item.paymentHistory : [],
                    paymentHistStartDateRaw: item.paymentHistStartDate || null,
                    paymentHistEndDateRaw: item.paymentHistEndDate || null,
                    paymentStartDate: formatDateStr(item.paymentHistStartDate),
                    paymentEndDate: formatDateStr(item.paymentHistEndDate)
                };
            });
        } else if (report?.TradeLinePartition) {
            accounts = ensureArray(report.TradeLinePartition).map(item => {
                const tl = item?.Tradeline || {};
                const gt = tl.GrantedTrade || {};
                const payHist = gt.PayStatusHistory || {};
                
                const openDate = formatDateStr(tl.dateOpened);
                const closeDate = tl.dateClosed ? formatDateStr(tl.dateClosed) : null;
                const dateLastPayment = formatDateStr(gt.dateLastPayment);
                const dateReported = formatDateStr(tl.dateReported);

                const isCreditCard = (getAccountTypeName(item.accountTypeSymbol) || item.accountTypeDescription || '').toLowerCase().includes('card');

                return {
                    institutionName: tl.creditorName || 'Unknown Bank',
                    accountType: getAccountTypeName(item.accountTypeSymbol) || item.accountTypeDescription || 'Credit Account',
                    accountNumber: tl.accountNumber || '',
                    ownership: tl.AccountDesignator?.symbol === '1' ? 'Individual' : (tl.AccountDesignator?.description || 'Individual'),
                    status: tl.dateClosed ? 'Closed' : 'Open',
                    openDate,
                    closeDate,
                    currentBalance: parseFloat(tl.currentBalance) || 0,
                    highBalance: parseFloat(tl.highBalance) || 0,
                    
                    // Detailed CIBIL fields
                    creditLimit: isCreditCard ? (parseFloat(gt.CreditLimit) || 0) : null,
                    sanctionedAmount: !isCreditCard ? (parseFloat(tl.highBalance) || 0) : null,
                    cashLimit: parseFloat(gt.CashLimit) || 0,
                    amountOverdue: parseFloat(gt.amountPastDue) || 0,
                    rateOfInterest: cleanVal(gt.interestRate),
                    repaymentTenure: cleanVal(gt.termMonths),
                    emiAmount: cleanVal(gt.EMIAmount),
                    paymentFrequency: gt.PaymentFrequency?.symbol === '03' ? 'Monthly' : (gt.PaymentFrequency?.description || '-'),
                    actualPaymentAmount: parseFloat(gt.actualPaymentAmount) || 0,
                    dateOfLastPayment: dateLastPayment || '-',
                    dateReported: dateReported || '-',
                    valueofCollateral: cleanVal(gt.collateral),
                    typeofCollateral: gt.CollateralType?.description || '-',
                    suitFiled: tl.SuitFiled?.description || '-',
                    writtenOffAmount: cleanVal(tl.writtenOffAmtTotal),
                    writtenOffPrincipal: cleanVal(tl.writtenOffPrincipal),
                    settlementAmount: cleanVal(tl.settlementAmount),
                    paymentHistory: payHist.MonthlyPayStatus 
                        ? ensureArray(payHist.MonthlyPayStatus).map(m => m?.status || '0') 
                        : (payHist.status ? payHist.status.split(',').map(s => s.trim()).filter(s => s !== '') : []),
                    paymentHistStartDateRaw: payHist.startDate ? payHist.startDate.split('+')[0].replace(/-/g, '').slice(0, 8) : null,
                    paymentHistEndDateRaw: payHist.endDate ? payHist.endDate.split('+')[0].replace(/-/g, '').slice(0, 8) : null,
                    paymentStartDate: formatDateStr(payHist.startDate),
                    paymentEndDate: formatDateStr(payHist.endDate)
                };
            });
        }

        const accountCount = accounts.length;

        // Identifiers (PAN, Passport, etc.)
        const identifiers = ensureArray(borrower?.IdentifierPartition?.Identifier).map(id => ({
            type: id?.ID?.IdentifierName || '',
            value: id?.ID?.Id || ''
        }));

        // Credit health classification
        let creditHealth = 'N/A';
        if (score >= 750) creditHealth = 'Excellent';
        else if (score >= 700) creditHealth = 'Good';
        else if (score >= 650) creditHealth = 'Fair';
        else if (score >= 600) creditHealth = 'Poor';
        else if (score) creditHealth = 'Very Poor';

        return {
            score,
            populationRank,
            scoreName,
            creditHealth,
            htmlUrl: rawResponse?.response?.data?.htmlUrl || null,
            fullName: borrowerName,
            gender,
            dob,
            addresses,
            phones,
            emails,
            identifiers,
            employerOccupation: employer?.OccupationCode?.description || '',
            scoreFactors,
            accountCount,
            accounts,
            status: 'Success',
            fetchedAt: new Date().toISOString()
        };
    } catch (err) {
        console.error('[InsightAPI] Parse error:', err.message);
        return {
            score: null,
            status: 'Parse Error',
            htmlUrl: rawResponse?.response?.data?.htmlUrl || null,
            raw: rawResponse
        };
    }
};

module.exports = {
    fetchCibilReport,
    parseCibilReport
};
