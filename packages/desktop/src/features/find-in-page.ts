import { ipcMain } from "electron";

interface FindInPageRequest {
  query: string;
  forward: boolean;
  findNext: boolean;
}

function parseFindInPageRequest(input: unknown): FindInPageRequest {
  if (
    typeof input !== "object" ||
    input === null ||
    !("query" in input) ||
    !("forward" in input) ||
    !("findNext" in input) ||
    typeof input.query !== "string" ||
    typeof input.forward !== "boolean" ||
    typeof input.findNext !== "boolean"
  ) {
    throw new TypeError("Invalid find in page request");
  }
  return {
    query: input.query,
    forward: input.forward,
    findNext: input.findNext,
  };
}

export function registerFindInPageHandlers(): void {
  const latestRequestBySender = new Map<number, number>();
  const listeningSenders = new Set<number>();

  ipcMain.handle("paseo:find-in-page:find", (event, input: unknown) => {
    const request = parseFindInPageRequest(input);
    const sender = event.sender;

    if (!listeningSenders.has(sender.id)) {
      listeningSenders.add(sender.id);
      sender.on("found-in-page", (_event, result) => {
        if (latestRequestBySender.get(sender.id) === result.requestId) {
          sender.send("paseo:event:find-in-page-result", result);
        }
      });
      sender.once("destroyed", () => {
        latestRequestBySender.delete(sender.id);
        listeningSenders.delete(sender.id);
      });
    }

    const requestId = sender.findInPage(request.query, {
      forward: request.forward,
      findNext: request.findNext,
    });
    latestRequestBySender.set(sender.id, requestId);
    return requestId;
  });

  ipcMain.handle("paseo:find-in-page:stop", (event) => {
    latestRequestBySender.delete(event.sender.id);
    event.sender.stopFindInPage("clearSelection");
  });
}
