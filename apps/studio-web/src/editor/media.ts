import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import type { Codec, CodecHost, Frame } from '../../../studio/src/web/decoder.js';
import { indexTrack, type Sample, type TrackIndex } from '../../../studio/src/web/seek.js';

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

/**
 * A decoded picture, copied out of the decoder's own frame pool.
 *
 * The decoder hands out `VideoFrame`s from a small pool -- eight on the
 * hardware decoder this was found on -- and stops producing once they are
 * all held. The GOP decoder holds a whole GOP until `flush()` resolves, and
 * a phone GOP is thirty to sixty frames, so holding `VideoFrame`s meant
 * eight frames came out, `flush()` never resolved and the preview froze on
 * the first scrub into any real video. Each frame is therefore copied to an
 * `ImageBitmap` at preview size and the `VideoFrame` closed at once.
 */
export interface PreviewFrame extends Frame {
  readonly image: ImageBitmap;
}

/**
 * The longest edge a preview frame is kept at. The monitor shows a 9:16
 * frame a few hundred pixels tall, and a 120-frame scrub cache of
 * 1080x1920 bitmaps would be close to a gigabyte of GPU memory; at 1280
 * it is under half that.
 */
const PREVIEW_EDGE = 1280;

export interface LoadedSource {
  readonly index: TrackIndex;
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly host: CodecHost<PreviewFrame>;
  readonly codecString: string;
  /** The tracks themselves, for the export: full-resolution frames and sound. */
  readonly track: InputVideoTrack;
  readonly audio: InputAudioTrack | null;
  close(): void;
}

/**
 * Read a file's packet table without reading the file.
 *
 * `metadataOnly` is the whole point: an index built from real packet data
 * would mean pulling a 300MB upload across before the first frame could be
 * shown. Timestamps and key flags are in the container's own tables.
 *
 * The key flags are then checked against the bitstream. A container can
 * claim a packet is a key frame when the bitstream disagrees, and
 * Chromium's decoder is strict about what counts -- it rejects non-IDR AVC
 * frames that the file labelled as keys. Trusting the label means a decoder
 * error on a seek that looked perfectly legal.
 *
 * That check cannot ride along with the metadata pass: mediabunny refuses
 * `verifyKeyPackets` together with `metadataOnly`, because verifying means
 * reading the packet's bytes. Asking for both made every video import fail
 * with that refusal. So the index is read metadata-only, and then only the
 * packets claimed as keys -- about one a second -- are read and verified.
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
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    samples.push({
      index: i,
      timestampUs: toUs(packet.timestamp),
      durationUs: toUs(packet.duration),
      isKey: packet.type === 'key',
    });
    i += 1;
  }
  if (samples.length === 0) throw new Error('That video track has no frames.');

  // Read only the claimed keys, and keep the claim where the bitstream
  // cannot say (`null`): demoting a real key would make its whole GOP
  // unreachable, which is worse than the decoder error it guards against.
  for (let k = 0; k < samples.length; k += 1) {
    const sample = samples[k]!;
    if (!sample.isKey) continue;
    const packet = await sink.getPacket(sample.timestampUs / 1_000_000);
    if (!packet || toUs(packet.timestamp) !== sample.timestampUs) continue;
    const actual = await track.determinePacketType(packet);
    if (actual === 'delta') samples[k] = { ...sample, isKey: false };
  }
  if (!samples.some((s) => s.isKey)) {
    throw new Error('That video has no frame the browser can start decoding from.');
  }

  const index = indexTrack(samples);
  const host = new MediabunnyHost(index, sink, config, track);
  return {
    index,
    width: track.displayWidth,
    height: track.displayHeight,
    seconds: await track.computeDuration(),
    host,
    codecString,
    track,
    audio: await input.getPrimaryAudioTrack(),
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
class MediabunnyHost implements CodecHost<PreviewFrame> {
  private bytes = new Map<number, EncodedPacket>();

  constructor(
    private readonly index: TrackIndex,
    private readonly sink: EncodedPacketSink,
    private readonly config: VideoDecoderConfig,
    private readonly track: InputVideoTrack,
  ) {}

  open(onFrame: (f: PreviewFrame) => void, onError: (e: Error) => void): Codec {
    // Copies in flight. `flush` waits for them too, or the GOP decoder
    // would harvest before the last frames of the GOP had arrived.
    const copying = new Set<Promise<void>>();
    // Bumped by reset and close: a copy that finishes after either belongs
    // to work that was thrown away, and is closed instead of delivered.
    let epoch = 0;

    const decoder = new VideoDecoder({
      output: (frame) => {
        const mine = epoch;
        const timestamp = frame.timestamp;
        const scale = Math.min(1, PREVIEW_EDGE / Math.max(frame.displayWidth, frame.displayHeight));
        const copy = createImageBitmap(frame, {
          resizeWidth: Math.max(1, Math.round(frame.displayWidth * scale)),
          resizeHeight: Math.max(1, Math.round(frame.displayHeight * scale)),
          resizeQuality: 'medium',
        })
          .then((image) => {
            if (mine !== epoch) {
              image.close();
              return;
            }
            onFrame({ timestamp, image, close: () => image.close() });
          })
          .catch((e: unknown) => onError(e instanceof Error ? e : new Error(String(e))))
          .finally(() => {
            // Back to the decoder's pool, which is what lets it keep going.
            frame.close();
            copying.delete(copy);
          });
        copying.add(copy);
      },
      error: (e) => onError(e instanceof Error ? e : new Error(String(e))),
    });
    decoder.configure(this.config);
    return {
      get decodeQueueSize() {
        return decoder.decodeQueueSize;
      },
      decode: (chunk) => decoder.decode(chunk as EncodedVideoChunk),
      reset: () => {
        epoch += 1;
        decoder.reset();
      },
      flush: async () => {
        // A flush on a decoder that has already errored rejects. The GOP
        // decoder treats a null frame as "hold the last one", so a throw
        // here would turn a recoverable hiccup into a broken scrub.
        try {
          await decoder.flush();
        } catch {
          /* reported through the error callback instead */
        }
        await Promise.all([...copying]);
      },
      close: () => {
        epoch += 1;
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

