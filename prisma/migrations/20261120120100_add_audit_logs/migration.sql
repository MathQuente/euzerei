-- CreateEnum
CREATE TYPE "AuditArea" AS ENUM ('USERS', 'IMPORTS', 'CATALOG', 'MODERATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('OK', 'FAILED');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "area" "AuditArea" NOT NULL,
    "target" TEXT,
    "detail" TEXT,
    "result" "AuditResult" NOT NULL DEFAULT 'OK',
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_area_created_at_idx" ON "audit_logs"("area", "created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
