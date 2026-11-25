-- CreateEnum
CREATE TYPE "ImportRunStatus" AS ENUM ('DONE', 'WARNING', 'FAILED');

-- CreateTable
CREATE TABLE "import_runs" (
    "id" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "user_id" TEXT,
    "ref" TEXT NOT NULL,
    "status" "ImportRunStatus" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "games" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_runs_finished_at_idx" ON "import_runs"("finished_at");

-- CreateIndex
CREATE INDEX "import_runs_user_id_idx" ON "import_runs"("user_id");

-- AddForeignKey
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
