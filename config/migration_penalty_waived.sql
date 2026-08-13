-- ============================================
-- MIGRATION: Add missing emi_schedule.penalty_waived column
-- Run this once against an existing Ppokket database.
-- (fresh installs get this column via schema.sql directly)
--
-- Bug: utils/scheduledJobs.js (markOverdueAndCalcPenalty, the nightly
-- 00:05 cron job) and utils/loanUtils.js (calculatePenalty) both read/filter
-- on emi_schedule.penalty_waived, but the column was never added to
-- schema.sql or any prior migration. Every nightly run threw "Unknown
-- column 'e.penalty_waived'" on the overdue-EMI SELECT, which rolled back
-- the whole transaction -- including the UPDATE that marks EMIs 'overdue'.
-- Net effect: EMIs never transitioned to overdue and no late-payment
-- penalty was ever calculated.
-- ============================================

ALTER TABLE emi_schedule
  ADD COLUMN penalty_waived TINYINT(1) DEFAULT 0 AFTER penalty_days;
