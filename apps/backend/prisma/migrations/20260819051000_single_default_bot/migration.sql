WITH ranked_defaults AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN "status" = 'ACTIVE' THEN 0 ELSE 1 END,
        "created_at" ASC,
        "id" ASC
    ) AS position
  FROM "telegram_bots"
  WHERE "is_default" = true
)
UPDATE "telegram_bots" AS bot
SET "is_default" = false
FROM ranked_defaults
WHERE bot."id" = ranked_defaults."id"
  AND ranked_defaults.position > 1;

CREATE UNIQUE INDEX "telegram_bots_single_default_idx"
ON "telegram_bots" ("is_default")
WHERE "is_default" = true;
