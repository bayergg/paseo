import { once } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";

import { OpenAIRealtimeTranscriptionSession } from "./realtime-transcription-session.js";

interface SessionUpdateTranscription {
  model: string;
  language?: string;
  languages?: string[];
  prompt?: string;
}

interface SessionUpdateEvent {
  type: "session.update";
  session: {
    audio: {
      input: {
        transcription: SessionUpdateTranscription;
      };
    };
  };
}

async function captureTranscriptionConfig(params: {
  model: string;
  language: string;
}): Promise<SessionUpdateTranscription> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("WebSocket server did not bind to a TCP port");
  }
  process.env.OPENAI_REALTIME_URL = `ws://127.0.0.1:${address.port}`;

  let resolveUpdate: (update: SessionUpdateEvent) => void;
  const updateReceived = new Promise<SessionUpdateEvent>((resolve) => {
    resolveUpdate = resolve;
  });
  server.once("connection", (socket) => {
    socket.once("message", (data) => {
      resolveUpdate(JSON.parse(data.toString()) as SessionUpdateEvent);
      socket.send(JSON.stringify({ type: "session.updated" }));
    });
  });

  const session = new OpenAIRealtimeTranscriptionSession({
    apiKey: "sk-test",
    logger: pino({ level: "silent" }),
    transcriptionModel: params.model,
    language: params.language,
    turnDetection: null,
  });

  try {
    await session.connect();
    const update = await updateReceived;
    return update.session.audio.input.transcription;
  } finally {
    session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

describe("OpenAI realtime transcription session", () => {
  let realtimeUrl: string | undefined;

  beforeEach(() => {
    realtimeUrl = process.env.OPENAI_REALTIME_URL;
  });

  afterEach(() => {
    if (realtimeUrl === undefined) {
      delete process.env.OPENAI_REALTIME_URL;
    } else {
      process.env.OPENAI_REALTIME_URL = realtimeUrl;
    }
  });

  test("sends the languages array to gpt-transcribe", async () => {
    const transcription = await captureTranscriptionConfig({
      model: "gpt-transcribe",
      language: "en",
    });

    expect(transcription).toEqual({ model: "gpt-transcribe", languages: ["en"] });
  });

  test("sends the legacy language field to gpt-4o-transcribe", async () => {
    const transcription = await captureTranscriptionConfig({
      model: "gpt-4o-transcribe",
      language: "en",
    });

    expect(transcription).toEqual({ model: "gpt-4o-transcribe", language: "en" });
  });
});
