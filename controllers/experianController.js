const { pool } = require('../config/db');
const { fetchExperianReport, parseExperianReport } = require('../utils/experianService');
const { invalidateUserCache } = require('../config/redis');

// Ensure experian_reports table exists
const initExperianTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS experian_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pan VARCHAR(20) NOT NULL,
        mobile VARCHAR(15) NOT NULL,
        name VARCHAR(255) NULL,
        loanId VARCHAR(255) NULL,
        loanType VARCHAR(255) NULL,
        userId INT NULL,
        experianScore INT NULL,
        creditHealth VARCHAR(50) NULL,
        htmlUrl TEXT NULL,
        parsedData JSON NULL,
        rawResponse JSON NULL,
        status VARCHAR(50) DEFAULT 'Fetched',
        apiProvider VARCHAR(50) DEFAULT 'InsightAPI_Experian',
        errorMessage TEXT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (pan),
        INDEX (mobile),
        INDEX (userId),
        INDEX (loanId, loanType)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (err) {
    console.error('❌ Failed to initialize experian_reports table:', err.message || err);
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
// ADMIN: Fetch Experian for a user on demand
// POST /api/admin/experian/fetch/:userId
// ==========================================
const adminFetchExperian = async (req, res) => {
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
      `SELECT * FROM experian_reports 
       WHERE pan = ? AND status = 'Fetched' AND experianScore IS NOT NULL 
       ORDER BY createdAt DESC LIMIT 1`,
      [pan]
    );

    if (cachedRows.length > 0) {
      const cached = cachedRows[0];
      const parsedData = safeParseJSON(cached.parsedData);

      // Update user's credit score in DB if different
      if (user.experian_score !== cached.experianScore) {
        await pool.query(
          `UPDATE users SET experian_score = ?, experian_fetched_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [cached.experianScore, userId]
        );
        await invalidateUserCache(userId);
      }

      // Link report to userId if not set
      if (!cached.userId) {
        await pool.query('UPDATE experian_reports SET userId = ? WHERE id = ?', [userId, cached.id]);
      }

      return res.json({
        success: true,
        fromCache: true,
        data: {
          score: cached.experianScore,
          creditHealth: cached.creditHealth,
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
          accounts: parsedData?.accounts || [],
          summary: parsedData?.summary || {}
        },
        reportId: cached.id
      });
    }

    // Call Experian API
    let rawResponse;
    try {
      rawResponse = await fetchExperianReport({ name, pan, mobile });
    } catch (apiErr) {
      console.error('[Experian API Err]:', apiErr.message);
      return res.status(502).json({
        success: false,
        error: 'Experian service temporarily unavailable. Please try again later.'
      });
    }

    const parsed = parseExperianReport(rawResponse);

    // Save report
    const [insertResult] = await pool.query(
      `INSERT INTO experian_reports (pan, mobile, name, userId, experianScore, creditHealth, htmlUrl, parsedData, rawResponse, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Fetched')`,
      [
        pan,
        mobile,
        name,
        userId,
        parsed.score,
        parsed.creditHealth,
        parsed.htmlUrl,
        JSON.stringify(parsed),
        JSON.stringify(rawResponse)
      ]
    );

    // Update user's credit score
    if (parsed.score) {
      await pool.query(
        `UPDATE users SET experian_score = ?, experian_fetched_at = NOW(), updated_at = NOW() WHERE id = ?`,
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
        accounts: parsed.accounts || [],
        summary: parsed.summary || {}
      },
      reportId: insertResult.insertId
    });

  } catch (error) {
    console.error('[Admin Experian Fetch Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Get saved Experian reports list
// GET /api/admin/experian/reports
// ==========================================
const adminGetReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let countQuery = `SELECT COUNT(*) as count FROM experian_reports er`;
    let selectQuery = `SELECT er.id, er.pan, er.mobile, er.name, er.experianScore, er.creditHealth, er.loanType, er.loanId, er.htmlUrl, er.createdAt, er.status FROM experian_reports er`;

    if (isPartner) {
      countQuery += ` JOIN users u ON u.id = er.userId`;
      selectQuery += ` JOIN users u ON u.id = er.userId`;
    }

    countQuery += ` WHERE er.status = 'Fetched'`;
    selectQuery += ` WHERE er.status = 'Fetched'`;

    const params = [];

    if (isPartner) {
      countQuery += ` AND u.assigned_partner_id = ?`;
      selectQuery += ` AND u.assigned_partner_id = ?`;
      params.push(req.admin.id);
    }

    if (search) {
      const searchWildcard = `%${search}%`;
      const searchCondition = ` AND (er.pan LIKE ? OR er.mobile LIKE ? OR er.name LIKE ?)`;
      countQuery += searchCondition;
      selectQuery += searchCondition;
      params.push(searchWildcard, searchWildcard, searchWildcard);
    }

    selectQuery += ` ORDER BY er.createdAt DESC LIMIT ? OFFSET ?`;
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
    console.error('[Admin Get Experian Reports Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Get full detail of a specific Experian report
// GET /api/admin/experian/reports/:reportId
// ==========================================
const adminGetReportDetail = async (req, res) => {
  try {
    const { reportId } = req.params;
    const [rows] = await pool.query('SELECT * FROM experian_reports WHERE id = ?', [reportId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    const report = rows[0];
    report.parsedData = safeParseJSON(report.parsedData);
    report.rawResponse = safeParseJSON(report.rawResponse);

    res.json({ success: true, data: report });
  } catch (error) {
    console.error('[Admin Experian Detail Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// ADMIN: Delete a report record
// DELETE /api/admin/experian/reports/:reportId
// ==========================================
const adminDeleteReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const [deleteResult] = await pool.query('DELETE FROM experian_reports WHERE id = ?', [reportId]);
    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    res.json({ success: true, message: 'Experian report deleted successfully' });
  } catch (error) {
    console.error('[Admin Experian Delete Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// USER: Check Experian score on demand (authenticated user self-service)
// POST /api/experian/check
// ==========================================
const userCheckExperian = async (req, res) => {
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

    // Cache check
    const [cachedRows] = await pool.query(
      `SELECT * FROM experian_reports 
       WHERE pan = ? AND status = 'Fetched' AND experianScore IS NOT NULL 
       ORDER BY createdAt DESC LIMIT 1`,
      [resolvedPan]
    );

    if (cachedRows.length > 0) {
      const cached = cachedRows[0];
      const parsedData = safeParseJSON(cached.parsedData);

      if (user.experian_score !== cached.experianScore) {
        await pool.query(
          `UPDATE users SET experian_score = ?, experian_fetched_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [cached.experianScore, userId]
        );
        await invalidateUserCache(userId);
      }

      if (!cached.userId) {
        await pool.query('UPDATE experian_reports SET userId = ? WHERE id = ?', [userId, cached.id]);
      }

      return res.json({
        success: true,
        fromCache: true,
        data: {
          score: cached.experianScore,
          creditHealth: cached.creditHealth,
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
          accounts: parsedData?.accounts || [],
          summary: parsedData?.summary || {}
        }
      });
    }

    // Call API
    let rawResponse;
    try {
      rawResponse = await fetchExperianReport({ name: resolvedName, pan: resolvedPan, mobile });
    } catch (apiErr) {
      console.error('[Experian API Err]:', apiErr.message);
      return res.status(502).json({
        success: false,
        error: 'Experian service temporarily unavailable. Please try again later.'
      });
    }

    const parsed = parseExperianReport(rawResponse);

    // Save report
    const [insertResult] = await pool.query(
      `INSERT INTO experian_reports (pan, mobile, name, userId, experianScore, creditHealth, htmlUrl, parsedData, rawResponse, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Fetched')`,
      [
        resolvedPan,
        mobile,
        resolvedName,
        userId,
        parsed.score,
        parsed.creditHealth,
        parsed.htmlUrl,
        JSON.stringify(parsed),
        JSON.stringify(rawResponse)
      ]
    );

    if (parsed.score) {
      await pool.query(
        `UPDATE users SET experian_score = ?, experian_fetched_at = NOW(), updated_at = NOW() WHERE id = ?`,
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
        accounts: parsed.accounts || [],
        summary: parsed.summary || {}
      },
      reportId: insertResult.insertId
    });

  } catch (error) {
    console.error('[User Experian Check Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// USER: Get their latest Experian report details
// GET /api/experian/latest
// ==========================================
const userGetLatestReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRows] = await pool.query('SELECT pan_number FROM users WHERE id = ?', [userId]);
    const user = userRows[0];

    let query = `SELECT * FROM experian_reports WHERE status = 'Fetched' AND experianScore IS NOT NULL`;
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

    if (!report.userId) {
      await pool.query('UPDATE experian_reports SET userId = ? WHERE id = ?', [userId, report.id]);
    }

    res.json({
      success: true,
      data: {
        score: report.experianScore,
        creditHealth: report.creditHealth,
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
        summary: parsedData?.summary || {},
        createdAt: report.createdAt
      }
    });

  } catch (error) {
    console.error('[User Experian Latest Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==========================================
// USER: Delete their own latest Experian report
// DELETE /api/experian/delete
// ==========================================
const userDeleteLatestReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRows] = await pool.query('SELECT pan_number FROM users WHERE id = ?', [userId]);
    const user = userRows[0];

    let query = `DELETE FROM experian_reports`;
    let params = [];

    if (user && user.pan_number) {
      query += ` WHERE userId = ? OR pan = ?`;
      params = [userId, user.pan_number.toUpperCase()];
    } else {
      query += ` WHERE userId = ?`;
      params = [userId];
    }

    const [deleteResult] = await pool.query(query, params);

    await pool.query(
      `UPDATE users SET experian_score = NULL, experian_fetched_at = NULL, updated_at = NOW() WHERE id = ?`,
      [userId]
    );
    await invalidateUserCache(userId);

    res.json({ success: true, message: `${deleteResult.affectedRows} Experian record(s) deleted.` });

  } catch (error) {
    console.error('[User Experian Delete Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  initExperianTable,
  adminFetchExperian,
  adminGetReports,
  adminGetReportDetail,
  adminDeleteReport,
  userCheckExperian,
  userGetLatestReport,
  userDeleteLatestReport
};
