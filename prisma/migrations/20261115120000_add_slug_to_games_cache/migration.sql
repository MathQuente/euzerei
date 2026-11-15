ALTER TABLE "games_cache" ADD COLUMN "slug" TEXT;

CREATE UNIQUE INDEX "games_cache_slug_key" ON "games_cache"("slug");
