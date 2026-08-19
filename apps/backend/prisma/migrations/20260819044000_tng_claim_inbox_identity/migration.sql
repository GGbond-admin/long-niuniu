DROP INDEX "tng_claim_inbox_packet_id_tng_name_hash_amount_cents_key";

CREATE UNIQUE INDEX "tng_claim_inbox_packet_id_tng_name_hash_amount_cents_claimed_at_key"
ON "tng_claim_inbox"("packet_id", "tng_name_hash", "amount_cents", "claimed_at");
