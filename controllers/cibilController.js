const { pool } = require('../config/db');
const { fetchCibilReport, parseCibilReport } = require('../utils/insightApi');
const { invalidateUserCache } = require('../config/redis');

// Ensure cibil_reports table exists
const initCibilTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cibil_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pan VARCHAR(20) NOT NULL,
        mobile VARCHAR(15) NOT NULL,
        name VARCHAR(255) NULL,
        userId INT NULL,
        cibilScore INT NULL,
        creditHealth VARCHAR(50) NULL,
        populationRank INT NULL,
        htmlUrl TEXT NULL,
        parsedData JSON NULL,
        rawResponse JSON NULL,
        status VARCHAR(50) DEFAULT 'Fetched',
        apiProvider VARCHAR(50) DEFAULT 'InsightAPI',
        errorMessage TEXT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (pan),
        INDEX (mobile),
        INDEX (userId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

  } catch (err) {
    console.error('❌ Failed to initialize cibil_reports table details:', err);
    console.error('❌ Failed to initialize cibil_reports table:', err.message || err);
  }
};

// Helper to safely parse JSON field from MySQL row
const safeParseJSON = (data) => {
  if (!data) return null;
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    return data;
  }
};

// ==========================================
// USER: Self-service CIBIL check (authenticated user)
// POST /api/cibil/check
// Body: { name, pan, consent }
// ==========================================
const userCheckCibil = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, pan, consent } = req.body;

    if (!pan) {
      return res.status(400).json({ success: false, error: 'PAN is required' });
    }

    const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!userRows.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const user = userRows[0];

    const resolvedName = name || user.pancardName || user.full_name;
    const mobile = user.mobile;
    const resolvedPan = pan.trim().toUpperCase();

    if (!resolvedName) {
      return res.status(422).json({ success: false, error: 'Name is required. Please update your profile.' });
    }

    // Cache check: same PAN
    const [cachedRows] = await pool.query(
      `SELECT * FROM cibil_reports 
       WHERE pan = ? AND status = 'Fetched' AND cibilScore IS NOT NULL 
       ORDER BY createdAt DESC LIMIT 1`,
      [resolvedPan]
    );

    if (cachedRows.length > 0) {
      const cached = cachedRows[0];
      const parsedData = safeParseJSON(cached.parsedData);

      // Update user's credit score in DB if different
      if (user.credit_score !== cached.cibilScore || user.pan_number !== cached.pan) {
        await pool.query(
          `UPDATE users SET credit_score = ?, pan_number = COALESCE(pan_number, ?), full_name = COALESCE(full_name, ?), updated_at = NOW() WHERE id = ?`,
          [cached.cibilScore, cached.pan, parsedData?.fullName || cached.name, userId]
        );
        await invalidateUserCache(userId);
      }

      // Link report to userId if not set
      if (!cached.userId) {
        await pool.query('UPDATE cibil_reports SET userId = ? WHERE id = ?', [userId, cached.id]);
      }

      return res.json({
        success: true,
        fromCache: true,
        data: {
          score: cached.cibilScore,
          creditHealth: cached.creditHealth,
          populationRank: cached.populationRank,
          htmlUrl: cached.htmlUrl,
          fullName: parsedData?.fullName || cached.name,
          pan: cached.pan,
          addresses: parsedData?.addresses || [],
          phones: parsedData?.phones || [],
          emails: parsedData?.emails || [],
          identifiers: parsedData?.identifiers || [],
          employerOccupation: parsedData?.employerOccupation || '',
          scoreFactors: parsedData?.scoreFactors || [],
          accountCount: parsedData?.accountCount || 0,
          accounts: parsedData?.accounts || []
        }
      });
    }

    // Call InsightAPI
    let rawResponse;
    try {
      rawResponse = await fetchCibilReport({
        name: resolvedName,
        pan: resolvedPan,
        mobile,
        consent: consent || 'Y'
      });
    } catch (apiErr) {
      console.error('[CIBIL API Err]:', apiErr.message);
      return res.status(502).json({
        success: false,
        error: 'CIBIL service temporarily unavailable. Please try again later.'
      });
    }

    const parsed = parseCibilReport(rawResponse);

    // Save report
    const [insertResult] = await pool.query(
      `INSERT INTO cibil_reports (pan, mobile, name, userId, cibilScore, creditHealth, populationRank, htmlUrl, parsedData, rawResponse, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Fetched')`,
      [
        resolvedPan,
        mobile,
        resolvedName,
        userId,
        parsed.score,
        parsed.creditHealth,
        parsed.populationRank,
        parsed.htmlUrl,
        JSON.stringify(parsed),
        JSON.stringify(rawResponse)
      ]
    );

    // Update user's credit score
    if (parsed.score) {
      await pool.query(
        `UPDATE users SET credit_score = ?, pan_number = COALESCE(pan_number, ?), full_name = COALESCE(full_name, ?), updated_at = NOW() WHERE id = ?`,
        [parsed.score, resolvedPan, parsed.fullName || resolvedName, userId]
      );
      await invalidateUserCache(userId);
    }

    res.json({
      success: true,
      fromCache: false,
      data: {
        score: parsed.score,
        creditHealth: parsed.creditHealth,
        populationRank: parsed.populationRank,
        htmlUrl: parsed.htmlUrl,
        fullName: parsed.fullName,
        pan: resolvedPan,
        addresses: parsed.addresses || [],
        phones: parsed.phones || [],
        emails: parsed.emails || [],
        identifiers: parsed.identifiers || [],
        employerOccupation: parsed.employerOccupation || '',
        scoreFactors: parsed.scoreFactors || [],
        accountCount: parsed.accountCount || 0,
        accounts: parsed.accounts || []
      },
      reportId: insertResult.insertId
    });

  } catch (error) {
    console.error('[User CIBIL Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// USER: Get their latest CIBIL report details
// GET /api/cibil/latest
// ==========================================
const userGetLatestReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRows] = await pool.query('SELECT pan_number FROM users WHERE id = ?', [userId]);
    const user = userRows[0];

    let query = `SELECT * FROM cibil_reports WHERE status = 'Fetched' AND cibilScore IS NOT NULL`;
    let params = [];

    if (user && user.pan_number) {
      query += ` AND (userId = ? OR pan = ?)`;
      params = [userId, user.pan_number.toUpperCase()];
    } else {
      query += ` AND userId = ?`;
      params = [userId];
    }
    query += ` ORDER BY createdAt DESC LIMIT 1`;

    const [reportRows] = await pool.query(query, params);

    if (!reportRows.length) {
      return res.json({ success: true, data: null });
    }

    const report = reportRows[0];
    const parsedData = safeParseJSON(report.parsedData);

    // Auto-associate userId if missing
    if (!report.userId) {
      await pool.query('UPDATE cibil_reports SET userId = ? WHERE id = ?', [userId, report.id]);
    }

    res.json({
      success: true,
      data: {
        score: report.cibilScore,
        creditHealth: report.creditHealth,
        populationRank: report.populationRank,
        htmlUrl: report.htmlUrl,
        fullName: parsedData?.fullName || report.name,
        pan: report.pan,
        addresses: parsedData?.addresses || [],
        phones: parsedData?.phones || [],
        emails: parsedData?.emails || [],
        identifiers: parsedData?.identifiers || [],
        employerOccupation: parsedData?.employerOccupation || '',
        scoreFactors: parsedData?.scoreFactors || [],
        accountCount: parsedData?.accountCount || 0,
        accounts: parsedData?.accounts || [],
        createdAt: report.createdAt
      }
    });

  } catch (error) {
    console.error('[User CIBIL Latest Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// USER: Delete their own latest CIBIL report
// DELETE /api/cibil/delete
// ==========================================
const userDeleteLatestReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRows] = await pool.query('SELECT pan_number FROM users WHERE id = ?', [userId]);
    const user = userRows[0];

    let query = `DELETE FROM cibil_reports`;
    let params = [];

    if (user && user.pan_number) {
      query += ` WHERE userId = ? OR pan = ?`;
      params = [userId, user.pan_number.toUpperCase()];
    } else {
      query += ` WHERE userId = ?`;
      params = [userId];
    }

    const [deleteResult] = await pool.query(query, params);

    // Reset credit score in user profile
    await pool.query(
      `UPDATE users SET credit_score = NULL, updated_at = NOW() WHERE id = ?`,
      [userId]
    );
    await invalidateUserCache(userId);

    res.json({ success: true, message: `${deleteResult.affectedRows} CIBIL record(s) deleted.` });

  } catch (error) {
    console.error('[User CIBIL Delete Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Get saved CIBIL reports list
// GET /api/admin/cibil/reports
// ==========================================
const adminGetReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let countQuery = `SELECT COUNT(*) as count FROM cibil_reports cr`;
    let selectQuery = `SELECT cr.id, cr.pan, cr.mobile, cr.name, cr.cibilScore, cr.creditHealth, cr.populationRank, cr.loanType, cr.loanId, cr.htmlUrl, cr.createdAt, cr.status FROM cibil_reports cr`;

    if (isPartner) {
      countQuery += ` JOIN users u ON u.id = cr.userId`;
      selectQuery += ` JOIN users u ON u.id = cr.userId`;
    }

    countQuery += ` WHERE cr.status = 'Fetched'`;
    selectQuery += ` WHERE cr.status = 'Fetched'`;

    const params = [];

    if (isPartner) {
      countQuery += ` AND u.assigned_partner_id = ?`;
      selectQuery += ` AND u.assigned_partner_id = ?`;
      params.push(req.admin.id);
    }

    if (search) {
      const searchWildcard = `%${search}%`;
      const searchCondition = ` AND (cr.pan LIKE ? OR cr.mobile LIKE ? OR cr.name LIKE ?)`;
      countQuery += searchCondition;
      selectQuery += searchCondition;
      params.push(searchWildcard, searchWildcard, searchWildcard);
    }

    selectQuery += ` ORDER BY cr.createdAt DESC LIMIT ? OFFSET ?`;
    const [countRows] = await pool.query(countQuery, params);
    const total = countRows[0].count;

    const [rows] = await pool.query(selectQuery, [...params, limit, offset]);

    res.json({
      success: true,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: rows
    });

  } catch (error) {
    console.error('[Admin Get CIBIL Reports Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Get full detail of a specific CIBIL report
// GET /api/admin/cibil/reports/:reportId
// ==========================================
const adminGetReportDetail = async (req, res) => {
  try {
    const { reportId } = req.params;
    const [rows] = await pool.query('SELECT * FROM cibil_reports WHERE id = ?', [reportId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    const report = rows[0];
    report.parsedData = safeParseJSON(report.parsedData);
    report.rawResponse = safeParseJSON(report.rawResponse);

    res.json({ success: true, data: report });
  } catch (error) {
    console.error('[Admin CIBIL Detail Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Delete a CIBIL report record
// DELETE /api/admin/cibil/reports/:reportId
// ==========================================
const adminDeleteReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const [deleteResult] = await pool.query('DELETE FROM cibil_reports WHERE id = ?', [reportId]);
    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    res.json({ success: true, message: 'CIBIL report deleted successfully' });
  } catch (error) {
    console.error('[Admin CIBIL Delete Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Fetch CIBIL for a user on demand
// POST /api/admin/cibil/fetch/:userId
// ==========================================
const adminFetchCibil = async (req, res) => {
  try {
    const { userId } = req.params;

    const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!userRows.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const user = userRows[0];

    const name = (user.pancardName || user.full_name || '').trim();
    const pan = (user.pan_number || '').trim().toUpperCase();
    const mobile = user.mobile;

    if (!name) {
      return res.status(422).json({ success: false, error: 'User name is missing. Full name is required.' });
    }
    if (!pan) {
      return res.status(422).json({ success: false, error: 'PAN is missing. PAN card is required.' });
    }

    // Cache check: same PAN
    const [cachedRows] = await pool.query(
      `SELECT * FROM cibil_reports 
       WHERE pan = ? AND status = 'Fetched' AND cibilScore IS NOT NULL 
       ORDER BY createdAt DESC LIMIT 1`,
      [pan]
    );

    if (cachedRows.length > 0) {
      const cached = cachedRows[0];
      const parsedData = safeParseJSON(cached.parsedData);

      // Update user's credit score in DB if different
      if (user.credit_score !== cached.cibilScore) {
        await pool.query(
          `UPDATE users SET credit_score = ?, updated_at = NOW() WHERE id = ?`,
          [cached.cibilScore, userId]
        );
        await invalidateUserCache(userId);
      }

      // Link report to userId if not set
      if (!cached.userId) {
        await pool.query('UPDATE cibil_reports SET userId = ? WHERE id = ?', [userId, cached.id]);
      }

      return res.json({
        success: true,
        fromCache: true,
        data: {
          score: cached.cibilScore,
          creditHealth: cached.creditHealth,
          populationRank: cached.populationRank,
          htmlUrl: cached.htmlUrl,
          fullName: parsedData?.fullName || cached.name,
          pan: cached.pan,
          addresses: parsedData?.addresses || [],
          phones: parsedData?.phones || [],
          emails: parsedData?.emails || [],
          identifiers: parsedData?.identifiers || [],
          employerOccupation: parsedData?.employerOccupation || '',
          scoreFactors: parsedData?.scoreFactors || [],
          accountCount: parsedData?.accountCount || 0,
          accounts: parsedData?.accounts || []
        },
        reportId: cached.id
      });
    }

    // Call CIBIL API
    let rawResponse;
    try {
      rawResponse = await fetchCibilReport({
        name,
        pan,
        mobile,
        consent: 'Y'
      });
    } catch (apiErr) {
      console.error('[CIBIL API Err]:', apiErr.message);
      return res.status(502).json({
        success: false,
        error: 'CIBIL service temporarily unavailable. Please try again later.'
      });
    }

    const parsed = parseCibilReport(rawResponse);

    // Save report
    const [insertResult] = await pool.query(
      `INSERT INTO cibil_reports (pan, mobile, name, userId, cibilScore, creditHealth, populationRank, htmlUrl, parsedData, rawResponse, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Fetched')`,
      [
        pan,
        mobile,
        name,
        userId,
        parsed.score,
        parsed.creditHealth,
        parsed.populationRank,
        parsed.htmlUrl,
        JSON.stringify(parsed),
        JSON.stringify(rawResponse)
      ]
    );

    // Update user's credit score
    if (parsed.score) {
      await pool.query(
        `UPDATE users SET credit_score = ?, updated_at = NOW() WHERE id = ?`,
        [parsed.score, userId]
      );
      await invalidateUserCache(userId);
    }

    res.json({
      success: true,
      fromCache: false,
      data: {
        score: parsed.score,
        creditHealth: parsed.creditHealth,
        populationRank: parsed.populationRank,
        htmlUrl: parsed.htmlUrl,
        fullName: parsed.fullName,
        pan,
        addresses: parsed.addresses || [],
        phones: parsed.phones || [],
        emails: parsed.emails || [],
        identifiers: parsed.identifiers || [],
        employerOccupation: parsed.employerOccupation || '',
        scoreFactors: parsed.scoreFactors || [],
        accountCount: parsed.accountCount || 0,
        accounts: parsed.accounts || []
      },
      reportId: insertResult.insertId
    });

  } catch (error) {
    console.error('[Admin CIBIL Fetch Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  initCibilTable,
  userCheckCibil,
  userGetLatestReport,
  userDeleteLatestReport,
  adminGetReports,
  adminGetReportDetail,
  adminDeleteReport,
  adminFetchCibil
};

