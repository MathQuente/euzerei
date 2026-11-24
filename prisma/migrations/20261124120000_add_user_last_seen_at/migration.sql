-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- Backfill: a última renovação de sessão que ainda existe é o melhor registro que temos.
UPDATE "users" u
SET "last_seen_at" = r.last_seen
FROM (
  SELECT "userId", MAX("createdAt") AS last_seen
  FROM "refresh_token"
  GROUP BY "userId"
) r
WHERE r."userId" = u."id";

-- CreateIndex
CREATE INDEX "refresh_token_userId_idx" ON "refresh_token"("userId");
