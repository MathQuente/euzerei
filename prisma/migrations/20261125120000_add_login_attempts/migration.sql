-- CreateEnum
CREATE TYPE "LoginSource" AS ENUM ('APP', 'PANEL');

-- CreateEnum
CREATE TYPE "LoginOutcome" AS ENUM ('SUCCESS', 'BAD_CREDENTIALS', 'LOCKED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "source" "LoginSource" NOT NULL,
    "outcome" "LoginOutcome" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_attempts_created_at_idx" ON "login_attempts"("created_at");
