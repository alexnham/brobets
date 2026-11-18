CREATE TABLE "PurchaseDraft" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "cluster" TEXT NOT NULL DEFAULT 'devnet',
    "mint" TEXT NOT NULL,
    "quantity" DECIMAL(20,0) NOT NULL,
    "backing" DECIMAL(20,0) NOT NULL,
    "premium" DECIMAL(20,0) NOT NULL,
    "total" DECIMAL(20,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseDraft_nonpayable" CHECK ("status" = 'DRAFT' AND "cluster" = 'devnet'),
    CONSTRAINT "PurchaseDraft_quote" CHECK (
        "quantity" > 0 AND "backing" = "quantity"
        AND "premium" = CEIL("quantity" / 10)
        AND "total" = "backing" + "premium"
        AND "total" <= 18446744073709551615
    )
);
CREATE UNIQUE INDEX "PurchaseDraft_wallet_requestId_key" ON "PurchaseDraft"("wallet", "requestId");
CREATE INDEX "PurchaseDraft_wallet_createdAt_id_idx" ON "PurchaseDraft"("wallet", "createdAt", "id");
