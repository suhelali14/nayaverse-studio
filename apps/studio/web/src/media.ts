import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type EncodedPacket,
  type InputVideoTrack,
} from 'mediabunny';
import type { Codec, CodecHost, Frame } from '../../src/web/decoder.js';
import { indexTrack, type Sample, type TrackIndex } from '../../src/web/seek.js';

/**
 * An uploaded file, as a track index and a hardware decoder.
 *
 * ── The only file in the editor that knows about a container ──────────
 *
 * WebCodecs decodes and encodes; it does not demux. That surprises
 * everyone who starts here, and it is the reason a container library is a
 * hard requirement rather than a convenience. `mediabunny` covers both
 * demuxing an upload and muxing an export, which is one dependency where
 * the usual arrangement is two.
 *
 * Everything above this file speaks in `Sample`s and `TrackIndex`es, so
 * swapping the container library -- or adding WebM, or MOV from a camera --
 * is a change here and nowhere else.
 */

/** Microseconds, which is WebCodecs's unit. mediabunny speaks seconds. */
const toUs = (seconds: number): number => Math.round(seconds * 1_000_000);

export interface LoadedSource {
  readonly index: TrackIndex;
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly host: CodecHost<VideoFrame>;
  readonly codecString: string;
  close(): void;
}

/**
 * Read a file's packet table without reading the file.
 *
 * `metadataOnly` is the whole point: an index built from real packet data
 * would mean pulling a 300MB upload across before the first frame could be
 * shown. Timestamps and key flags are in the container's own tables.
 *
 * `verifyKeyPackets` is on deliberately. A container can claim a packet is
 * a key frame when the bitstream disagrees, and Chromium's decoder is
 * strict about what counts -- it rejects non-IDR AVC frames that the file
 * labelled as keys. Trusting the label means a decoder error on a seek
 * that looked perfectly legal.
 */
export async function loadSource(file: File | Blob): Promise<LoadedSource> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('That file has no video track this browser can read.');

  const codecString = (await track.getCodecParameterString()) ?? '';
  const config = await track.getDecoderConfig();
  if (!config) {
    throw new Error(
      'That file’s codec is not one this browser can decode. ' +
        'An H.264 mp4 from a phone is the safe case.',
    );
  }
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(
      `This browser cannot decode ${codecString || 'that codec'}. ` +
        'Chrome or Edge on the desktop is the widest support today.',
    );
  }

  const sink = new EncodedPacketSink(track);
  const samples: Sample[] = [];
  // Decode order, which is what a decoder must be fed in, and what
  // `indexTrack` assumes when it groups GOPs.
  let i = 0;
  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
    verifyKeyPackets: true,
  })) {
    samples.push({
      index: i,
      timestampUs: toUs(packet.timestamp),
      durationUs: toUs(packet.duration),
      isKey: packet.type === 'key',
    });
    i += 1;
  }
  if (samples.length === 0) throw new Error('That video track has no frames.');

  const index = indexTrack(samples);
  const host = new MediabunnyHost(index, sink, config, track);
  return {
    index,
    width: track.displayWidth,
    height: track.displayHeight,
    seconds: await track.computeDuration(),
    host,
    codecString,
    close: () => void input.dispose?.(),
  };
}

/**
 * The bridge between the GOP decoder and a real `VideoDecoder`.
 *
 * Holds the coded bytes for at most the GOP being decoded. Keeping every
 * packet would mean holding the whole upload in memory, which is the thing
 * `metadataOnly` above exists to avoid.
 */
class MediabunnyHost implements CodecHost<VideoFrame> {
  private bytes = new Map<number, EncodedPacket>();

  constructor(
    private readonly index: TrackIndex,
    private readonly sink: EncodedPacketSink,
    private readonly config: VideoDecoderConfig,
    private readonly track: InputVideoTrack,
  ) {}

  open(onFrame: (f: VideoFrame) => void, onError: (e: Error) => void): Codec {
    const decoder = new VideoDecoder({
      output: (frame) => onFrame(frame),
      error: (e) => onError(e instanceof Error ? e : new Error(String(e))),
    });
    decoder.configure(this.config);
    return {
      get decodeQueueSize() {
        return decoder.decodeQueueSize;
      },
      decode: (chunk) => decoder.decode(chunk as EncodedVideoChunk),
      reset: () => decoder.reset(),
      flush: async () => {
        // A flush on a decoder that has already errored rejects. The GOP
        // decoder treats a null frame as "hold the last one", so a throw
        // here would turn a recoverable hiccup into a broken scrub.
        try {
          await decoder.flush();
        } catch {
          /* reported through the error callback instead */
        }
      },
      close: () => {
        try {
          decoder.close();
        } catch {
          /* already closed */
        }
      },
    };
  }

  /** Pull one GOP's real bytes. Awaited before the decoder is fed. */
  async prepare(wanted: readonly number[]): Promise<void> {
    if (wanted.length === 0) return;
    this.bytes.clear();
    const first = this.index.samples[wanted[0]!];
    if (!first) return;
    const startPacket = await this.sink.getPacket(first.timestampUs / 1_000_000);
    if (!startPacket) return;

    const need = new Set(wanted);
    let i = wanted[0]!;
    for await (const packet of this.sink.packets(startPacket)) {
      if (need.has(i)) this.bytes.set(i, packet);
      i += 1;
      if (i > wanted[wanted.length - 1]!) break;
    }
  }

  chunkFor(sample: Sample): EncodedVideoChunk {
    const packet = this.bytes.get(sample.index);
    if (!packet) {
      throw new Error(
        `Sample ${sample.index} was fed to the decoder before its bytes were read.`,
      );
    }
    return new EncodedVideoChunk({
      type: sample.isKey ? 'key' : 'delta',
      timestamp: sample.timestampUs,
      duration: sample.durationUs,
      data: packet.data,
    });
  }

  /** The track, for callers that need its own metadata. */
  get videoTrack(): InputVideoTrack {
    return this.track;
  }
}

/**
 * A still image, as something the painter can draw.
 *
 * Photographs and screenshots are not decoded through WebCodecs -- the
 * browser already has an image decoder, and `ImageBitmap` is the form a
 * canvas draws fastest.
 */
export async function loadStill(
  file: File | Blob,
): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

/** `VideoFrame` satisfies the decoder's frame contract; stated once here. */
export type DecodedVideoFrame = VideoFrame & Frame;
