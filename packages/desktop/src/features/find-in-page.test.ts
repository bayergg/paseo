import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerFindInPageHandlers } from "./find-in-page";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

interface FakeWebContents {
  id: number;
  findInPage: ReturnType<typeof vi.fn>;
  stopFindInPage: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
  if (typeof handler !== "function") {
    throw new Error(`${channel} handler was not registered`);
  }
  return handler;
}

function createWebContents(): {
  sender: FakeWebContents;
  emitFound: (result: Electron.FoundInPageResult) => void;
} {
  let foundListener: ((event: unknown, result: Electron.FoundInPageResult) => void) | null = null;
  const sender: FakeWebContents = {
    id: 7,
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    send: vi.fn(),
    on: vi.fn((event: string, listener: typeof foundListener) => {
      if (event === "found-in-page") foundListener = listener;
    }),
    once: vi.fn(),
  };
  return {
    sender,
    emitFound: (result) => foundListener?.({}, result),
  };
}

function foundResult(requestId: number): Electron.FoundInPageResult {
  return {
    requestId,
    activeMatchOrdinal: 2,
    matches: 5,
    selectionArea: { x: 0, y: 0, width: 10, height: 10 },
    finalUpdate: true,
  };
}

describe("desktop find in page", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
  });

  it("forwards results only for the latest request", () => {
    registerFindInPageHandlers();
    const find = getHandler("paseo:find-in-page:find");
    const { sender, emitFound } = createWebContents();
    sender.findInPage.mockReturnValueOnce(11).mockReturnValueOnce(12);

    find({ sender }, { query: "alpha", forward: true, findNext: true });
    find({ sender }, { query: "beta", forward: true, findNext: true });
    emitFound(foundResult(11));
    emitFound(foundResult(12));

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith("paseo:event:find-in-page-result", foundResult(12));
  });

  it("continues a search in either direction", () => {
    registerFindInPageHandlers();
    const find = getHandler("paseo:find-in-page:find");
    const { sender } = createWebContents();
    sender.findInPage.mockReturnValue(13);

    find({ sender }, { query: "alpha", forward: false, findNext: false });

    expect(sender.findInPage).toHaveBeenCalledWith("alpha", {
      forward: false,
      findNext: false,
    });
  });

  it("clears the active search", () => {
    registerFindInPageHandlers();
    const stop = getHandler("paseo:find-in-page:stop");
    const { sender } = createWebContents();

    stop({ sender });

    expect(sender.stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });

  it("rejects malformed requests", () => {
    registerFindInPageHandlers();
    const find = getHandler("paseo:find-in-page:find");
    const { sender } = createWebContents();

    expect(() => find({ sender }, { query: 4, forward: true, findNext: true })).toThrow(
      "Invalid find in page request",
    );
    expect(sender.findInPage).not.toHaveBeenCalled();
  });
});
