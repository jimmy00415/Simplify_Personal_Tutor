export interface NativeWavPlugin {
  start(): Promise<void>;
  stop(): Promise<{ wavBase64: string; sha256: string; sampleRate: number; channels: number }>;
  cancel(): Promise<void>;
}
