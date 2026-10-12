-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "saler" TEXT NOT NULL,
    "payId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "location" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "day" TEXT NOT NULL,
    "liters" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "noDispense" BOOLEAN NOT NULL DEFAULT false,
    "payType" TEXT NOT NULL DEFAULT 'qr',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStat" (
    "saler" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "location" TEXT,
    "liters" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "txCount" INTEGER NOT NULL,
    "noDispenseCount" INTEGER NOT NULL,
    "cardCount" INTEGER NOT NULL DEFAULT 0,
    "cashCount" INTEGER NOT NULL DEFAULT 0,
    "qrCount" INTEGER NOT NULL DEFAULT 0,
    "terminalCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("saler","deviceId","day")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "saler" TEXT NOT NULL,
    "appid" TEXT NOT NULL,
    "syncedTo" TIMESTAMP(3),
    "backfilledFrom" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("saler")
);

-- CreateIndex
CREATE INDEX "Transaction_saler_day_deviceId_idx" ON "Transaction"("saler", "day", "deviceId");

-- CreateIndex
CREATE INDEX "Transaction_saler_paidAt_idx" ON "Transaction"("saler", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_saler_payId_key" ON "Transaction"("saler", "payId");

-- CreateIndex
CREATE INDEX "DailyStat_saler_day_idx" ON "DailyStat"("saler", "day");
