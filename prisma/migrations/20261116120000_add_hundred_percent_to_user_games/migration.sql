-- Marca de jogo concluído a 100% (todas as conquistas). A importação da Steam
-- liga sozinha; o usuário liga e desliga à mão, e a vontade dele trava a marca
-- (hundred_percent_locked), como já é feito com endless/endless_locked.
ALTER TABLE "user_games" ADD COLUMN "hundred_percent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_games" ADD COLUMN "hundred_percent_locked" BOOLEAN NOT NULL DEFAULT false;
