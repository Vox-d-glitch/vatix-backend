import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockPrismaOrderFindMany,
  mockPrismaMarketFindMany,
  mockPrismaMarketFindUnique,
  mockPrismaTransaction,
  mockRedisSetOrderBook,
  mockAuditLogMatch,
  mockSettlementEnqueue,
} = vi.hoisted(() => ({
  mockPrismaOrderFindMany: vi.fn(),
  mockPrismaMarketFindMany: vi.fn(),
  mockPrismaMarketFindUnique: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockRedisSetOrderBook: vi.fn().mockResolvedValue(undefined),
  mockAuditLogMatch: vi.fn().mockResolvedValue(undefined),
  mockSettlementEnqueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/prisma.js", () => ({
  getPrismaClient: () => ({
    market: {
      findMany: mockPrismaMarketFindMany,
      findUnique: mockPrismaMarketFindUnique,
    },
    order: { findMany: mockPrismaOrderFindMany },
    $transaction: mockPrismaTransaction,
  }),
}));

vi.mock("../services/redis.js", () => ({
  redis: { setOrderBook: mockRedisSetOrderBook },
}));

vi.mock("../services/audit.js", () => ({
  auditService: { logOrderMatch: mockAuditLogMatch },
}));

vi.mock("../services/settlement-queue.js", () => ({
  settlementQueue: { enqueue: mockSettlementEnqueue },
}));

import { matchingService } from "./matching-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAKER = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const MAKER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function activeMarket(id: string) {
  return { id, status: "ACTIVE", endTime: new Date(Date.now() + 86_400_000) };
}

function makeTx(makerId: string, makerQty: number, makerFilled: number) {
  return {
    order: {
      create: vi
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: "taker-id",
            ...args.data,
            createdAt: new Date(),
          })
        ),
      findUnique: vi.fn().mockResolvedValue({
        id: makerId,
        quantity: makerQty,
        filledQuantity: makerFilled,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    trade: { upsert: vi.fn().mockResolvedValue({}) },
    userPosition: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

/** Hydrate a market's book with one resting order then set up placeOrder mocks. */
async function setup(
  mid: string,
  makerId: string,
  side: "BUY" | "SELL",
  outcome: "YES" | "NO",
  price: number,
  quantity: number
) {
  mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
  mockPrismaOrderFindMany.mockImplementation(
    ({ where }: { where: { outcome: string; marketId: string } }) => {
      if (where.outcome === outcome && where.marketId === mid) {
        return Promise.resolve([
          {
            id: makerId,
            userAddress: MAKER,
            side,
            outcome,
            price: price.toString(),
            quantity,
            filledQuantity: 0,
            createdAt: new Date(1000),
          },
        ]);
      }
      return Promise.resolve([]);
    }
  );
  await matchingService.hydrateAllActiveMarkets();

  mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
  mockPrismaOrderFindMany.mockResolvedValue([]);

  const tx = makeTx(makerId, quantity, 0);
  mockPrismaTransaction.mockImplementation(
    async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(tx)
  );
  return tx;
}

// ---------------------------------------------------------------------------
// Tests — Issue #572: Apply positionDeltas to UserPosition in match txn
// ---------------------------------------------------------------------------

describe("positionDeltas applied inside match transaction — #572", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRedisSetOrderBook.mockResolvedValue(undefined);
    mockAuditLogMatch.mockResolvedValue(undefined);
    mockSettlementEnqueue.mockResolvedValue(undefined);
  });

  it("YES trade: buyer receives +yesShares, seller receives −yesShares", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    const qty = 50;
    const tx = await setup(mid, makerId, "SELL", "YES", 0.5, 100);

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: qty,
    });

    expect(tx.userPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_userAddress: { marketId: mid, userAddress: TAKER } },
        create: expect.objectContaining({ yesShares: qty }),
        update: expect.objectContaining({ yesShares: { increment: qty } }),
      })
    );
    expect(tx.userPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_userAddress: { marketId: mid, userAddress: MAKER } },
        create: expect.objectContaining({ yesShares: -qty }),
        update: expect.objectContaining({ yesShares: { increment: -qty } }),
      })
    );
  });

  it("NO trade: buyer receives +noShares, seller receives −noShares", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    const qty = 40;
    const tx = await setup(mid, makerId, "SELL", "NO", 0.4, 100);

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "NO",
      price: 0.4,
      quantity: qty,
    });

    expect(tx.userPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_userAddress: { marketId: mid, userAddress: TAKER } },
        create: expect.objectContaining({ noShares: qty }),
        update: expect.objectContaining({ noShares: { increment: qty } }),
      })
    );
    expect(tx.userPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_userAddress: { marketId: mid, userAddress: MAKER } },
        create: expect.objectContaining({ noShares: -qty }),
        update: expect.objectContaining({ noShares: { increment: -qty } }),
      })
    );
  });

  it("upsert is called for both buyer and seller when a trade occurs", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    const tx = await setup(mid, makerId, "SELL", "YES", 0.5, 100);

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    });

    expect(tx.userPosition.upsert).toHaveBeenCalledTimes(2);
  });

  it("no position upserts when no trade occurs", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
    mockPrismaOrderFindMany.mockResolvedValue([]);
    await matchingService.hydrateAllActiveMarkets();

    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    const emptyTx = {
      order: {
        create: vi
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: "no-trade",
              ...args.data,
              createdAt: new Date(),
            })
          ),
      },
      trade: { upsert: vi.fn() },
      userPosition: { upsert: vi.fn() },
    };
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof emptyTx) => Promise<unknown>) => fn(emptyTx)
    );

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    });

    expect(emptyTx.userPosition.upsert).not.toHaveBeenCalled();
  });

  it("lockedCollateral: buyer pays price*qty, seller receives it", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    const price = 0.6;
    const qty = 50;
    const cost = price * qty; // 30
    const tx = await setup(mid, makerId, "SELL", "YES", price, 100);

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price,
      quantity: qty,
    });

    expect(tx.userPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_userAddress: { marketId: mid, userAddress: TAKER } },
        create: expect.objectContaining({ lockedCollateral: cost }),
        update: expect.objectContaining({
          lockedCollateral: { increment: cost },
        }),
      })
    );
    expect(tx.userPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_userAddress: { marketId: mid, userAddress: MAKER } },
        create: expect.objectContaining({ lockedCollateral: -cost }),
        update: expect.objectContaining({
          lockedCollateral: { increment: -cost },
        }),
      })
    );
  });
});
