const { pool } = require('../config/db');

// Follow-up work on a lead: a history of notes / stage changes (who, when,
// what) and the next follow-up date. Written by the DSA / Bank partner the
// lead is assigned to, and by admins; the super admin sees all of it.
//
// Two tables of their own, created by the first save (CREATE TABLE IF NOT
// EXISTS, no foreign keys) — nothing about the existing tables changes and
// nobody has to run SQL. Reads never throw: no table yet = no history.
//
// users.lead_status stays the lead's stage and users.dsa_custom_status keeps
// the latest note, so the pages that already show those keep working.

const LEAD_STATUSES = ['new', 'contacted', 'docs_submitted', 'kyc_pending', 'kyc_done', 'loan_applied', 'converted', 'inactive'];

const CREATE_ACTIVITY_SQL = `
  CREATE TABLE IF NOT EXISTS lead_activity (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    admin_id         INT NULL,
    admin_name       VARCHAR(150) NULL,
    admin_role       VARCHAR(30) NULL,
    note             TEXT NULL,
    from_status      VARCHAR(30) NULL,
    to_status        VARCHAR(30) NULL,
    follow_up_at     DATETIME NULL,
    follow_up_action VARCHAR(10) NULL,
    created_at       DATETIME NOT NULL,
    INDEX idx_lead_activity_user (user_id, created_at),
    INDEX idx_lead_activity_role (admin_role, id),
    INDEX idx_lead_activity_admin (admin_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

// One row per lead that has a follow-up waiting
const CREATE_FOLLOW_UPS_SQL = `
  CREATE TABLE IF NOT EXISTS lead_follow_ups (
    user_id      INT NOT NULL PRIMARY KEY,
    follow_up_at DATETIME NOT NULL,
    note         VARCHAR(255) NULL,
    set_by       INT NULL,
    updated_at   DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

let tablesReady = false;
const ensureTables = async (conn = pool) => {
  if (tablesReady) return;
  await conn.query(CREATE_ACTIVITY_SQL);
  await conn.query(CREATE_FOLLOW_UPS_SQL);
  tablesReady = true;
};

const MAX_NOTE = 1000;

// Newest first
const getActivity = async (userId, limit = 200) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, admin_id, admin_name, admin_role, note, from_status, to_status,
              follow_up_at, follow_up_action, created_at
         FROM lead_activity WHERE user_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [userId, limit]
    );
    return rows;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
};

const getFollowUp = async (userId) => {
  try {
    const [[row]] = await pool.query('SELECT follow_up_at AS at, note FROM lead_follow_ups WHERE user_id = ?', [userId]);
    return row || null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
};

// Adds `follow_up` ({ at, note } or null) and `last_activity_at` to each row.
// Never throws: a list must not fail because of this.
const attachLeadActivity = async (rows, idKey = 'id') => {
  for (const row of rows) { row.follow_up = null; row.last_activity_at = null; }
  const ids = [...new Set(rows.map(r => r[idKey]).filter(Boolean))];
  if (!ids.length) return rows;
  // A long list (super admin, every customer): read the small tables whole
  const many = ids.length > 1000;
  try {
    const [follow] = await pool.query(
      `SELECT user_id, follow_up_at AS at, note FROM lead_follow_ups${many ? '' : ' WHERE user_id IN (?)'}`,
      many ? [] : [ids]
    );
    const [last] = await pool.query(
      `SELECT user_id, MAX(created_at) AS last_at FROM lead_activity${many ? '' : ' WHERE user_id IN (?)'} GROUP BY user_id`,
      many ? [] : [ids]
    );
    const followBy = new Map(follow.map(f => [f.user_id, { at: f.at, note: f.note }]));
    const lastBy = new Map(last.map(l => [l.user_id, l.last_at]));
    for (const row of rows) {
      row.follow_up = followBy.get(row[idKey]) || null;
      row.last_activity_at = lastBy.get(row[idKey]) || null;
    }
  } catch (err) {
    if (!isMissingTable(err)) console.error('[leadActivity] attach failed:', err.message);
  }
  return rows;
};

// Checks the body of a lead update. Returns { error } or the cleaned values.
//   lead_status      — new stage (ignored when it is the current one)
//   note             — free text
//   follow_up_at     — ISO date-time of the next follow-up
//   follow_up_done   — the waiting follow-up was done (clears it)
//   clear_follow_up  — drop the waiting follow-up without doing it
const readLeadUpdate = (body, currentStatus) => {
  const out = { toStatus: null, note: '', followUpAt: null, followUpAction: null };
  const b = body || {};

  if (b.lead_status !== undefined && b.lead_status !== null && b.lead_status !== '') {
    if (!LEAD_STATUSES.includes(b.lead_status)) return { error: 'Invalid lead stage' };
    if (b.lead_status !== (currentStatus || 'new')) out.toStatus = b.lead_status;
  }

  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') return { error: 'Note must be text' };
    out.note = b.note.trim();
    if (out.note.length > MAX_NOTE) return { error: `Note is too long (max ${MAX_NOTE} characters)` };
  }

  if (b.follow_up_at) {
    const at = new Date(b.follow_up_at);
    if (!Number.isFinite(at.getTime())) return { error: 'Follow-up date is not valid' };
    const now = Date.now();
    if (at.getTime() < now - 24 * 3600 * 1000) return { error: 'Follow-up date is in the past' };
    if (at.getTime() > now + 366 * 24 * 3600 * 1000) return { error: 'Follow-up date is more than a year away' };
    out.followUpAt = at;
    // "done" and the next one set in the same update
    out.followUpAction = b.follow_up_done ? 'done_set' : 'set';
  } else if (b.follow_up_done) {
    out.followUpAction = 'done';
  } else if (b.clear_follow_up) {
    out.followUpAction = 'cleared';
  }

  if (!out.toStatus && !out.note && !out.followUpAction) return { error: 'Nothing to save' };
  return out;
};

