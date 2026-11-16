-- Indica se a conta tem uma senha de verdade. Contas criadas ou vinculadas por
-- Google/Discord depois desta migration guardam uma senha aleatória descartada
-- e ficam com false.
--
-- As contas que já existem começam todas com true: não dá para saber quais
-- tinham a senha descartada (quem a redefiniu depois tem uma senha de verdade),
-- e tratar uma conta com senha como "sem senha" dispensaria a senha atual.
-- Quem entrou só por Google ou Discord e não conhece a senha usa "Esqueci a
-- senha", que define uma senha por e-mail.
ALTER TABLE "users" ADD COLUMN "has_password" BOOLEAN NOT NULL DEFAULT true;
