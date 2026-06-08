-- CreateTable
CREATE TABLE "IngestState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "lastCursor" TEXT,
    "lastRunAt" DATETIME,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "IngestState_source_key" ON "IngestState"("source");
