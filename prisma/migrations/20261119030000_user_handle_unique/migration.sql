-- Todo user_name vira um handle único (minúsculas, números, _ e -, 3 a 30
-- caracteres) antes de a coluna ficar obrigatória e única. A conversão vive
-- aqui, e não em script, porque o container roda `prisma migrate deploy` ao
-- subir: o banco tem de ficar válido na mesma migração.
--
-- Quem criou a conta primeiro fica com o nome limpo; os repetidos ganham
-- `-2`, `-3`… O regex e a lista de reservados espelham src/utils/user-handle.ts.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  cand TEXT;
  n INT;
  reserved TEXT[] := ARRAY[
    'me', 'roulette', 'favorites', 'usergames', 'featuredgames', 'gamestatus',
    'games', 'endless', 'hundred-percent', 'platforms', 'playedcount',
    'hoursplayed', 'completedat', 'image-upload-signature', 'handle-available',
    'steam', 'psn', 'xbox', 'suggestions', 'followers', 'following', 'admin',
    'api', 'null', 'undefined'
  ];
BEGIN
  CREATE TEMP TABLE _handles (h TEXT PRIMARY KEY) ON COMMIT DROP;

  FOR r IN SELECT id, user_name FROM users ORDER BY created_at ASC, id ASC LOOP
    base := lower(translate(
      coalesce(r.user_name, ''),
      'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ',
      'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy'
    ));
    base := regexp_replace(base, '\s+', '', 'g');
    base := regexp_replace(base, '[^a-z0-9_-]+', '-', 'g');
    base := regexp_replace(left(regexp_replace(base, '^[-_]+|[-_]+$', '', 'g'), 30), '[-_]+$', '');
    IF length(base) < 3 THEN
      base := regexp_replace('usuario-' || base, '[-_]+$', '');
    END IF;

    cand := base;
    n := 1;
    WHILE cand = ANY(reserved) OR EXISTS (SELECT 1 FROM _handles WHERE h = cand) LOOP
      n := n + 1;
      cand := regexp_replace(left(base, 30 - length(n::text) - 1), '[-_]+$', '') || '-' || n::text;
    END LOOP;

    INSERT INTO _handles (h) VALUES (cand);
    UPDATE users SET user_name = cand WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE "users" ALTER COLUMN "user_name" SET NOT NULL;

CREATE UNIQUE INDEX "users_user_name_key" ON "users"("user_name");
