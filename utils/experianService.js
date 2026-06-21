const axios = require('axios');

const INSIGHT_BASE_URL = 'https://api.insightapi.in/api/v1';

/**
 * Fetch Experian report from InsightAPI
 * @param {Object} params - { name, pan, mobile, consent }
 * @returns {Promise<Object>} - Raw API response
 */
const fetchExperianReport = async ({ name, pan, mobile, consent = 'Y' }) => {
    const token = process.env.INSIGHT_API_TOKEN;

    if (!token) {
        throw new Error('InsightAPI token not configured. Set INSIGHT_API_TOKEN in .env');
    }

    if (!name || !pan || !mobile) {
        throw new Error('name, pan, and mobile are required for Experian report');
    }

    const payload = {
        type: 'json',
        name: name.trim(),
        pan: pan.trim().toUpperCase(),
        mobile: mobile.replace(/\D/g, '').slice(-10), // normalize to 10 digits
        consent: consent || 'Y'
    };

    const response = await axios.post(
        `${INSIGHT_BASE_URL}/experianv2`,
        payload,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 second timeout
        }
    );

    return response.data;
};

/**
 * Parse and flatten the raw Experian response into a clean normalized summary object
 * @param {Object} rawResponse - Raw response from InsightAPI
 * @returns {Object} - Cleaned summary
 */
