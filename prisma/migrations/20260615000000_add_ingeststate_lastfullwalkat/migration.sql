-- Add nullable lastFullWalkAt to drive the incremental early-stop periodic full-walk
-- safety net (PRD §D-7). Additive + nullable: no data touched, no default needed.
ALTER TABLE "IngestState" ADD COLUMN "lastFullWalkAt" DATETIME;
