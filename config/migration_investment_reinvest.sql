-- ============================================
-- MIGRATION: Reinvest a matured investment
-- Run this once against an existing Ppokket database.
-- (fresh installs get the same columns via schema.sql directly)
--
-- At maturity an investment is no longer paid out automatically. The user
-- chooses between withdrawing it (paid to their bank account after an admin
-- approves) and reinvesting it. Reinvesting closes the matured investment as
-- 'reinvested' and opens a new active one for the full maturity amount, which
-- points back at the old one through reinvested_from_id.
--
-- Until this has been run the app and website simply don't offer "Reinvest"
-- (the API reports can_reinvest = false); withdrawals work as before.
-- ============================================

ALTER TABLE investments
  MODIFY COLUMN status ENUM('pending','active','withdrawal_requested','matured','cancelled','withdrawn','reinvested') DEFAULT 'pending';

ALTER TABLE investments
  ADD COLUMN reinvested_from_id INT DEFAULT NULL AFTER payout_transaction_id;

CREATE INDEX idx_investments_reinvested_from ON investments(reinvested_from_id);
