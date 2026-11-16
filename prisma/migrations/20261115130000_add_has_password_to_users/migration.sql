-- Indica se a conta tem uma senha de verdade. Contas criadas ou vinculadas por
-- Google/Discord guardam uma senha aleatória descartada, então o campo não dá
-- para deduzir de google_id/discord_id.
ALTER TABLE "users" ADD COLUMN "has_password" BOOLEAN NOT NULL DEFAULT true;

-- Aproximação para as contas existentes: quem já tem um provedor vinculado
-- tinha a senha descartada. Quem redefiniu a senha depois aparece como "sem
-- senha" e só vê a opção de definir uma, o que é inofensivo.
UPDATE "users" SET "has_password" = false
WHERE "google_id" IS NOT NULL OR "discord_id" IS NOT NULL;
