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

/** Hydrate a market's YES book with a single resting SELL order. */
async function hydrateWithAsk(
  mid: string,
  makerId: string,
  price: number,
  quantity: number
) {
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
}

// ---------------------------------------------------------------------------
// Tests — Issue #571: Invoke matchOrder after order create in POST /orders
// ---------------------------------------------------------------------------

describe("placeOrder() invokes the matching engine — #571", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRedisSetOrderBook.mockResolvedValue(undefined);
    mockAuditLogMatch.mockResolvedValue(undefined);
    mockSettlementEnqueue.mockResolvedValue(undefined);
  });

  it("returns empty trades when the book has no matching orders", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
    mockPrismaOrderFindMany.mockResolvedValue([]);
    await matchingService.hydrateAllActiveMarkets();

    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    const noMatchTx = {
      order: {
        create: vi
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: "no-match",
              ...args.data,
              createdAt: new Date(),
            })
          ),
      },
      trade: { upsert: vi.fn() },
      userPosition: { upsert: vi.fn() },
    };
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof noMatchTx) => Promise<unknown>) => fn(noMatchTx)
    );

    const result = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    });

    expect(result.trades).toHaveLength(0);
    expect(result.filledQuantity).toBe(0);
  });

  it("executes matchOrder and returns one trade when a crossing order exists", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 100);

    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx("taker-id", makerId, 100, 0))
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

  it("trade has correct marketId, outcome, price, quantity and counterparty addresses", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.6, 50);

    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx("taker-id", makerId, 50, 0))
    );

    const result = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.6,
      quantity: 50,
    });

    const trade = result.trades[0];
    expect(trade.marketId).toBe(mid);
    expect(trade.outcome).toBe("YES");
    expect(trade.price).toBe(0.6);
    expect(trade.quantity).toBe(50);
    expect(trade.buyerAddress).toBe(TAKER);
    expect(trade.sellerAddress).toBe(MAKER);
  });

  it("a fully matched maker is removed from the book; subsequent orders get no trades", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 50);

    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);

    // First taker fills the resting ask completely
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx("taker-1", makerId, 50, 0))
    );
    const first = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    });
    expect(first.trades).toHaveLength(1);

    // Second taker: book is now empty — no match
    const emptyTx = {
      order: {
        create: vi
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: "taker-2",
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
    const second = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 50,
    });
    expect(second.trades).toHaveLength(0);
  });

  it("partial match: taker filled against maker up to available quantity", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 30); // only 30 available

    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx("taker-id", makerId, 30, 0))
    );

    const result = await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100, // want 100, only 30 available
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(30);
    expect(result.filledQuantity).toBe(30);
  });
});
