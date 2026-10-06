-- ============================================
-- MIGRATION: allow bank_mandates.status = 'inactive'
-- Run this once against an existing Ppokket database.
-- (fresh installs get this via schema.sql directly)
--
-- Bug: the code parks a mandate as 'inactive' when its loan closes
-- (paymentController.applySuccessfulPayment, the nightly job in
-- utils/scheduledJobs.js) and reads that status back to offer "Use Previous
-- Auto-Pay", but schema.sql only ever declared
-- ENUM('pending','active','failed','cancelled'). On a database created from
-- it, that UPDATE either fails outright (strict SQL mode) -- and since it runs
-- inside the transaction that settles the loan's last EMI, a customer who has
-- a mandate gets that settlement rolled back with it -- or silently stores ''
-- (non-strict mode).
--
-- Safe to run on a database that already has the value: MODIFY to the same
-- definition changes nothing.
-- ============================================

ALTER TABLE bank_mandates
  MODIFY COLUMN status ENUM('pending', 'active', 'failed', 'cancelled', 'inactive') DEFAULT 'pending';

-- Rows the old definition left with an empty status were being parked.
UPDATE bank_mandates SET status = 'inactive' WHERE status = '';
