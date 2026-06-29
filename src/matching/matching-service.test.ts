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

/** Hydrate a market's YES book with one resting SELL order. */
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
// Tests — Issue #573: Handle partial fills and PARTIALLY_FILLED status
// ---------------------------------------------------------------------------

describe("Partial fill status handling — #573", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRedisSetOrderBook.mockResolvedValue(undefined);
    mockAuditLogMatch.mockResolvedValue(undefined);
    mockSettlementEnqueue.mockResolvedValue(undefined);
  });

  it("taker gets OPEN status when no matching order exists", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    mockPrismaMarketFindMany.mockResolvedValue([{ id: mid }]);
    mockPrismaOrderFindMany.mockResolvedValue([]);
    await matchingService.hydrateAllActiveMarkets();

    let capturedStatus: string | undefined;
    const noMatchTx = {
      order: {
        create: vi
          .fn()
          .mockImplementation(
            (args: { data: { status: string } & Record<string, unknown> }) => {
              capturedStatus = args.data.status;
              return Promise.resolve({
                id: "no-match",
                ...args.data,
                createdAt: new Date(),
              });
            }
          ),
      },
      trade: { upsert: vi.fn() },
      userPosition: { upsert: vi.fn() },
    };
    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof noMatchTx) => Promise<unknown>) => fn(noMatchTx)
    );

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.3, // no asks this low
      quantity: 100,
    });

    expect(capturedStatus).toBe("OPEN");
  });

  it("taker gets FILLED status when fully matched against the resting book", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 100);

    let takerStatus: string | undefined;
    const tx = {
      order: {
        create: vi
          .fn()
          .mockImplementation(
            (args: { data: { status: string } & Record<string, unknown> }) => {
              takerStatus = args.data.status;
              return Promise.resolve({
                id: "taker-id",
                ...args.data,
                createdAt: new Date(),
              });
            }
          ),
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: makerId, quantity: 100, filledQuantity: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      trade: { upsert: vi.fn().mockResolvedValue({}) },
      userPosition: { upsert: vi.fn().mockResolvedValue({}) },
    };
    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)
    );

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100, // exactly matches resting ask qty
    });

    expect(takerStatus).toBe("FILLED");
  });

  it("taker gets PARTIALLY_FILLED when resting ask covers only part of the order", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 30); // only 30 available

    let takerStatus: string | undefined;
    const tx = {
      order: {
        create: vi
          .fn()
          .mockImplementation(
            (args: { data: { status: string } & Record<string, unknown> }) => {
              takerStatus = args.data.status;
              return Promise.resolve({
                id: "taker-id",
                ...args.data,
                createdAt: new Date(),
              });
            }
          ),
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: makerId, quantity: 30, filledQuantity: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      trade: { upsert: vi.fn().mockResolvedValue({}) },
      userPosition: { upsert: vi.fn().mockResolvedValue({}) },
    };
    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)
    );

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100, // wants 100, only 30 match
    });

    expect(takerStatus).toBe("PARTIALLY_FILLED");
  });

  it("maker gets PARTIALLY_FILLED when only part of it is consumed", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 100);

    let makerUpdateArgs: { filledQuantity: number; status: string } | undefined;
    const tx = {
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
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: makerId, quantity: 100, filledQuantity: 0 }),
        update: vi
          .fn()
          .mockImplementation(
            (args: { data: { filledQuantity: number; status: string } }) => {
              makerUpdateArgs = args.data;
              return Promise.resolve({});
            }
          ),
      },
      trade: { upsert: vi.fn().mockResolvedValue({}) },
      userPosition: { upsert: vi.fn().mockResolvedValue({}) },
    };
    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)
    );

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 40, // fills 40 of 100 — maker is partially filled
    });

    expect(makerUpdateArgs?.status).toBe("PARTIALLY_FILLED");
    expect(makerUpdateArgs?.filledQuantity).toBe(40);
  });

  it("maker gets FILLED when fully consumed by the taker", async () => {
    const mid = `mkt-${crypto.randomUUID()}`;
    const makerId = `ord-${crypto.randomUUID()}`;
    await hydrateWithAsk(mid, makerId, 0.5, 100);

    let makerUpdateArgs: { filledQuantity: number; status: string } | undefined;
    const tx = {
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
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: makerId, quantity: 100, filledQuantity: 0 }),
        update: vi
          .fn()
          .mockImplementation(
            (args: { data: { filledQuantity: number; status: string } }) => {
              makerUpdateArgs = args.data;
              return Promise.resolve({});
            }
          ),
      },
      trade: { upsert: vi.fn().mockResolvedValue({}) },
      userPosition: { upsert: vi.fn().mockResolvedValue({}) },
    };
    mockPrismaMarketFindUnique.mockResolvedValue(activeMarket(mid));
    mockPrismaOrderFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)
    );

    await matchingService.placeOrder({
      marketId: mid,
      userAddress: TAKER,
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100, // fully consumes the maker
    });

    expect(makerUpdateArgs?.status).toBe("FILLED");
    expect(makerUpdateArgs?.filledQuantity).toBe(100);
  });
});
