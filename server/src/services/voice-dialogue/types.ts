export interface AudioBuffer {
  data: Buffer;
  format: "mp3" | "wav" | "pcm" | "ogg";
  sampleRate?: number;
  channels?: number;
}

export interface ASRResult {
  text: string;
  confidence: number;
  language?: string;
  isFinal: boolean;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DialogueContext {
  sessionId: string;
  userId: string;
  conversationHistory: LLMMessage[];
  metadata: Record<string, unknown>;
}

export interface ASRProvider {
  name: string;

  transcribe(audio: AudioBuffer, options?: {
    language?: string;
    enablePunctuation?: boolean;
  }): Promise<ASRResult>;

  startStreamingTranscribe?(options?: {
    language?: string;
    onPartialResult?: (result: ASRResult) => void;
    onFinalResult?: (result: ASRResult) => void;
    onError?: (error: Error) => void;
  }): Promise<() => void>;
}

export interface TTSProvider {
  name: string;

  synthesize(text: string, options?: {
    voiceId?: string;
    speed?: number;
    pitch?: number;
    volume?: number;
  }): Promise<AudioBuffer>;

  getAvailableVoices?(): Promise<Array<{
    id: string;
    name: string;
    language: string;
    gender: "male" | "female" | "neutral";
  }>>;
}

export interface LLMProvider {
  name: string;

  chat(messages: LLMMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  }): Promise<string>;

  chatStream?(messages: LLMMessage[], options?: {
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    onToken?: (token: string) => void;
  }): Promise<string>;
}

export interface VoiceDialogueProvider {
  asr: ASRProvider;
  tts: TTSProvider;
  llm: LLMProvider;
}
