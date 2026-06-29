import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before module imports so vi.mock() factories can
// capture the same references.
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

import {
  matchingService,
  getHydratedMarketsCount,
} from "./matching-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAKER = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const MAKER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function activeMarket(id: string) {
  return { id, status: "ACTIVE", endTime: new Date(Date.now() + 86_400_000) };
}

/** Build a mock $transaction inner context (tx) for a single-trade scenario. */
function makeTx(
  takerId: string,
  makerId: string,
  makerQty: number,
  makerFilled: number
) {
  return {
    order: {
      create: vi
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: takerId, ...args.data, createdAt: new Date() })
        ),
      findUnique: vi
        .fn()
        .mockResolvedValue({
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

// ---------------------------------------------------------------------------
// Tests — Issue #570: Hydrate OrderBook from OPEN orders on cold start
// ---------------------------------------------------------------------------

describe("hydrateAllActiveMarkets() — cold-start OrderBook hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Ensure fire-and-forget mocks return promises so .catch() doesn't throw
    mockRedisSetOrderBook.mockResolvedValue(undefined);
    mockAuditLogMatch.mockResolvedValue(undefined);
    mockSettlementEnqueue.mockResolvedValue(undefined);
  });

  it("is a no-op when WARM_MARKETS_ON_STARTUP=false", async () => {
    vi.stubEnv("WARM_MARKETS_ON_STARTUP", "false");

    await matchingService.hydrateAllActiveMarkets();

    expect(mockPrismaMarketFindMany).not.toHaveBeenCalled();
    expect(mockPrismaOrderFindMany).not.toHaveBeenCalled();
  });

  it("queries active markets on normal startup", async () => {
    mockPrismaMarketFindMany.mockResolvedValue([]);

    await matchingService.hydrateAllActiveMarkets();

    expect(mockPrismaMarketFindMany).toHaveBeenCalledWith({
      where: { status: "ACTIVE" },
      select: { id: true },
    });
  });

  it("queries OPEN and PARTIALLY_FILLED orders for every market+outcome pair", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
    mockPrismaOrderFindMany.mockResolvedValue([]);

    await matchingService.hydrateAllActiveMarkets();

    for (const outcome of ["YES", "NO"]) {
      expect(mockPrismaOrderFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            marketId: mid,
            outcome,
            status: { in: ["OPEN", "PARTIALLY_FILLED"] },
          }),
        })
      );
    }
  });

  it("getHydratedMarketsCount() reflects the number of active markets loaded", async () => {
    mockPrismaMarketFindMany.mockResolvedValue([
      { id: "m1" },
      { id: "m2" },
      { id: "m3" },
    ]);
    mockPrismaOrderFindMany.mockResolvedValue([]);

    await matchingService.hydrateAllActiveMarkets();

    expect(getHydratedMarketsCount()).toBe(3);
  });

  it("OPEN orders are placed in the book and available for matching", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;

    mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
    mockPrismaOrderFindMany.mockImplementation(
      ({ where }: { where: { outcome: string; marketId: string } }) => {
        if (where.outcome === "YES" && where.marketId === mid) {
          return Promise.resolve([
            {
              id: makerId,
              userAddress: MAKER,
              side: "SELL",
              outcome: "YES",
              price: "0.5",
              quantity: 100,
              filledQuantity: 0,
              createdAt: new Date(1000),
            },
          ]);
        }
        return Promise.resolve([]);
      }
    );

    await matchingService.hydrateAllActiveMarkets();

    // Now set up placeOrder infrastructure (book is already hydrated)
    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx("taker-1", makerId, 100, 0))
    );

    const result = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.filledQuantity).toBe(50);
  });

  it("PARTIALLY_FILLED orders enter the book with remaining quantity only", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    // quantity=100, filledQuantity=70 → 30 remaining in the book

    mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
    mockPrismaOrderFindMany.mockImplementation(
      ({ where }: { where: { outcome: string; marketId: string } }) => {
        if (where.outcome === "YES" && where.marketId === mid) {
          return Promise.resolve([
            {
              id: makerId,
              userAddress: MAKER,
              side: "SELL",
              outcome: "YES",
              price: "0.5",
              quantity: 100,
              filledQuantity: 70,
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
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx("taker-2", makerId, 100, 70))
    );

    // Try to buy 40 — only 30 remain in the hydrated book
    const result = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 40,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(30); // capped to remaining
    expect(result.filledQuantity).toBe(30);
  });
});
