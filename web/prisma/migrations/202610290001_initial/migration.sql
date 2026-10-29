-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "tokenHash" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sideA" TEXT NOT NULL,
    "sideB" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "resolveBy" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminWallet" TEXT NOT NULL,
    "chainAddress" TEXT,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionReference" (
    "signature" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionReference_pkey" PRIMARY KEY ("signature")
);

-- CreateIndex
CREATE UNIQUE INDEX "Question_chainAddress_key" ON "Question"("chainAddress");

-- AddForeignKey
ALTER TABLE "TransactionReference" ADD CONSTRAINT "TransactionReference_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