// Saves one update (stage / note / follow-up) and its history row together.
const saveLeadUpdate = async ({ userId, admin, currentStatus, update }) => {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (update.toStatus) {
      await conn.query('UPDATE users SET lead_status = ? WHERE id = ?', [update.toStatus, userId]);
    }
    if (update.note) {
      // Latest note, shown where the old "custom status" was shown
      await conn.query('UPDATE users SET dsa_custom_status = ? WHERE id = ?', [update.note.slice(0, 255), userId]);
    }
    if (update.followUpAction === 'set' || update.followUpAction === 'done_set') {
      await conn.query(
        `INSERT INTO lead_follow_ups (user_id, follow_up_at, note, set_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE follow_up_at = VALUES(follow_up_at), note = VALUES(note), set_by = VALUES(set_by), updated_at = VALUES(updated_at)`,
        [userId, update.followUpAt, update.note ? update.note.slice(0, 255) : null, admin.id, new Date()]
      );
    } else if (update.followUpAction === 'done' || update.followUpAction === 'cleared') {
      await conn.query('DELETE FROM lead_follow_ups WHERE user_id = ?', [userId]);
    }
    await conn.query(
      `INSERT INTO lead_activity
         (user_id, admin_id, admin_name, admin_role, note, from_status, to_status, follow_up_at, follow_up_action, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, admin.id, admin.name || null, admin.role || null,
        update.note || null,
        update.toStatus ? (currentStatus || 'new') : null, update.toStatus,
        update.followUpAt, update.followUpAction, new Date(),
      ]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
};

// ── What the super admin sees of the partners' work ──────────────────────────
const PARTNER_ROLES_SQL = "('dsa_partner', 'bank_partner')";

// Midnight in India, `offsetDays` from today (dates are stored in IST)
const istDayStart = (offsetDays = 0) => {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000);
};

const PERIODS = { today: 0, '7d': -6, '30d': -29 };
const TYPES = {
  stage:     'a.to_status IS NOT NULL',
  note:      "a.note IS NOT NULL AND a.note <> ''",
  follow_up: 'a.follow_up_action IS NOT NULL',
};

// Newest first. filters: { who: 'partners' | 'all', authorId, period, type, beforeId, limit }
const listLeadUpdates = async ({ who = 'partners', authorId, period, type, beforeId, limit = 50 } = {}) => {
  const where = [];
  const params = [];
  if (who !== 'all') where.push(`a.admin_role IN ${PARTNER_ROLES_SQL}`);
  if (authorId) { where.push('a.admin_id = ?'); params.push(authorId); }
  if (PERIODS[period] !== undefined) { where.push('a.created_at >= ?'); params.push(istDayStart(PERIODS[period])); }
  if (TYPES[type]) where.push(TYPES[type]);
  if (beforeId) { where.push('a.id < ?'); params.push(beforeId); }
  const size = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.user_id, a.admin_id, a.admin_name, a.admin_role, a.note, a.from_status, a.to_status,
              a.follow_up_at, a.follow_up_action, a.created_at,
              u.full_name AS lead_name, u.mobile AS lead_mobile, u.lead_status AS current_status,
              u.assigned_partner_id, p.name AS partner_name, p.role AS partner_role
         FROM lead_activity a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN admins p ON p.id = u.assigned_partner_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.id DESC
        LIMIT ?`,
      [...params, size + 1]
    );
    const more = rows.length > size;
    const updates = more ? rows.slice(0, size) : rows;
    return { updates, next_before_id: more ? updates[updates.length - 1].id : null };
  } catch (err) {
    if (isMissingTable(err)) return { updates: [], next_before_id: null };
    throw err;
  }
};

