-- CreateTable
CREATE TABLE "user_favorite_games" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "igdb_id" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_favorite_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_favorite_games_user_id_igdb_id_key" ON "user_favorite_games"("user_id", "igdb_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_favorite_games_user_id_position_key" ON "user_favorite_games"("user_id", "position");

-- AddForeignKey
ALTER TABLE "user_favorite_games" ADD CONSTRAINT "user_favorite_games_user_id_igdb_id_fkey" FOREIGN KEY ("user_id", "igdb_id") REFERENCES "user_games"("user_id", "igdb_id") ON DELETE CASCADE ON UPDATE CASCADE;
