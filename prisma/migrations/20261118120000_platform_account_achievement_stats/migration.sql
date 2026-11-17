-- Totais de conquistas por conta de loja. Só colunas nulas: sem reescrita da
-- tabela e sem backfill (preenchem na próxima importação de cada conta).
ALTER TABLE "platform_accounts"
  ADD COLUMN "achievements_earned" INTEGER,
  ADD COLUMN "gamerscore" INTEGER,
  ADD COLUMN "platinum_trophies" INTEGER,
  ADD COLUMN "stats_synced_at" TIMESTAMP(3);