// For the badge: partner updates after `afterId` (none given: today's), and the newest id
const leadUpdatesCount = async (afterId) => {
  try {
    const [[latest]] = await pool.query(`SELECT MAX(id) AS id FROM lead_activity WHERE admin_role IN ${PARTNER_ROLES_SQL}`);
    const [[count]] = afterId
      ? await pool.query(`SELECT COUNT(*) AS n FROM lead_activity WHERE admin_role IN ${PARTNER_ROLES_SQL} AND id > ?`, [afterId])
      : await pool.query(`SELECT COUNT(*) AS n FROM lead_activity WHERE admin_role IN ${PARTNER_ROLES_SQL} AND created_at >= ?`, [istDayStart(0)]);
    return { new_count: Number(count.n || 0), latest_id: latest.id || 0 };
  } catch (err) {
    if (isMissingTable(err)) return { new_count: 0, latest_id: 0 };
    throw err;
  }
};

// One row per DSA / Bank partner account: how much they are working their leads
const partnerWorkSummary = async () => {
  const [partners] = await pool.query(
    `SELECT id, name, email, role, is_active, last_login FROM admins WHERE role IN ${PARTNER_ROLES_SQL} ORDER BY name`
  );
  if (!partners.length) return [];
  const [leads] = await pool.query(
    `SELECT assigned_partner_id AS pid, COUNT(*) AS total, SUM(lead_status = 'converted') AS converted
       FROM users WHERE assigned_partner_id IS NOT NULL GROUP BY assigned_partner_id`
  );
  const today = istDayStart(0), weekAgo = istDayStart(-6), tomorrow = istDayStart(1);
  let work = [], follow = [];
  try {
    [work] = await pool.query(
      `SELECT admin_id, SUM(created_at >= ?) AS today, SUM(created_at >= ?) AS week, MAX(created_at) AS last_at
         FROM lead_activity WHERE admin_role IN ${PARTNER_ROLES_SQL} GROUP BY admin_id`,
      [today, weekAgo]
    );
    [follow] = await pool.query(
      `SELECT u.assigned_partner_id AS pid, SUM(f.follow_up_at < ?) AS overdue,
              SUM(f.follow_up_at >= ? AND f.follow_up_at < ?) AS due_today
         FROM lead_follow_ups f JOIN users u ON u.id = f.user_id
        WHERE u.assigned_partner_id IS NOT NULL GROUP BY u.assigned_partner_id`,
      [today, today, tomorrow]
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  const by = (rows, key) => new Map(rows.map(r => [r[key], r]));
  const leadsBy = by(leads, 'pid'), workBy = by(work, 'admin_id'), followBy = by(follow, 'pid');
  return partners.map(p => ({
    id: p.id, name: p.name, email: p.email, role: p.role, is_active: p.is_active, last_login: p.last_login,
    leads: Number(leadsBy.get(p.id)?.total || 0),
    converted: Number(leadsBy.get(p.id)?.converted || 0),
    updates_today: Number(workBy.get(p.id)?.today || 0),
    updates_week: Number(workBy.get(p.id)?.week || 0),
    last_update_at: workBy.get(p.id)?.last_at || null,
    follow_ups_overdue: Number(followBy.get(p.id)?.overdue || 0),
    follow_ups_today: Number(followBy.get(p.id)?.due_today || 0),
  }));
};

module.exports = {
  LEAD_STATUSES, getActivity, getFollowUp, attachLeadActivity, readLeadUpdate, saveLeadUpdate,
  listLeadUpdates, leadUpdatesCount, partnerWorkSummary,
};
