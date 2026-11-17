-- Jogo com a coroa dentro dos favoritos: no máximo um por pessoa.
ALTER TABLE "user_favorite_games" ADD COLUMN "is_main" BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: o Prisma não o descreve no schema, então um `prisma migrate dev`
-- com banco-sombra vai tratá-lo como diferença e propor um DROP INDEX. Não aceitar.
-- A garantia principal já vem da trava FOR UPDATE do usuário em replaceFavorites
-- e de regravar todas as linhas a cada salvamento; o índice é defesa em profundidade.
CREATE UNIQUE INDEX "user_favorite_games_one_main" ON "user_favorite_games" ("user_id") WHERE "is_main";
