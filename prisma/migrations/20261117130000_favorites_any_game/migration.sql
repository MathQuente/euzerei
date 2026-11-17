-- DropForeignKey
ALTER TABLE "user_favorite_games" DROP CONSTRAINT "user_favorite_games_user_id_igdb_id_fkey";

-- AddForeignKey
ALTER TABLE "user_favorite_games" ADD CONSTRAINT "user_favorite_games_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
