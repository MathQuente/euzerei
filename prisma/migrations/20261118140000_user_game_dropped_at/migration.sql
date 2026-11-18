-- Quando o jogo foi largado. Coluna nula (sem reescrita da tabela). Os jogos que
-- já estão em Larguei (status 6) ganham updated_at, a melhor estimativa que existe.
ALTER TABLE "user_games" ADD COLUMN "dropped_at" TIMESTAMP(3);

UPDATE "user_games" SET "dropped_at" = "updated_at" WHERE "user_games_status_id" = 6;