const parseExperianReport = (rawResponse) => {
    try {
        let dataObj = rawResponse;
        if (typeof dataObj === 'string') {
            try {
                dataObj = JSON.parse(dataObj);
            } catch (jsonErr) {
                console.error('[Experian Service] Failed to parse rawResponse string:', jsonErr.message);
                return { score: null, status: 'Invalid JSON String', htmlUrl: null };
            }
        }

        const data = dataObj?.response?.data;
        const report = data?.credit_report;

        const score = data?.credit_score !== undefined ? parseInt(data.credit_score) : null;

        if (!report) {
            return {
                score,
                status: score ? 'Success' : 'No Data',
                htmlUrl: data?.htmlUrl || null,
                raw: rawResponse
            };
        }

        // Helper to ensure array format
        const ensureArray = (val) => {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            return [val];
        };

        // Date formatter helper: YYYYMMDD -> YYYY-MM-DD or DD/MM/YYYY
        const formatDateStr = (dateStr) => {
            if (!dateStr || dateStr === '-') return '-';
            const clean = String(dateStr).trim();
            if (/^\d{8}$/.test(clean)) {
                return `${clean.slice(6, 8)}/${clean.slice(4, 6)}/${clean.slice(0, 4)}`;
            }
            return clean;
        };

        const formatDob = (dobStr) => {
            if (!dobStr) return null;
            const clean = String(dobStr).trim();
            if (/^\d{8}$/.test(clean)) {
                return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
            }
            return clean;
        };

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
            return types[String(symbol)] || 'Credit Account';
        };

        // Extract primary applicant detail
        const appDetails = report?.Current_Application?.Current_Application_Details?.Current_Applicant_Details || {};
        const applicantName = data?.name || [appDetails.First_Name, appDetails.Last_Name].filter(Boolean).join(' ') || '';
        const dob = formatDob(appDetails.Date_Of_Birth_Applicant);
        const gender = appDetails.Gender_Code === '1' ? 'M' : (appDetails.Gender_Code === '2' ? 'F' : '');

        // Gather accounts, addresses, phones, and emails
        let accounts = [];
        const addressSet = new Set();
        const phoneSet = new Set();
        const emailSet = new Set();

        const rawAddresses = [];
        const rawPhones = [];
        const rawEmails = [];

        const caisDetails = ensureArray(report?.CAIS_Account?.CAIS_Account_DETAILS);

        caisDetails.forEach(item => {
            if (!item) return;

            // 1. Gather accounts
            const openDate = formatDateStr(item.Open_Date);
            const closeDate = item.Date_Closed ? formatDateStr(item.Date_Closed) : null;
            const dateLastPayment = formatDateStr(item.Date_of_Last_Payment);
            const dateReported = formatDateStr(item.Date_Reported);

            const isCreditCard = String(item.Account_Type) === '10';

            const history = ensureArray(item.CAIS_Account_History);
            const paymentHistory = history.map(h => h.Days_Past_Due || '0');
            const paymentHistStartDateRaw = history[0] ? `${history[0].Year}${String(history[0].Month).padStart(2, '0')}` : null;
            const paymentStartDate = history[0] ? `${String(history[0].Month).padStart(2, '0')}/${history[0].Year}` : '-';
            const paymentEndDate = history[history.length - 1] ? `${String(history[history.length - 1].Month).padStart(2, '0')}/${history[history.length - 1].Year}` : '-';

            accounts.push({
                institutionName: item.Subscriber_Name || 'Unknown Bank',
                accountType: getAccountTypeName(item.Account_Type) || 'Credit Account',
                accountNumber: item.Account_Number || '',
                ownership: item.AccountHoldertypeCode === '1' ? 'Individual' : (item.AccountHoldertypeCode === '2' || item.AccountHoldertypeCode === '4' ? 'Joint' : 'Individual'),
                status: item.Date_Closed ? 'Closed' : 'Open',
                openDate,
                closeDate,
                currentBalance: parseFloat(item.Current_Balance) || 0,
                highBalance: parseFloat(item.Highest_Credit_or_Original_Loan_Amount) || 0,
                creditLimit: isCreditCard ? (parseFloat(item.Credit_Limit_Amount) || 0) : null,
                sanctionedAmount: !isCreditCard ? (parseFloat(item.Highest_Credit_or_Original_Loan_Amount) || 0) : null,
                cashLimit: 0,
                amountOverdue: parseFloat(item.Amount_Past_Due) || 0,
                rateOfInterest: item.Rate_of_Interest || '-',
                repaymentTenure: item.Repayment_Tenure || '-',
                emiAmount: item.Scheduled_Monthly_Payment_Amount || '-',
                paymentFrequency: item.Terms_Frequency || '-',
                actualPaymentAmount: 0,
                dateOfLastPayment: dateLastPayment || '-',
                dateReported: dateReported || '-',
                valueofCollateral: item.Value_of_Collateral || '-',
                typeofCollateral: item.Type_of_Collateral || '-',
                suitFiled: item.SuitFiled_WilfulDefault || item.SuitFiled_WillfulDefault || item.SuitFiledWillfulDefaultWrittenOffStatus || '-',
                writtenOffAmount: item.Written_Off_Amt_Total || (item.Written_off_Settled_Status === '99' ? item.Highest_Credit_or_Original_Loan_Amount : null) || '-',
                writtenOffPrincipal: item.Written_Off_Amt_Principal || '-',
                settlementAmount: item.Settlement_Amount || '-',
                paymentHistory,
                paymentHistStartDateRaw,
                paymentHistEndDateRaw: history[history.length - 1] ? `${history[history.length - 1].Year}${String(history[history.length - 1].Month).padStart(2, '0')}` : null,
                paymentStartDate,
                paymentEndDate
            });

            // 2. Gather addresses
            ensureArray(item.CAIS_Holder_Address_Details).forEach(addr => {
                if (!addr) return;
                const street = [
                    addr.First_Line_Of_Address_non_normalized,
                    addr.Second_Line_Of_Address_non_normalized,
                    addr.Third_Line_Of_Address_non_normalized
                ].filter(Boolean).map(s => String(s).trim()).join(', ');

                if (street && !addressSet.has(street.toLowerCase())) {
                    addressSet.add(street.toLowerCase());
                    rawAddresses.push({
                        street,
                        postalCode: addr.ZIP_Postal_Code_non_normalized || '',
                        region: addr.City_non_normalized || addr.State_non_normalized || '',
                        reportedDate: formatDateStr(item.Date_Reported),
                        source: addr.Address_indicator_non_normalized || ''
                    });
                }
            });

            // 3. Gather phones & emails
            ensureArray(item.CAIS_Holder_Phone_Details).forEach(p => {
                if (!p) return;
                const phNum = p.Telephone_Number || p.Mobile_Telephone_Number;
                if (phNum && !phoneSet.has(phNum)) {
                    phoneSet.add(phNum);
                    rawPhones.push({
                        number: phNum,
                        type: p.Telephone_Type || 'Mobile'
                    });
                }

                if (p.EMailId && !emailSet.has(p.EMailId.toLowerCase())) {
                    emailSet.add(p.EMailId.toLowerCase());
                    rawEmails.push(p.EMailId.trim());
                }
            });

            // 4. Gather emails from CAIS_Holder_ID_Details
            ensureArray(item.CAIS_Holder_ID_Details).forEach(id => {
                if (id?.EMailId && !emailSet.has(id.EMailId.toLowerCase())) {
                    emailSet.add(id.EMailId.toLowerCase());
                    rawEmails.push(id.EMailId.trim());
                }
            });
        });

        // Add application address if details list is empty
        const appAddr = report?.Current_Application?.Current_Application_Details?.Current_Applicant_Address_Details;
        if (rawAddresses.length === 0 && appAddr) {
            const street = [
                appAddr.FlatNoPlotNoHouseNo,
                appAddr.BldgNoSocietyName,
                appAddr.RoadNoNameAreaLocality
            ].filter(Boolean).map(s => String(s).trim()).join(', ');

            if (street) {
                rawAddresses.push({
                    street,
                    postalCode: appAddr.PINCode || '',
                    region: appAddr.City || appAddr.State || '',
                    reportedDate: formatDateStr(report?.CreditProfileHeader?.ReportDate),
                    source: 'Application'
                });
            }
        }

        const identifiers = [{
            type: 'TaxId',
            value: data?.pan || appDetails.IncomeTaxPan || ''
        }];

        let creditHealth = 'N/A';
        if (score >= 750) creditHealth = 'Excellent';
        else if (score >= 700) creditHealth = 'Good';
        else if (score >= 650) creditHealth = 'Fair';
        else if (score >= 600) creditHealth = 'Poor';
        else if (score) creditHealth = 'Very Poor';

        const caisSummary = report?.CAIS_Account?.CAIS_Summary || {};
        const creditAccount = caisSummary?.Credit_Account || {};
        const totalOutstandingBalance = caisSummary?.Total_Outstanding_Balance || {};

        const summary = {
            creditAccountTotal: parseInt(creditAccount.CreditAccountTotal) || 0,
            creditAccountActive: parseInt(creditAccount.CreditAccountActive) || 0,
            creditAccountDefault: parseInt(creditAccount.CreditAccountDefault) || 0,
            creditAccountClosed: parseInt(creditAccount.CreditAccountClosed) || 0,
            cadSuitFiledCurrentBalance: parseFloat(creditAccount.CADSuitFiledCurrentBalance) || 0,
            outstandingBalanceSecured: parseFloat(totalOutstandingBalance.Outstanding_Balance_Secured) || 0,
            outstandingBalanceSecuredPercentage: parseFloat(totalOutstandingBalance.Outstanding_Balance_Secured_Percentage) || 0,
            outstandingBalanceUnSecured: parseFloat(totalOutstandingBalance.Outstanding_Balance_UnSecured) || 0,
            outstandingBalanceUnSecuredPercentage: parseFloat(totalOutstandingBalance.Outstanding_Balance_UnSecured_Percentage) || 0,
            outstandingBalanceAll: parseFloat(totalOutstandingBalance.Outstanding_Balance_All) || 0
        };

        return {
            score,
            populationRank: null,
            scoreName: 'ExperianScore',
            creditHealth,
            htmlUrl: data?.htmlUrl || null,
            fullName: applicantName,
            gender,
            dob,
            addresses: rawAddresses,
            phones: rawPhones,
            emails: rawEmails,
            identifiers,
            employerOccupation: '',
            scoreFactors: [],
            accountCount: accounts.length,
            accounts,
            summary,
            status: 'Success',
            fetchedAt: new Date().toISOString()
        };

    } catch (err) {
        console.error('[Experian Service] Parse error:', err.message);
        return {
            score: null,
            status: 'Parse Error',
            htmlUrl: rawResponse?.response?.data?.htmlUrl || null,
            raw: rawResponse
        };
    }
};

/**
 * Fetch prefill data from InsightAPI
 * @param {Object} params - { firstName, middleName, lastName, mobileNumber }
 * @returns {Promise<Object>} - Raw API response
 */
const fetchPrefillData = async ({ firstName, middleName = '', lastName, mobileNumber }) => {
    const token = process.env.INSIGHT_API_TOKEN;

    if (!token) {
        throw new Error('InsightAPI token not configured. Set INSIGHT_API_TOKEN in .env');
    }

    if (!firstName || !lastName || !mobileNumber) {
        throw new Error('firstName, lastName, and mobileNumber are required for prefill');
    }

    const payload = {
        firstName: firstName.trim(),
        middleName: (middleName || '').trim(),
        lastName: lastName.trim(),
        mobileNumber: mobileNumber.replace(/\D/g, '').slice(-10) // normalize to 10 digits
    };

    const response = await axios.post(
        `${INSIGHT_BASE_URL}/prefill`,
        payload,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 second timeout
        }
    );

    return response.data;
};

module.exports = {
    fetchExperianReport,
    parseExperianReport,
    fetchPrefillData
};
