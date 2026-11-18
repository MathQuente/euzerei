-- Quão exata é a data de lançamento guardada (day, month, q1..q4, year, tbd).
-- NULL = desconhecida; o front trata como data exata. As linhas antigas são
-- preenchidas pelo script backfill:release-precision.
ALTER TABLE "games_cache" ADD COLUMN "release_date_precision" TEXT;
