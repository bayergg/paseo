import type pino from "pino";
import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { pcm16lePeakAbs } from "../../audio.js";
import type { StreamingTranscriptionSession } from "../../speech-provider.js";

const WHISPER_SILENCE_PEAK_THRESHOLD = 300;
const WHISPER_SILENCE_FRAME_MS = 20;
const WHISPER_MAX_CONSECUTIVE_SILENCE_MS = 500;

type OpenAITurnDetection =
  | null
  | {
      type: "server_vad";
      create_response?: boolean;
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    }
  | {
      type: "semantic_vad";
      create_response?: boolean;
      eagerness?: "low" | "medium" | "high";
    };

interface OpenAIInputTranscription {
  model: string;
  language?: string;
  languages?: string[];
  prompt?: string;
}

type OpenAIClientEvent =
  | {
      type: "session.update";
      session: {
        type: "transcription";
        audio: {
          input: {
            format: { type: "audio/pcm"; rate: 24000 };
            transcription: OpenAIInputTranscription;
            turn_detection: OpenAITurnDetection;
          };
        };
      };
    }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" };

type OpenAIServerEvent =
  | { type: "session.created" | "session.updated" }
  | {
      type: "input_audio_buffer.committed";
      item_id: string;
      previous_item_id: string | null;
    }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | {
      type: "conversation.item.input_audio_transcription.delta";
      item_id: string;
      delta: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      item_id: string;
      transcript: string;
    }
  | { type: "error"; error?: { message?: string } };

export class OpenAIRealtimeTranscriptionSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  public readonly requiredSampleRate = 24000;
  private readonly apiKey: string;
  private readonly logger: pino.Logger;
  private readonly transcriptionModel: string;
  private readonly language?: string;
  private readonly prompt?: string;
  private readonly turnDetection: OpenAITurnDetection;

  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private closing = false;
  private partialByItemId = new Map<string, string>();
  private whisperPendingSilence: Buffer = Buffer.alloc(0);
  private whisperFrameRemainder: Buffer = Buffer.alloc(0);
  private whisperHasSpeech = false;

  constructor(params: {
    apiKey: string;
    logger: pino.Logger;
    transcriptionModel: string;
    language?: string;
    prompt?: string;
    turnDetection?: OpenAITurnDetection;
  }) {
    super();
    this.apiKey = params.apiKey;
    this.logger = params.logger.child({ provider: "openai", component: "realtime-transcription" });
    this.transcriptionModel = params.transcriptionModel;
    this.language = params.language;
    this.prompt = params.prompt;
    this.turnDetection = params.turnDetection ?? null;
  }

  public async connect(): Promise<void> {
    if (this.ready) {
      return this.ready;
    }

    this.closing = false;
    this.ready = new Promise<void>((resolve, reject) => {
      const url =
        process.env.OPENAI_REALTIME_URL ?? "wss://api.openai.com/v1/realtime?intent=transcription";
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.ws = ws;

      let resolved = false;

      const fail = (error: Error) => {
        if (resolved) {
          this.emit("error", error);
          return;
        }
        resolved = true;
        reject(error);
      };

      ws.on("open", () => {
        this.logger.debug("OpenAI realtime transcription websocket connected");
        const transcription: OpenAIInputTranscription = {
          model: this.transcriptionModel,
          ...(this.prompt ? { prompt: this.prompt } : {}),
        };
        if (this.language) {
          if (this.transcriptionModel === "gpt-transcribe") {
            transcription.languages = [this.language];
          } else {
            transcription.language = this.language;
          }
        }
        const update: OpenAIClientEvent = {
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription,
                turn_detection: this.turnDetection,
              },
            },
          },
        };
        ws.send(JSON.stringify(update));
      });

      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf-8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        const event = parsed as OpenAIServerEvent;
        if (event.type === "session.created" || event.type === "session.updated") {
          if (!resolved) {
            resolved = true;
            resolve();
          }
          return;
        }

        if (event.type === "input_audio_buffer.committed") {
          this.emit("committed", {
            segmentId: event.item_id,
            previousSegmentId: event.previous_item_id,
          });
          return;
        }

        if (event.type === "input_audio_buffer.speech_started") {
          this.emit("speech_started");
          return;
        }

        if (event.type === "input_audio_buffer.speech_stopped") {
          this.emit("speech_stopped");
          return;
        }

        if (event.type === "conversation.item.input_audio_transcription.delta") {
          const replaceDelta = this.transcriptionModel === "whisper-1";
          const prev = this.partialByItemId.get(event.item_id) ?? "";
          const next = replaceDelta ? event.delta : prev + event.delta;
          this.partialByItemId.set(event.item_id, next);
          this.emit("transcript", { segmentId: event.item_id, transcript: next, isFinal: false });
          return;
        }

        if (event.type === "conversation.item.input_audio_transcription.completed") {
          this.partialByItemId.set(event.item_id, event.transcript);
          this.emit("transcript", {
            segmentId: event.item_id,
            transcript: event.transcript,
            isFinal: true,
          });
          return;
        }

        if (event.type === "error") {
          const message = event.error?.message ?? "OpenAI realtime error";
          fail(new Error(message));
        }
      });

      ws.on("error", (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on("close", () => {
        this.logger.debug("OpenAI realtime websocket closed");
        if (this.closing) {
          return;
        }
        if (!resolved) {
          fail(new Error("OpenAI realtime websocket closed before ready"));
          return;
        }
        fail(new Error("OpenAI realtime websocket closed"));
      });
    });

    return this.ready;
  }

  public appendPcm16(pcm16le: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime websocket not connected");
    }
    if (this.transcriptionModel === "whisper-1") {
      this.appendWhisperPcm16(pcm16le);
      return;
    }

    this.sendPcm16(pcm16le);
  }

  public commit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime websocket not connected");
    }
    if (this.transcriptionModel === "whisper-1") {
      const audio: Buffer[] = [];
      if (this.whisperFrameRemainder.length > 0) {
        this.filterWhisperFrame(this.whisperFrameRemainder, audio);
      }
      if (this.whisperHasSpeech && this.whisperPendingSilence.length > 0) {
        audio.push(this.whisperPendingSilence);
      }
      if (audio.length > 0) {
        this.sendPcm16(Buffer.concat(audio));
      }
    }
    this.resetWhisperSilenceFilter();
    const event: OpenAIClientEvent = { type: "input_audio_buffer.commit" };
    this.ws.send(JSON.stringify(event));
  }

  public clear(): void {
    this.resetWhisperSilenceFilter();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const event: OpenAIClientEvent = { type: "input_audio_buffer.clear" };
    this.ws.send(JSON.stringify(event));
  }

  public close(): void {
    try {
      this.closing = true;
      this.resetWhisperSilenceFilter();
      this.ws?.close();
    } catch {
      // no-op
    } finally {
      this.ws = null;
      this.ready = null;
    }
  }

  private sendPcm16(pcm16le: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime websocket not connected");
    }
    const event: OpenAIClientEvent = {
      type: "input_audio_buffer.append",
      audio: pcm16le.toString("base64"),
    };
    this.ws.send(JSON.stringify(event));
  }

  private appendWhisperPcm16(pcm16le: Buffer): void {
    const frameBytes = Math.round(this.requiredSampleRate * 2 * (WHISPER_SILENCE_FRAME_MS / 1000));
    const input =
      this.whisperFrameRemainder.length > 0
        ? Buffer.concat([this.whisperFrameRemainder, pcm16le])
        : pcm16le;
    const audio: Buffer[] = [];
    let offset = 0;
    while (input.length - offset >= frameBytes) {
      this.filterWhisperFrame(input.subarray(offset, offset + frameBytes), audio);
      offset += frameBytes;
    }
    this.whisperFrameRemainder = input.subarray(offset);
    if (audio.length > 0) {
      this.sendPcm16(Buffer.concat(audio));
    }
  }

  private filterWhisperFrame(frame: Buffer, audio: Buffer[]): void {
    if (pcm16lePeakAbs(frame) < WHISPER_SILENCE_PEAK_THRESHOLD) {
      const maxSilenceBytes = Math.round(
        this.requiredSampleRate * 2 * (WHISPER_MAX_CONSECUTIVE_SILENCE_MS / 1000),
      );
      const silence = Buffer.concat([this.whisperPendingSilence, frame]);
      this.whisperPendingSilence = silence.subarray(Math.max(0, silence.length - maxSilenceBytes));
      return;
    }

    if (this.whisperPendingSilence.length > 0) {
      audio.push(this.whisperPendingSilence);
      this.whisperPendingSilence = Buffer.alloc(0);
    }
    this.whisperHasSpeech = true;
    audio.push(frame);
  }

  private resetWhisperSilenceFilter(): void {
    this.whisperPendingSilence = Buffer.alloc(0);
    this.whisperFrameRemainder = Buffer.alloc(0);
    this.whisperHasSpeech = false;
  }
}
